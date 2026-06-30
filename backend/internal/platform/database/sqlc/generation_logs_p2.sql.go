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
	"time"

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

type MarkGenerationLogPersistingParams struct {
	ID          pgtype.UUID `json:"id"`
	StagingPath string      `json:"staging_path"`
	StagingUrl  string      `json:"staging_url"`
	CosKey      string      `json:"cos_key"`
	ContentType string      `json:"content_type"`
	DurationMs  int32       `json:"duration_ms"`
}

const markGenerationLogPersisting = `
UPDATE generation_logs
SET status = 'persisting',
    result_url = $2,
    error_msg = '',
    duration_ms = $6,
    cache_hit = false,
    staging_path = $3,
    staging_url = $2,
    cos_key = $4,
    asset_status = 'persisting',
    asset_error = '',
    asset_last_attempt_at = NOW()
WHERE id = $1
`

func (q *Queries) MarkGenerationLogPersisting(ctx context.Context, arg MarkGenerationLogPersistingParams) error {
	_, err := q.db.Exec(ctx, markGenerationLogPersisting,
		arg.ID, arg.StagingUrl, arg.StagingPath, arg.CosKey, arg.ContentType, arg.DurationMs)
	return err
}

type MarkGenerationLogAssetReadyParams struct {
	ID         pgtype.UUID `json:"id"`
	CosUrl     string      `json:"cos_url"`
	DurationMs int32       `json:"duration_ms"`
}

const markGenerationLogAssetReady = `
UPDATE generation_logs
SET status = 'success',
    result_url = $2,
    cos_url = $2,
    asset_status = 'ready',
    asset_error = '',
    cache_hit = true,
    duration_ms = CASE WHEN $3 > 0 THEN $3 ELSE duration_ms END
WHERE id = $1
`

func (q *Queries) MarkGenerationLogAssetReady(ctx context.Context, arg MarkGenerationLogAssetReadyParams) error {
	_, err := q.db.Exec(ctx, markGenerationLogAssetReady, arg.ID, arg.CosUrl, arg.DurationMs)
	return err
}

const markGenerationLogAssetFailed = `
UPDATE generation_logs
SET asset_status = $2,
    asset_error = $3,
    asset_retry_count = asset_retry_count + 1,
    asset_last_attempt_at = NOW(),
    error_msg = CASE WHEN $2 = 'cos_failed' THEN $3 ELSE error_msg END,
    status = CASE WHEN $2 = 'cos_failed' THEN 'error' ELSE status END
WHERE id = $1
`

func (q *Queries) MarkGenerationLogAssetFailed(ctx context.Context, id pgtype.UUID, status string, errMsg string) error {
	_, err := q.db.Exec(ctx, markGenerationLogAssetFailed, id, status, errMsg)
	return err
}

type LoadGenerationAssetRow struct {
	ID          pgtype.UUID        `json:"id"`
	UserID      pgtype.UUID        `json:"user_id"`
	NodeID      string             `json:"node_id"`
	ServiceType string             `json:"service_type"`
	StagingPath string             `json:"staging_path"`
	StagingUrl  string             `json:"staging_url"`
	CosKey      string             `json:"cos_key"`
	Status      string             `json:"status"`
	CreatedAt   pgtype.Timestamptz `json:"created_at"`
}

const loadGenerationAsset = `
SELECT id, user_id, node_id, service_type, staging_path, staging_url, cos_key, status, created_at
FROM generation_logs
WHERE id = $1
`

func (q *Queries) LoadGenerationAsset(ctx context.Context, id pgtype.UUID) (LoadGenerationAssetRow, error) {
	row := q.db.QueryRow(ctx, loadGenerationAsset, id)
	var i LoadGenerationAssetRow
	err := row.Scan(&i.ID, &i.UserID, &i.NodeID, &i.ServiceType, &i.StagingPath, &i.StagingUrl, &i.CosKey, &i.Status, &i.CreatedAt)
	return i, err
}

// ─── Frontend reconnect: list active tasks for a user ─────────────────

type ListActiveGenerationsForUserRow struct {
	ID          pgtype.UUID        `json:"id"`
	NodeID      string             `json:"node_id"`
	ServiceType string             `json:"service_type"`
	Model       string             `json:"model"`
	Prompt      string             `json:"prompt"`
	Status      string             `json:"status"`
	ResultUrl   string             `json:"result_url"`
	ErrorMsg    string             `json:"error_msg"`
	AsynqTaskID string             `json:"asynq_task_id"`
	CreatedAt   pgtype.Timestamptz `json:"created_at"`
}

// ─── Reaper (F3): find + fail stale active tasks ──────────────────────

type StaleActiveGenerationRow struct {
	ID          pgtype.UUID        `json:"id"`
	UserID      pgtype.UUID        `json:"user_id"`
	NodeID      string             `json:"node_id"`
	ServiceType string             `json:"service_type"`
	Status      string             `json:"status"`
	CreditCost  int32              `json:"credit_cost"`
	CreatedAt   pgtype.Timestamptz `json:"created_at"`
}

const listStaleActiveGenerations = `
SELECT id, user_id, node_id, service_type, status,
       COALESCE((request_payload->>'CreditCost')::int, 0) AS credit_cost,
       created_at
FROM generation_logs
WHERE status IN ('pending', 'queued', 'running', 'retrying')
  AND created_at < $1
ORDER BY created_at ASC
LIMIT 500
`

// ListStaleActiveGenerations returns active rows older than the cutoff.
// The caller applies the precise per-service-type runtime budget; this
// query just uses the smallest budget as a cheap pre-filter.
func (q *Queries) ListStaleActiveGenerations(ctx context.Context, olderThan time.Time) ([]StaleActiveGenerationRow, error) {
	var ts pgtype.Timestamptz
	ts.Time = olderThan
	ts.Valid = true
	rows, err := q.db.Query(ctx, listStaleActiveGenerations, ts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []StaleActiveGenerationRow{}
	for rows.Next() {
		var i StaleActiveGenerationRow
		if err := rows.Scan(&i.ID, &i.UserID, &i.NodeID, &i.ServiceType, &i.Status, &i.CreditCost, &i.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const markGenerationLogTimedOut = `
UPDATE generation_logs
SET status = 'error', error_msg = $2
WHERE id = $1 AND status IN ('pending', 'queued', 'running', 'retrying')
`

// MarkGenerationLogTimedOut flips a still-active row to 'error'. The status
// guard makes it a no-op (0 rows) if the task actually completed between
// the reaper's SELECT and this UPDATE, so a real success is never
// clobbered. Returns the number of rows affected.
func (q *Queries) MarkGenerationLogTimedOut(ctx context.Context, id pgtype.UUID, errMsg string) (int64, error) {
	tag, err := q.db.Exec(ctx, markGenerationLogTimedOut, id, errMsg)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const markGenerationLogFailed = `
UPDATE generation_logs
SET status = 'error', error_msg = $2, duration_ms = $3
WHERE id = $1 AND status IN ('pending', 'queued', 'running', 'retrying', 'persisting')
`

// MarkGenerationLogFailed flips a still-active row to 'error' with the given
// message and duration. The status guard makes it a no-op (0 rows) when the
// row is already terminal, so a refund gated on RowsAffected()>0 fires exactly
// once even when multiple terminal-failure paths (the Asynq worker's
// FinalizeFailure and the reaper) race on the same task. Returns the number of
// rows affected.
func (q *Queries) MarkGenerationLogFailed(ctx context.Context, id pgtype.UUID, errMsg string, durationMs int32) (int64, error) {
	tag, err := q.db.Exec(ctx, markGenerationLogFailed, id, errMsg, durationMs)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const listActiveGenerationsForUser = `
SELECT id, node_id, service_type, model, prompt, status, result_url, error_msg, asynq_task_id, created_at
FROM generation_logs
WHERE user_id = $1
  AND status IN ('pending', 'queued', 'running', 'retrying', 'persisting')
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
		if err := rows.Scan(&i.ID, &i.NodeID, &i.ServiceType, &i.Model, &i.Prompt, &i.Status, &i.ResultUrl, &i.ErrorMsg, &i.AsynqTaskID, &i.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}
