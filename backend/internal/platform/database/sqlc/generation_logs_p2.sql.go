// Hand-authored bindings for the P2 (Asynq task queue) additions on
// generation_logs. Lives outside the sqlc-generated generation_logs.sql.go
// so we can iterate on these without re-running sqlc generate (which
// today has stale-file conflicts with the older agents/skills hand-written
// bindings — see the P2 notes in docs/dev/2026-06-newapi-runbook.md).
//
// Requires migration 013_task_durability.sql to be applied; without it
// the request_id / request_payload / asynq_task_id / cancelled_at columns
// don't exist and these queries will return SQL errors at runtime.

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

// ─── Insert queued task with full request payload ─────────────────────

type InsertGenerationLogQueuedParams struct {
	UserID         pgtype.UUID `json:"user_id"`
	NodeID         string      `json:"node_id"`
	ServiceType    string      `json:"service_type"`
	Model          string      `json:"model"`
	Prompt         string      `json:"prompt"`
	RequestID      pgtype.UUID `json:"request_id"`
	RequestPayload []byte      `json:"request_payload"`
}

type InsertGenerationLogQueuedRow struct {
	ID          pgtype.UUID        `json:"id"`
	UserID      pgtype.UUID        `json:"user_id"`
	NodeID      string             `json:"node_id"`
	ServiceType string             `json:"service_type"`
	Model       string             `json:"model"`
	Status      string             `json:"status"`
	CreatedAt   pgtype.Timestamptz `json:"created_at"`
}

const insertGenerationLogQueued = `
INSERT INTO generation_logs (
    user_id, node_id, service_type, model, prompt, status,
    result_url, error_msg, duration_ms, request_id, request_payload
)
VALUES ($1, $2, $3, $4, $5, 'queued', '', '', 0, $6, $7)
ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
RETURNING id, user_id, node_id, service_type, model, status, created_at
`

// InsertGenerationLogQueued inserts a new queued row. Returns the row
// data; if the request_id was already inserted (idempotent retry),
// returns pgx.ErrNoRows — caller should then call
// GetGenerationLogByRequestID to fetch the existing row.
func (q *Queries) InsertGenerationLogQueued(ctx context.Context, arg InsertGenerationLogQueuedParams) (InsertGenerationLogQueuedRow, error) {
	row := q.db.QueryRow(ctx, insertGenerationLogQueued,
		arg.UserID, arg.NodeID, arg.ServiceType, arg.Model, arg.Prompt,
		arg.RequestID, arg.RequestPayload)
	var i InsertGenerationLogQueuedRow
	err := row.Scan(&i.ID, &i.UserID, &i.NodeID, &i.ServiceType, &i.Model, &i.Status, &i.CreatedAt)
	return i, err
}

// ─── Idempotency lookup ───────────────────────────────────────────────

const getGenerationLogByRequestID = `
SELECT id, user_id, node_id, service_type, model, status, created_at
FROM generation_logs
WHERE request_id = $1
`

func (q *Queries) GetGenerationLogByRequestID(ctx context.Context, requestID pgtype.UUID) (InsertGenerationLogQueuedRow, error) {
	row := q.db.QueryRow(ctx, getGenerationLogByRequestID, requestID)
	var i InsertGenerationLogQueuedRow
	err := row.Scan(&i.ID, &i.UserID, &i.NodeID, &i.ServiceType, &i.Model, &i.Status, &i.CreatedAt)
	return i, err
}

// ─── Worker: load payload ─────────────────────────────────────────────

type LoadGenerationLogPayloadRow struct {
	ID             pgtype.UUID `json:"id"`
	UserID         pgtype.UUID `json:"user_id"`
	NodeID         string      `json:"node_id"`
	ServiceType    string      `json:"service_type"`
	Model          string      `json:"model"`
	Prompt         string      `json:"prompt"`
	RequestPayload []byte      `json:"request_payload"`
	Status         string      `json:"status"`
}

// Wrapper around the JSONB result so the worker can tell "no payload"
// (legacy row) from "valid empty JSON". sqlc-style Valid flag.
type RequestPayloadField struct {
	Bytes []byte
	Valid bool
}

const loadGenerationLogPayload = `
SELECT id, user_id, node_id, service_type, model, prompt, request_payload, status
FROM generation_logs
WHERE id = $1
`

func (q *Queries) LoadGenerationLogPayload(ctx context.Context, id pgtype.UUID) (LoadGenerationLogPayloadRow, error) {
	row := q.db.QueryRow(ctx, loadGenerationLogPayload, id)
	var i LoadGenerationLogPayloadRow
	var payload []byte
	err := row.Scan(&i.ID, &i.UserID, &i.NodeID, &i.ServiceType, &i.Model, &i.Prompt, &payload, &i.Status)
	if err == nil {
		i.RequestPayload = payload
	}
	return i, err
}

// ─── State transitions ────────────────────────────────────────────────

const markGenerationLogRunning = `
UPDATE generation_logs
SET status = 'running'
WHERE id = $1 AND status IN ('pending', 'queued', 'retrying')
`

func (q *Queries) MarkGenerationLogRunning(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, markGenerationLogRunning, id)
	return err
}

const markGenerationLogAsynqTaskID = `
UPDATE generation_logs
SET asynq_task_id = $2
WHERE id = $1
`

func (q *Queries) MarkGenerationLogAsynqTaskID(ctx context.Context, id pgtype.UUID, asynqTaskID string) error {
	_, err := q.db.Exec(ctx, markGenerationLogAsynqTaskID, id, asynqTaskID)
	return err
}

const markGenerationLogCancelled = `
UPDATE generation_logs
SET status = 'cancelled', cancelled_at = NOW()
WHERE id = $1 AND status IN ('pending', 'queued', 'running', 'retrying')
`

func (q *Queries) MarkGenerationLogCancelled(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, markGenerationLogCancelled, id)
	return err
}

// ─── Frontend reconnect: list active tasks for a user ─────────────────

type ListActiveGenerationsForUserRow struct {
	ID          pgtype.UUID        `json:"id"`
	NodeID      string             `json:"node_id"`
	ServiceType string             `json:"service_type"`
	Model       string             `json:"model"`
	Prompt      string             `json:"prompt"`
	Status      string             `json:"status"`
	AsynqTaskID string             `json:"asynq_task_id"`
	CreatedAt   pgtype.Timestamptz `json:"created_at"`
}

const listActiveGenerationsForUser = `
SELECT id, node_id, service_type, model, prompt, status, asynq_task_id, created_at
FROM generation_logs
WHERE user_id = $1
  AND status IN ('pending', 'queued', 'running', 'retrying')
ORDER BY created_at DESC
LIMIT 100
`

func (q *Queries) ListActiveGenerationsForUser(ctx context.Context, userID pgtype.UUID) ([]ListActiveGenerationsForUserRow, error) {
	rows, err := q.db.Query(ctx, listActiveGenerationsForUser, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ListActiveGenerationsForUserRow{}
	for rows.Next() {
		var i ListActiveGenerationsForUserRow
		if err := rows.Scan(&i.ID, &i.NodeID, &i.ServiceType, &i.Model, &i.Prompt, &i.Status, &i.AsynqTaskID, &i.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}
