package sqlc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// TaskControlRow is a private read projection. Payload and queue IDs must never
// be serialized to the client. Ownership is enforced by both queries below.
type TaskControlRow struct {
	ID                                                         pgtype.UUID
	NodeID, ProjectID, ProjectName, ServiceType, Model, Status string
	ResultURL, ResultURLs, ErrorMsg                            string
	DurationMs                                                 int32
	CreatedAt                                                  pgtype.Timestamptz
	AsynqTaskID                                                string
	ExecutionStarted                                           bool
	BillingVerified                                            bool
	Payload                                                    []byte
}

const taskControlColumns = `g.id, g.node_id,
COALESCE(g.request_payload->>'project_id', g.request_payload->>'ProjectID', ''),
g.service_type, g.model, g.status, g.result_url, COALESCE(g.result_urls,''),
g.error_msg, g.duration_ms, g.created_at, g.asynq_task_id,
COALESCE(g.request_payload->>'_execution_started_at','') <> '',
(g.request_payload->>'CreditCost'='0' OR g.request_payload->>'credit_reserved'='true') IS TRUE`

func scanTaskControl(row pgx.Row, withPayload bool) (TaskControlRow, error) {
	var item TaskControlRow
	dest := []any{&item.ID, &item.NodeID, &item.ProjectID, &item.ServiceType, &item.Model,
		&item.Status, &item.ResultURL, &item.ResultURLs, &item.ErrorMsg, &item.DurationMs,
		&item.CreatedAt, &item.AsynqTaskID, &item.ExecutionStarted, &item.BillingVerified}
	if withPayload {
		dest = append(dest, &item.Payload)
	} else {
		dest = append(dest, &item.ProjectName)
	}
	err := row.Scan(dest...)
	return item, err
}

// No prompt or request payload is selected for the task tray.
func (q *Queries) ListRecentTasksForUser(ctx context.Context, userID pgtype.UUID, limit int32) ([]TaskControlRow, error) {
	rows, err := q.db.Query(ctx, `SELECT `+taskControlColumns+`, COALESCE(p.name,'')
FROM generation_logs g
LEFT JOIN projects p ON p.id::text=COALESCE(g.request_payload->>'project_id',g.request_payload->>'ProjectID','')
 AND (p.owner_id=$1 OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=$1))
WHERE g.user_id=$1
ORDER BY (g.status IN ('pending','queued','running','retrying','persisting')) DESC, g.created_at DESC
LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []TaskControlRow{}
	for rows.Next() {
		item, err := scanTaskControl(rows, false)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (q *Queries) GetTaskControlForUser(ctx context.Context, id, userID pgtype.UUID) (TaskControlRow, error) {
	return scanTaskControl(q.db.QueryRow(ctx, `SELECT `+taskControlColumns+`, ''::text
FROM generation_logs g WHERE g.id=$1 AND g.user_id=$2`, id, userID), false)
}

func (r TaskControlRow) CancellationReason() string {
	switch strings.ToLower(strings.TrimSpace(r.Status)) {
	case "cancelled", "canceled":
		return "already_cancelled"
	case "success", "error", "dead", "failed", "completed":
		return "already_finished"
	case "running", "persisting":
		return "already_started"
	case "queued":
		if r.ExecutionStarted {
			return "already_started"
		}
		if r.AsynqTaskID != "" && r.BillingVerified {
			return ""
		}
	}
	return "unsupported"
}

type TaskCancellation struct {
	Task      TaskControlRow
	Cancelled bool
	Reason    string
}

type transactionBeginner interface {
	Begin(context.Context) (pgx.Tx, error)
}

// Cancellation and the exact reserved account refund commit together. The row
// lock competes with ClaimGenerationExecution, so whichever wins defines whether
// the provider may run. A failed balance/ledger write rolls back the cancellation.
// This intentionally does not support running, legacy inline or previously-run
// retry tasks. It never calls a provider cancellation endpoint.
func (q *Queries) CancelQueuedTaskForUser(ctx context.Context, id, userID pgtype.UUID) (TaskCancellation, error) {
	beginner, ok := q.db.(transactionBeginner)
	if !ok {
		return TaskCancellation{}, errors.New("task cancellation transaction unavailable")
	}
	tx, err := beginner.Begin(ctx)
	if err != nil {
		return TaskCancellation{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	row, err := scanTaskControl(tx.QueryRow(ctx, `SELECT `+taskControlColumns+`, g.request_payload
FROM generation_logs g WHERE g.id=$1 AND g.user_id=$2 FOR UPDATE OF g`, id, userID), true)
	if err != nil {
		return TaskCancellation{}, err
	}
	if reason := row.CancellationReason(); reason != "" {
		return TaskCancellation{Task: row, Cancelled: reason == "already_cancelled", Reason: reason}, nil
	}
	var reserved struct {
		CreditCost      *int32
		CreditScope     string
		CreditReserved  bool   `json:"credit_reserved"`
		ProjectID       string `json:"project_id"`
		LegacyProjectID string `json:"ProjectID"`
	}
	if err := json.Unmarshal(row.Payload, &reserved); err != nil || reserved.CreditCost == nil || *reserved.CreditCost < 0 {
		return TaskCancellation{}, errors.New("reserved task billing data is unavailable; task was not cancelled")
	}
	projectID := reserved.ProjectID
	if projectID == "" {
		projectID = reserved.LegacyProjectID
	}
	amount := *reserved.CreditCost
	if amount > 0 && !reserved.CreditReserved {
		return TaskCancellation{}, errors.New("reserved credit proof is unavailable; task was not cancelled")
	}
	reason := "refund: queued task cancelled " + formatTaskUUID(id)
	if amount > 0 {
		switch reserved.CreditScope {
		case "personal":
			queries := q.WithTx(tx)
			account, err := queries.AdjustCreditBalance(ctx, AdjustCreditBalanceParams{UserID: userID, CurrentBalance: amount})
			if err != nil {
				return TaskCancellation{}, err
			}
			if err := queries.CreateCreditLedgerEntry(ctx, CreateCreditLedgerEntryParams{
				UserID: userID, AccountID: account.ID, Type: "refund", Amount: amount,
				BalanceAfter: account.CurrentBalance, Reason: reason,
			}); err != nil {
				return TaskCancellation{}, err
			}
		case "project":
			var pid pgtype.UUID
			if pid.Scan(projectID) != nil || !pid.Valid {
				return TaskCancellation{}, errors.New("reserved project account is unavailable")
			}
			if err := refundCancelledProjectTask(ctx, tx, pid, userID, amount, reason); err != nil {
				return TaskCancellation{}, err
			}
		default:
			return TaskCancellation{}, errors.New("reserved credit scope is unavailable; task was not cancelled")
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE generation_logs SET status='cancelled', cancelled_at=now(), error_msg=''
WHERE id=$1 AND user_id=$2 AND status='queued'
 AND COALESCE(request_payload->>'_execution_started_at','')=''`, id, userID)
	if err != nil {
		return TaskCancellation{}, err
	}
	if tag.RowsAffected() != 1 {
		return TaskCancellation{}, errors.New("task changed during cancellation")
	}
	if err := tx.Commit(ctx); err != nil {
		return TaskCancellation{}, err
	}
	row.Status, row.ErrorMsg = "cancelled", ""
	return TaskCancellation{Task: row, Cancelled: true, Reason: "cancelled"}, nil
}

// Mirrors credits.infrastructure.refundProject, within the SAME transaction as
// task cancellation. The original CreditScope determines the destination even
// if project collaboration or membership changed after reservation.
func refundCancelledProjectTask(ctx context.Context, tx pgx.Tx, pid, uid pgtype.UUID, amount int32, reason string) error {
	var balanceAfter, usedAfter int64
	if err := tx.QueryRow(ctx, `UPDATE project_credit_accounts SET current_balance=current_balance+$2,
total_consumed=GREATEST(0,total_consumed-$2),updated_at=now()
WHERE project_id=$1 RETURNING current_balance`, pid, amount).Scan(&balanceAfter); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO project_credit_member_limits (project_id,user_id,used) VALUES ($1,$2,0)
ON CONFLICT (project_id,user_id) DO UPDATE SET used=GREATEST(0,project_credit_member_limits.used-$3),updated_at=now()`, pid, uid, amount); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT used FROM project_credit_member_limits WHERE project_id=$1 AND user_id=$2`, pid, uid).Scan(&usedAfter); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO project_credit_ledger_entries
(project_id,user_id,type,amount,balance_after,member_used_after,reason,created_by)
VALUES ($1,$2,'refund',$3,$4,$5,$6,$2)`, pid, uid, amount, balanceAfter, usedAfter, reason)
	return err
}

func formatTaskUUID(id pgtype.UUID) string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", id.Bytes[0:4], id.Bytes[4:6], id.Bytes[6:8], id.Bytes[8:10], id.Bytes[10:16])
}

// The worker must not call the provider unless this atomic claim succeeds.
// Running remains claimable for existing Asynq text retries; cancellation is
// restricted to queued tasks without an execution marker, never those retries.
func (q *Queries) ClaimGenerationExecution(ctx context.Context, id pgtype.UUID) (bool, error) {
	tag, err := q.db.Exec(ctx, `UPDATE generation_logs SET status='running',
request_payload=COALESCE(request_payload,'{}'::jsonb) || jsonb_build_object('_execution_started_at',
COALESCE(request_payload->>'_execution_started_at',NOW()::text))
WHERE id=$1 AND status IN ('pending','queued','running','retrying')`, id)
	return tag.RowsAffected() > 0, err
}
