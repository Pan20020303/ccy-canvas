package infrastructure

import (
	"context"
	"errors"
	"log"

	creditapp "ccy-canvas/backend/internal/credits/application"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/database/sqlctx"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
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
}

func NewService(queries *sqlc.Queries) Service {
	return Service{queries: queries}
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
func (s Service) Reserve(ctx context.Context, userID string, amount int32, reason string) error {
	if amount <= 0 {
		return nil
	}
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
func (s Service) Refund(ctx context.Context, userID string, amount int32, reason string) error {
	if amount <= 0 {
		return nil
	}
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
