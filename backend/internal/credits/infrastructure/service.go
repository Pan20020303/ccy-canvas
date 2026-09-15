package infrastructure

import (
	"context"
	"errors"
	"log"
	"time"

	creditapp "ccy-canvas/backend/internal/credits/application"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/database/sqlctx"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// logLedgerWriteFailure records a swallowed ledger-write error. The balance
// UPDATE is authoritative; a missing ledger row only breaks auditability, so we
// log (never fail the operation) — but no longer silently. Observability only.
func logLedgerWriteFailure(kind string, err error) {
	if err != nil {
		log.Printf("[credits] WARNING ledger write failed (%s) — balance is correct but audit trail is incomplete: %v", kind, err)
	}
}

type Service struct {
	queries *sqlc.Queries
	pool    *pgxpool.Pool
}

func NewService(queries *sqlc.Queries, pool *pgxpool.Pool) Service {
	return Service{queries: queries, pool: pool}
}

func (s Service) CreateInitialAccount(ctx context.Context, userID string, dailyQuota int32, createdBy *string) error {
	queries := s.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}

	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return err
	}

	account, err := queries.CreateCreditAccount(ctx, sqlc.CreateCreditAccountParams{
		UserID:     pgtype.UUID{Bytes: userUUID, Valid: true},
		DailyQuota: dailyQuota,
	})
	if err != nil {
		return err
	}

	var createdByUUID pgtype.UUID
	if createdBy != nil && *createdBy != "" {
		parsed, err := uuid.Parse(*createdBy)
		if err != nil {
			return err
		}
		createdByUUID = pgtype.UUID{Bytes: parsed, Valid: true}
	}

	return queries.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID:       pgtype.UUID{Bytes: userUUID, Valid: true},
		AccountID:    account.ID,
		Type:         "daily_reset",
		Amount:       dailyQuota,
		BalanceAfter: dailyQuota,
		Reason:       "initial account creation",
		CreatedBy:    createdByUUID,
	})
}

// applyDailyReset lazily tops the account back up to its daily_quota floor the
// first time it's touched on a new calendar day (account timezone). It's a
// single atomic UPDATE guarded on last_reset_on, so concurrent callers can't
// double-credit; only the winning row writes a daily_reset ledger entry.
// Silent on any error — a reset hiccup must never block a read or a generation.
func (s Service) applyDailyReset(ctx context.Context, queries *sqlc.Queries, uid pgtype.UUID) {
	acct, err := queries.ApplyDailyResetIfDue(ctx, uid)
	if err != nil {
		return // pgx.ErrNoRows = already reset today; other errors are non-fatal
	}
	logLedgerWriteFailure("daily_reset", queries.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID:       uid,
		AccountID:    acct.ID,
		Type:         "daily_reset",
		Amount:       acct.CurrentBalance,
		BalanceAfter: acct.CurrentBalance,
		Reason:       "每日额度重置",
	}))
}

// Reserve atomically deducts amount from the user's balance at generation
// submit. Returns creditapp.ErrInsufficientCredits when the balance can't
// cover it (guarded UPDATE — safe under concurrent submits, never negative).
func (s Service) Reserve(ctx context.Context, userID, projectID string, amount int32, reason string) (string, error) {
	if amount <= 0 {
		return creditapp.ChargeScopePersonal, nil
	}
	if projectID != "" && s.pool != nil {
		handled, err := s.reserveProject(ctx, userID, projectID, amount, reason)
		if handled {
			return creditapp.ChargeScopeProject, err
		}
	}
	return creditapp.ChargeScopePersonal, s.reservePersonal(ctx, userID, amount, reason)
}

func (s Service) reservePersonal(ctx context.Context, userID string, amount int32, reason string) error {
	queries := s.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return err
	}
	uid := pgtype.UUID{Bytes: userUUID, Valid: true}
	// Top up the free daily floor before checking affordability, so a user who
	// ran dry yesterday can generate again today without hitting a 402 wall.
	s.applyDailyReset(ctx, queries, uid)
	row, err := queries.DeductCreditBalanceIfEnough(ctx, uid, amount)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return creditapp.ErrInsufficientCredits
		}
		return err
	}
	// Ledger is best-effort audit; the balance deduction above is authoritative.
	logLedgerWriteFailure("reserve", queries.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID:       uid,
		AccountID:    row.ID,
		Type:         "reserve",
		Amount:       amount,
		BalanceAfter: row.CurrentBalance,
		Reason:       reason,
	}))
	return nil
}

// Refund returns amount to the user's balance after a terminal generation
// failure (reverses an earlier Reserve).
func (s Service) Refund(ctx context.Context, userID, projectID, scope string, amount int32, reason string) error {
	if amount <= 0 {
		return nil
	}
	if scope == creditapp.ChargeScopeProject && projectID != "" && s.pool != nil {
		return s.refundProject(ctx, userID, projectID, amount, reason)
	}
	return s.refundPersonal(ctx, userID, amount, reason)
}

func (s Service) refundPersonal(ctx context.Context, userID string, amount int32, reason string) error {
	queries := s.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return err
	}
	uid := pgtype.UUID{Bytes: userUUID, Valid: true}
	acct, err := queries.AdjustCreditBalance(ctx, sqlc.AdjustCreditBalanceParams{
		UserID:         uid,
		CurrentBalance: amount, // delta: + amount
	})
	if err != nil {
		return err
	}
	logLedgerWriteFailure("refund", queries.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID:       uid,
		AccountID:    acct.ID,
		Type:         "refund",
		Amount:       amount,
		BalanceAfter: acct.CurrentBalance,
		Reason:       reason,
	}))
	return nil
}

func (s Service) GetSummary(ctx context.Context, userID string) (creditapp.CreditSummary, error) {
	queries := s.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}

	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return creditapp.CreditSummary{}, err
	}
	uid := pgtype.UUID{Bytes: userUUID, Valid: true}
	// Reading the balance is a "touch" too — apply any due daily reset first so
	// the number the user sees on load already reflects today's refill.
	s.applyDailyReset(ctx, queries, uid)

	account, err := queries.GetCreditAccountByUserID(ctx, uid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return creditapp.CreditSummary{}, nil
		}
		return creditapp.CreditSummary{}, err
	}

	// "Consumed today" comes from today's debit ledger, not daily_quota minus
	// balance — the latter goes negative once a user tops up past the free quota.
	consumed, err := queries.SumUserCreditsConsumedToday(ctx, uid)
	if err != nil {
		consumed = account.DailyQuota - account.CurrentBalance // fallback
		if consumed < 0 {
			consumed = 0
		}
	}

	return creditapp.CreditSummary{
		DailyQuota:     account.DailyQuota,
		CurrentBalance: account.CurrentBalance,
		ConsumedToday:  consumed,
	}, nil
}

type projectRowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func projectAccess(ctx context.Context, q projectRowQuerier, projectID, userID uuid.UUID) (bool, string, error) {
	const query = `
SELECT p.is_collaborative,
       CASE WHEN p.owner_id = $2 THEN 'creator' ELSE COALESCE(pm.role, '') END
FROM projects p
LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
WHERE p.id = $1`
	var collaborative bool
	var role string
	err := q.QueryRow(ctx, query, projectID, userID).Scan(&collaborative, &role)
	return collaborative, role, err
}

func canUseProjectCredits(role string) bool {
	return role == "creator" || role == "admin" || role == "collaborator"
}

func canManageProjectCredits(role string) bool {
	return role == "creator" || role == "admin"
}

// reserveProject returns handled=false only for a private project. A
// collaborative project always uses its project account and never silently
// falls back to the member's personal balance.
func (s Service) reserveProject(ctx context.Context, userID, projectID string, amount int32, reason string) (bool, error) {
	uid, err := uuid.Parse(userID)
	if err != nil {
		return true, err
	}
	pid, err := uuid.Parse(projectID)
	if err != nil {
		return true, creditapp.ErrProjectCreditAccessDenied
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return true, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	collaborative, role, err := projectAccess(ctx, tx, pid, uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, creditapp.ErrProjectCreditAccessDenied
	}
	if err != nil {
		return true, err
	}
	if !collaborative {
		return false, nil
	}
	if !canUseProjectCredits(role) {
		return true, creditapp.ErrProjectCreditAccessDenied
	}

	if _, err = tx.Exec(ctx, `INSERT INTO project_credit_accounts (project_id) VALUES ($1) ON CONFLICT DO NOTHING`, pid); err != nil {
		return true, err
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_member_limits (project_id, user_id)
VALUES ($1, $2) ON CONFLICT DO NOTHING`, pid, uid); err != nil {
		return true, err
	}

	var balance int64
	if err = tx.QueryRow(ctx, `SELECT current_balance FROM project_credit_accounts WHERE project_id=$1 FOR UPDATE`, pid).Scan(&balance); err != nil {
		return true, err
	}
	var quota pgtype.Int8
	var used int64
	if err = tx.QueryRow(ctx, `
SELECT quota, used FROM project_credit_member_limits
WHERE project_id=$1 AND user_id=$2 FOR UPDATE`, pid, uid).Scan(&quota, &used); err != nil {
		return true, err
	}
	if balance < int64(amount) {
		return true, creditapp.ErrInsufficientProjectCredits
	}
	if quota.Valid && used+int64(amount) > quota.Int64 {
		return true, creditapp.ErrMemberQuotaExceeded
	}

	var balanceAfter, usedAfter int64
	if err = tx.QueryRow(ctx, `
UPDATE project_credit_accounts
SET current_balance=current_balance-$2, total_consumed=total_consumed+$2, updated_at=now()
WHERE project_id=$1 RETURNING current_balance`, pid, amount).Scan(&balanceAfter); err != nil {
		return true, err
	}
	if err = tx.QueryRow(ctx, `
UPDATE project_credit_member_limits SET used=used+$3, updated_at=now()
WHERE project_id=$1 AND user_id=$2 RETURNING used`, pid, uid, amount).Scan(&usedAfter); err != nil {
		return true, err
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_ledger_entries
  (project_id,user_id,type,amount,balance_after,member_used_after,reason,created_by)
VALUES ($1,$2,'reserve',$3,$4,$5,$6,$2)`, pid, uid, amount, balanceAfter, usedAfter, reason); err != nil {
		return true, err
	}
	if err = tx.Commit(ctx); err != nil {
		return true, err
	}
	return true, nil
}

func (s Service) refundProject(ctx context.Context, userID, projectID string, amount int32, reason string) error {
	uid, err := uuid.Parse(userID)
	if err != nil {
		return err
	}
	pid, err := uuid.Parse(projectID)
	if err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var balanceAfter int64
	if err = tx.QueryRow(ctx, `
UPDATE project_credit_accounts SET
  current_balance=current_balance+$2,
  total_consumed=GREATEST(0,total_consumed-$2),
  updated_at=now()
WHERE project_id=$1 RETURNING current_balance`, pid, amount).Scan(&balanceAfter); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_member_limits (project_id,user_id,used)
VALUES ($1,$2,0)
ON CONFLICT (project_id,user_id) DO UPDATE
SET used=GREATEST(0, project_credit_member_limits.used-$3), updated_at=now()`, pid, uid, amount); err != nil {
		return err
	}
	var usedAfter int64
	if err = tx.QueryRow(ctx, `SELECT used FROM project_credit_member_limits WHERE project_id=$1 AND user_id=$2`, pid, uid).Scan(&usedAfter); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_ledger_entries
  (project_id,user_id,type,amount,balance_after,member_used_after,reason,created_by)
VALUES ($1,$2,'refund',$3,$4,$5,$6,$2)`, pid, uid, amount, balanceAfter, usedAfter, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TransferToProject moves credits from the acting manager's personal account
// into the shared project pool. The contribution is attributed to that actor.
func (s Service) TransferToProject(ctx context.Context, actorID, projectID string, amount int64) error {
	if amount <= 0 || amount > int64(^uint32(0)>>1) {
		return creditapp.ErrInvalidProjectCreditAmount
	}
	uid, err := uuid.Parse(actorID)
	if err != nil {
		return err
	}
	pid, err := uuid.Parse(projectID)
	if err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	collaborative, role, err := projectAccess(ctx, tx, pid, uid)
	if err != nil || !collaborative || !canManageProjectCredits(role) {
		return creditapp.ErrProjectCreditAccessDenied
	}
	qtx := s.queries.WithTx(tx)
	pguid := pgtype.UUID{Bytes: uid, Valid: true}
	s.applyDailyReset(ctx, qtx, pguid)
	account, err := qtx.DeductCreditBalanceIfEnough(ctx, pguid, int32(amount))
	if errors.Is(err, pgx.ErrNoRows) {
		return creditapp.ErrInsufficientCredits
	}
	if err != nil {
		return err
	}
	var projectBalance int64
	if err = tx.QueryRow(ctx, `
INSERT INTO project_credit_accounts (project_id,current_balance,total_funded)
VALUES ($1,$2,$2)
ON CONFLICT (project_id) DO UPDATE SET
  current_balance=project_credit_accounts.current_balance+EXCLUDED.current_balance,
  total_funded=project_credit_accounts.total_funded+EXCLUDED.total_funded,
  updated_at=now()
RETURNING current_balance`, pid, amount).Scan(&projectBalance); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_contributions (project_id,user_id,amount_remaining)
VALUES ($1,$2,$3)
ON CONFLICT (project_id,user_id) DO UPDATE SET
 amount_remaining=project_credit_contributions.amount_remaining+EXCLUDED.amount_remaining,
 updated_at=now()`, pid, uid, amount); err != nil {
		return err
	}
	if err = qtx.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID: pguid, AccountID: account.ID, Type: "project_transfer_out",
		Amount: int32(amount), BalanceAfter: account.CurrentBalance,
		Reason: "划转至协作项目 " + projectID, CreatedBy: pguid,
	}); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_ledger_entries
 (project_id,user_id,type,amount,balance_after,reason,created_by)
VALUES ($1,$2,'transfer_in',$3,$4,'管理员划转积分',$2)`, pid, uid, amount, projectBalance); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RefundFromProject returns unspent credits to the acting manager, bounded by
// that manager's own remaining contribution.
func (s Service) RefundFromProject(ctx context.Context, actorID, projectID string, amount int64) error {
	if amount <= 0 || amount > int64(^uint32(0)>>1) {
		return creditapp.ErrInvalidProjectCreditAmount
	}
	uid, err := uuid.Parse(actorID)
	if err != nil {
		return err
	}
	pid, err := uuid.Parse(projectID)
	if err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	collaborative, role, err := projectAccess(ctx, tx, pid, uid)
	if err != nil || !collaborative || !canManageProjectCredits(role) {
		return creditapp.ErrProjectCreditAccessDenied
	}
	var contribution int64
	if err = tx.QueryRow(ctx, `
SELECT amount_remaining FROM project_credit_contributions
WHERE project_id=$1 AND user_id=$2 FOR UPDATE`, pid, uid).Scan(&contribution); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return creditapp.ErrInvalidProjectCreditAmount
		}
		return err
	}
	var projectBalance int64
	if err = tx.QueryRow(ctx, `SELECT current_balance FROM project_credit_accounts WHERE project_id=$1 FOR UPDATE`, pid).Scan(&projectBalance); err != nil {
		return err
	}
	if contribution < amount || projectBalance < amount {
		return creditapp.ErrInvalidProjectCreditAmount
	}
	projectBalance -= amount
	if _, err = tx.Exec(ctx, `UPDATE project_credit_accounts SET current_balance=$2,updated_at=now() WHERE project_id=$1`, pid, projectBalance); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE project_credit_contributions SET amount_remaining=amount_remaining-$3,updated_at=now() WHERE project_id=$1 AND user_id=$2`, pid, uid, amount); err != nil {
		return err
	}
	qtx := s.queries.WithTx(tx)
	pguid := pgtype.UUID{Bytes: uid, Valid: true}
	account, err := qtx.AdjustCreditBalance(ctx, sqlc.AdjustCreditBalanceParams{UserID: pguid, CurrentBalance: int32(amount)})
	if err != nil {
		return err
	}
	if err = qtx.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID: pguid, AccountID: account.ID, Type: "project_refund_in",
		Amount: int32(amount), BalanceAfter: account.CurrentBalance,
		Reason: "协作项目积分退回 " + projectID, CreatedBy: pguid,
	}); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_ledger_entries
 (project_id,user_id,type,amount,balance_after,reason,created_by)
VALUES ($1,$2,'refund_out',$3,$4,'管理员退回积分',$2)`, pid, uid, amount, projectBalance); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s Service) SetMemberQuota(ctx context.Context, actorID, projectID, memberID string, quota *int64) error {
	if quota != nil && *quota < 0 {
		return creditapp.ErrInvalidProjectCreditAmount
	}
	actor, err := uuid.Parse(actorID)
	if err != nil {
		return err
	}
	member, err := uuid.Parse(memberID)
	if err != nil {
		return err
	}
	pid, err := uuid.Parse(projectID)
	if err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	collaborative, role, err := projectAccess(ctx, tx, pid, actor)
	if err != nil || !collaborative || !canManageProjectCredits(role) {
		return creditapp.ErrProjectCreditAccessDenied
	}
	_, targetRole, err := projectAccess(ctx, tx, pid, member)
	if err != nil || targetRole == "" {
		return creditapp.ErrProjectCreditAccessDenied
	}
	var quotaValue any
	if quota != nil {
		quotaValue = *quota
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_member_limits (project_id,user_id,quota)
VALUES ($1,$2,$3)
ON CONFLICT (project_id,user_id) DO UPDATE SET quota=EXCLUDED.quota,updated_at=now()`, pid, member, quotaValue); err != nil {
		return err
	}
	var balance int64
	_ = tx.QueryRow(ctx, `SELECT current_balance FROM project_credit_accounts WHERE project_id=$1`, pid).Scan(&balance)
	amount := int64(-1)
	if quota != nil {
		amount = *quota
	}
	if _, err = tx.Exec(ctx, `
INSERT INTO project_credit_ledger_entries
 (project_id,user_id,type,amount,balance_after,reason,created_by)
VALUES ($1,$2,'quota_update',$3,$4,'更新成员额度',$5)`, pid, member, amount, balance, actor); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s Service) GetProjectSummary(ctx context.Context, actorID, projectID string) (creditapp.ProjectCreditSummary, error) {
	result := creditapp.ProjectCreditSummary{ProjectID: projectID, Members: []creditapp.ProjectCreditMember{}}
	actor, err := uuid.Parse(actorID)
	if err != nil {
		return result, err
	}
	pid, err := uuid.Parse(projectID)
	if err != nil {
		return result, err
	}
	collaborative, role, err := projectAccess(ctx, s.pool, pid, actor)
	if err != nil || !collaborative || role == "" {
		return result, creditapp.ErrProjectCreditAccessDenied
	}
	result.CanManage = canManageProjectCredits(role)
	result.CanTransfer = result.CanManage
	// Personal balances must never leak into a collaborative workspace for
	// ordinary members. Managers need their own balance only inside the
	// allocation dialog, because that is the funding source for this project.
	if result.CanTransfer {
		personal, summaryErr := s.GetSummary(ctx, actorID)
		if summaryErr != nil {
			return result, summaryErr
		}
		result.PersonalBalance = personal.CurrentBalance
		result.PersonalDailyQuota = personal.DailyQuota
	}
	err = s.pool.QueryRow(ctx, `
SELECT current_balance,total_funded,total_consumed
FROM project_credit_accounts WHERE project_id=$1`, pid).
		Scan(&result.CurrentBalance, &result.TotalFunded, &result.TotalConsumed)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	err = s.pool.QueryRow(ctx, `
SELECT amount_remaining FROM project_credit_contributions
WHERE project_id=$1 AND user_id=$2`, pid, actor).Scan(&result.MyContribution)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}

	rows, err := s.pool.Query(ctx, `
SELECT x.user_id,x.name,x.role,l.quota,COALESCE(l.used,0)
FROM (
  SELECT p.owner_id AS user_id,u.name,'creator'::text AS role,0 AS sort_order,p.created_at
  FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=$1
  UNION ALL
  SELECT pm.user_id,u.name,pm.role,1 AS sort_order,pm.created_at
  FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=$1
) x
LEFT JOIN project_credit_member_limits l ON l.project_id=$1 AND l.user_id=x.user_id
ORDER BY x.sort_order,x.created_at`, pid)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var m creditapp.ProjectCreditMember
		var memberUUID uuid.UUID
		var quota pgtype.Int8
		if err = rows.Scan(&memberUUID, &m.Name, &m.Role, &quota, &m.Used); err != nil {
			return result, err
		}
		m.UserID = memberUUID.String()
		if quota.Valid {
			v := quota.Int64
			m.Quota = &v
		}
		result.Members = append(result.Members, m)
	}
	return result, rows.Err()
}

func (s Service) ListProjectLedger(ctx context.Context, actorID, projectID string, limit int) ([]creditapp.ProjectCreditLedgerEntry, error) {
	actor, err := uuid.Parse(actorID)
	if err != nil {
		return nil, err
	}
	pid, err := uuid.Parse(projectID)
	if err != nil {
		return nil, err
	}
	collaborative, role, err := projectAccess(ctx, s.pool, pid, actor)
	if err != nil || !collaborative || role == "" {
		return nil, creditapp.ErrProjectCreditAccessDenied
	}
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
SELECT e.id,e.user_id,COALESCE(u.name,''),e.type,e.amount,e.balance_after,
       e.member_used_after,e.reason,e.created_at
FROM project_credit_ledger_entries e
LEFT JOIN users u ON u.id=e.user_id
WHERE e.project_id=$1 ORDER BY e.created_at DESC LIMIT $2`, pid, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]creditapp.ProjectCreditLedgerEntry, 0)
	for rows.Next() {
		var item creditapp.ProjectCreditLedgerEntry
		var id uuid.UUID
		var uid pgtype.UUID
		var used pgtype.Int8
		var created time.Time
		if err = rows.Scan(&id, &uid, &item.UserName, &item.Type, &item.Amount, &item.BalanceAfter, &used, &item.Reason, &created); err != nil {
			return nil, err
		}
		item.ID = id.String()
		if uid.Valid {
			item.UserID = uuid.UUID(uid.Bytes).String()
		}
		if used.Valid {
			v := used.Int64
			item.MemberUsedAfter = &v
		}
		item.CreatedAt = created.Format(time.RFC3339)
		items = append(items, item)
	}
	return items, rows.Err()
}

type projectCreditContribution struct {
	UserID uuid.UUID
	Amount int64
}

// allocateProjectRefund distributes a project's remaining balance among the
// people who funded it. Normal consumption is shared proportionally across
// outstanding contributions. Any balance that has no matching contribution
// (for example, legacy/manual data) is returned to the project owner.
func allocateProjectRefund(balance int64, owner uuid.UUID, contributions []projectCreditContribution) map[uuid.UUID]int64 {
	refunds := make(map[uuid.UUID]int64)
	if balance <= 0 {
		return refunds
	}

	var total int64
	valid := make([]projectCreditContribution, 0, len(contributions))
	for _, contribution := range contributions {
		if contribution.Amount <= 0 {
			continue
		}
		total += contribution.Amount
		valid = append(valid, contribution)
	}
	if total <= 0 {
		refunds[owner] = balance
		return refunds
	}

	// A project should normally have balance <= outstanding contributions.
	// Preserve the per-contributor cap when legacy/manual adjustments make the
	// balance larger, and give only the unmatched remainder to the owner.
	if balance >= total {
		for _, contribution := range valid {
			refunds[contribution.UserID] += contribution.Amount
		}
		refunds[owner] += balance - total
		return refunds
	}

	type refundShare struct {
		userID    uuid.UUID
		amount    int64
		remainder int64
		awarded   bool
	}
	shares := make([]refundShare, 0, len(valid))
	var assigned int64
	for _, contribution := range valid {
		product := balance * contribution.Amount
		amount := product / total
		shares = append(shares, refundShare{
			userID: contribution.UserID, amount: amount, remainder: product % total,
		})
		assigned += amount
	}

	// Largest remainder wins each fractional credit. UUIDs break ties so
	// database row order cannot change who receives the tail credit.
	for assigned < balance {
		best := -1
		for i := range shares {
			if shares[i].awarded {
				continue
			}
			if best == -1 || shares[i].remainder > shares[best].remainder ||
				(shares[i].remainder == shares[best].remainder && shares[i].userID.String() < shares[best].userID.String()) {
				best = i
			}
		}
		if best == -1 {
			break
		}
		shares[best].amount++
		shares[best].awarded = true
		assigned++
	}
	for _, share := range shares {
		if share.amount > 0 {
			refunds[share.userID] += share.amount
		}
	}
	return refunds
}

// DeleteProjectAndRefundCredits atomically returns all unspent project
// credits and deletes the project. The project row and credit account are
// locked so a concurrent transfer or generation cannot make credits vanish
// between the refund calculation and the cascading delete.
func (s Service) DeleteProjectAndRefundCredits(ctx context.Context, actorID, projectID string) (bool, int64, error) {
	actor, err := uuid.Parse(actorID)
	if err != nil {
		return false, 0, err
	}
	pid, err := uuid.Parse(projectID)
	if err != nil {
		return false, 0, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var owner uuid.UUID
	var projectName string
	err = tx.QueryRow(ctx, `
SELECT owner_id,name FROM projects
WHERE id=$1 AND owner_id=$2 FOR UPDATE`, pid, actor).Scan(&owner, &projectName)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}

	var projectBalance int64
	err = tx.QueryRow(ctx, `
SELECT current_balance FROM project_credit_accounts
WHERE project_id=$1 FOR UPDATE`, pid).Scan(&projectBalance)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, 0, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		projectBalance = 0
	}

	contributions := make([]projectCreditContribution, 0)
	if projectBalance > 0 {
		rows, queryErr := tx.Query(ctx, `
SELECT user_id,amount_remaining
FROM project_credit_contributions
WHERE project_id=$1 AND amount_remaining>0
ORDER BY updated_at,user_id
FOR UPDATE`, pid)
		if queryErr != nil {
			return false, 0, queryErr
		}
		for rows.Next() {
			var contribution projectCreditContribution
			if scanErr := rows.Scan(&contribution.UserID, &contribution.Amount); scanErr != nil {
				rows.Close()
				return false, 0, scanErr
			}
			contributions = append(contributions, contribution)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			rows.Close()
			return false, 0, rowsErr
		}
		rows.Close()

		refunds := allocateProjectRefund(projectBalance, owner, contributions)
		reason := "删除协作项目自动退回：" + projectName
		for userID, amount := range refunds {
			if amount <= 0 {
				continue
			}
			var accountID uuid.UUID
			var balanceAfter int64
			if err = tx.QueryRow(ctx, `
UPDATE credit_accounts
SET current_balance=current_balance+$2,updated_at=now()
WHERE user_id=$1
RETURNING id,current_balance`, userID, amount).Scan(&accountID, &balanceAfter); err != nil {
				return false, 0, err
			}
			if _, err = tx.Exec(ctx, `
INSERT INTO credit_ledger_entries
  (user_id,account_id,type,amount,balance_after,reason,created_by)
VALUES ($1,$2,'project_refund_in',$3,$4,$5,$6)`, userID, accountID, amount, balanceAfter, reason, actor); err != nil {
				return false, 0, err
			}
		}
	}

	result, err := tx.Exec(ctx, `DELETE FROM projects WHERE id=$1 AND owner_id=$2`, pid, actor)
	if err != nil {
		return false, 0, err
	}
	if result.RowsAffected() == 0 {
		return false, 0, nil
	}
	if err = tx.Commit(ctx); err != nil {
		return false, 0, err
	}
	return true, projectBalance, nil
}
