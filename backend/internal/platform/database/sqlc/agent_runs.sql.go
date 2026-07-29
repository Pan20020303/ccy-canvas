// Hand-authored sqlc-style bindings for agent_runs.

package sqlc

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgtype"
)

type AgentRun struct {
	ID             pgtype.UUID        `json:"id"`
	UserID         pgtype.UUID        `json:"user_id"`
	AgentID        pgtype.UUID        `json:"agent_id"`
	ConversationID pgtype.UUID        `json:"conversation_id"`
	UserInput      string             `json:"user_input"`
	FinalReply     string             `json:"final_reply"`
	ToolCalls      int32              `json:"tool_calls"`
	Steps          int32              `json:"steps"`
	Status         string             `json:"status"`
	ErrorMsg       string             `json:"error_msg"`
	DurationMs     int32              `json:"duration_ms"`
	CreatedAt      pgtype.Timestamptz `json:"created_at"`
}

type InsertAgentRunParams struct {
	UserID         pgtype.UUID `json:"user_id"`
	AgentID        pgtype.UUID `json:"agent_id"`
	ConversationID pgtype.UUID `json:"conversation_id"`
	UserInput      string      `json:"user_input"`
}

const insertAgentRun = `-- name: InsertAgentRun :one
INSERT INTO agent_runs (user_id, agent_id, conversation_id, user_input, status)
VALUES ($1, $2, $3, $4, 'pending')
RETURNING id, user_id, agent_id, conversation_id, user_input, final_reply, tool_calls, steps, status, error_msg, duration_ms, created_at
`

func (q *Queries) InsertAgentRun(ctx context.Context, arg InsertAgentRunParams) (AgentRun, error) {
	row := q.db.QueryRow(ctx, insertAgentRun, arg.UserID, arg.AgentID, arg.ConversationID, arg.UserInput)
	var i AgentRun
	err := row.Scan(&i.ID, &i.UserID, &i.AgentID, &i.ConversationID, &i.UserInput, &i.FinalReply, &i.ToolCalls, &i.Steps, &i.Status, &i.ErrorMsg, &i.DurationMs, &i.CreatedAt)
	return i, err
}

type UpdateAgentRunResultParams struct {
	ID         pgtype.UUID `json:"id"`
	FinalReply string      `json:"final_reply"`
	ToolCalls  int32       `json:"tool_calls"`
	Steps      int32       `json:"steps"`
	Status     string      `json:"status"`
	ErrorMsg   string      `json:"error_msg"`
	DurationMs int32       `json:"duration_ms"`
}

const updateAgentRunResult = `-- name: UpdateAgentRunResult :exec
UPDATE agent_runs
SET final_reply=$2, tool_calls=$3, steps=$4, status=$5, error_msg=$6,
    duration_ms=$7, finished_at=now(), updated_at=now()
WHERE id=$1
`

func (q *Queries) UpdateAgentRunResult(ctx context.Context, arg UpdateAgentRunResultParams) error {
	_, err := q.db.Exec(ctx, updateAgentRunResult, arg.ID, arg.FinalReply, arg.ToolCalls, arg.Steps, arg.Status, arg.ErrorMsg, arg.DurationMs)
	return err
}

// FinishAgentRunJob commits the terminal row and its final SSE event in one
// statement. Observers can therefore never see a terminal status before the
// corresponding done/error event is replayable.
type FinishAgentRunJobParams struct {
	ID         pgtype.UUID     `json:"id"`
	FinalReply string          `json:"final_reply"`
	ToolCalls  int32           `json:"tool_calls"`
	Steps      int32           `json:"steps"`
	Status     string          `json:"status"`
	ErrorMsg   string          `json:"error_msg"`
	DurationMs int32           `json:"duration_ms"`
	EventType  string          `json:"event_type"`
	EventData  json.RawMessage `json:"event_data"`
}

const finishAgentRunJob = `-- name: FinishAgentRunJob :exec
WITH finished AS (
    UPDATE agent_runs
    SET final_reply=$2, tool_calls=$3, steps=$4, status=$5, error_msg=$6,
        duration_ms=$7, finished_at=now(), updated_at=now()
    WHERE id=$1
    RETURNING id
)
INSERT INTO agent_run_events (run_id, event_type, data)
SELECT id, $8, $9 FROM finished
`

func (q *Queries) FinishAgentRunJob(ctx context.Context, arg FinishAgentRunJobParams) error {
	_, err := q.db.Exec(ctx, finishAgentRunJob,
		arg.ID, arg.FinalReply, arg.ToolCalls, arg.Steps, arg.Status,
		arg.ErrorMsg, arg.DurationMs, arg.EventType, arg.EventData,
	)
	return err
}

// AgentRunJob is the durable execution envelope. The potentially large
// canvas/request snapshot lives in request_payload and is loaded only by the
// background worker; history/admin list queries keep their existing shape.
type AgentRunJob struct {
	ID             pgtype.UUID     `json:"id"`
	UserID         pgtype.UUID     `json:"user_id"`
	AgentID        pgtype.UUID     `json:"agent_id"`
	ConversationID pgtype.UUID     `json:"conversation_id"`
	RequestPayload json.RawMessage `json:"request_payload"`
	Status         string          `json:"status"`
	FinalReply     string          `json:"final_reply"`
	ErrorMsg       string          `json:"error_msg"`
	Steps          int32           `json:"steps"`
}

type InsertAgentRunJobParams struct {
	UserID         pgtype.UUID     `json:"user_id"`
	AgentID        pgtype.UUID     `json:"agent_id"`
	ConversationID pgtype.UUID     `json:"conversation_id"`
	UserInput      string          `json:"user_input"`
	RequestPayload json.RawMessage `json:"request_payload"`
}

const insertAgentRunJob = `-- name: InsertAgentRunJob :one
INSERT INTO agent_runs (user_id, agent_id, conversation_id, user_input, request_payload, status, updated_at)
VALUES ($1, $2, $3, $4, $5, 'queued', now())
RETURNING id, user_id, agent_id, conversation_id, request_payload, status, final_reply, error_msg, steps
`

func (q *Queries) InsertAgentRunJob(ctx context.Context, arg InsertAgentRunJobParams) (AgentRunJob, error) {
	row := q.db.QueryRow(ctx, insertAgentRunJob, arg.UserID, arg.AgentID, arg.ConversationID, arg.UserInput, arg.RequestPayload)
	var i AgentRunJob
	err := row.Scan(&i.ID, &i.UserID, &i.AgentID, &i.ConversationID, &i.RequestPayload, &i.Status, &i.FinalReply, &i.ErrorMsg, &i.Steps)
	return i, err
}

const getAgentRunJob = `-- name: GetAgentRunJob :one
SELECT id, user_id, agent_id, conversation_id, request_payload, status, final_reply, error_msg, steps
FROM agent_runs
WHERE id = $1
`

func (q *Queries) GetAgentRunJob(ctx context.Context, id pgtype.UUID) (AgentRunJob, error) {
	row := q.db.QueryRow(ctx, getAgentRunJob, id)
	var i AgentRunJob
	err := row.Scan(&i.ID, &i.UserID, &i.AgentID, &i.ConversationID, &i.RequestPayload, &i.Status, &i.FinalReply, &i.ErrorMsg, &i.Steps)
	return i, err
}

const getOwnedAgentRunJob = `-- name: GetOwnedAgentRunJob :one
SELECT id, user_id, agent_id, conversation_id, request_payload, status, final_reply, error_msg, steps
FROM agent_runs
WHERE id = $1 AND user_id = $2
`

func (q *Queries) GetOwnedAgentRunJob(ctx context.Context, id, userID pgtype.UUID) (AgentRunJob, error) {
	row := q.db.QueryRow(ctx, getOwnedAgentRunJob, id, userID)
	var i AgentRunJob
	err := row.Scan(&i.ID, &i.UserID, &i.AgentID, &i.ConversationID, &i.RequestPayload, &i.Status, &i.FinalReply, &i.ErrorMsg, &i.Steps)
	return i, err
}

const markAgentRunRunning = `-- name: MarkAgentRunRunning :exec
UPDATE agent_runs
SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
WHERE id = $1 AND status IN ('pending', 'queued', 'running')
`

func (q *Queries) MarkAgentRunRunning(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, markAgentRunRunning, id)
	return err
}

type InsertAgentRunEventParams struct {
	RunID     pgtype.UUID     `json:"run_id"`
	EventType string          `json:"event_type"`
	Data      json.RawMessage `json:"data"`
}

const insertAgentRunEvent = `-- name: InsertAgentRunEvent :one
INSERT INTO agent_run_events (run_id, event_type, data)
VALUES ($1, $2, $3)
RETURNING id
`

func (q *Queries) InsertAgentRunEvent(ctx context.Context, arg InsertAgentRunEventParams) (int64, error) {
	var id int64
	err := q.db.QueryRow(ctx, insertAgentRunEvent, arg.RunID, arg.EventType, arg.Data).Scan(&id)
	return id, err
}

type ListAgentRunEventsAfterParams struct {
	RunID   pgtype.UUID `json:"run_id"`
	AfterID int64       `json:"after_id"`
	Limit   int32       `json:"limit"`
}

type AgentRunEvent struct {
	ID        int64              `json:"id"`
	RunID     pgtype.UUID        `json:"run_id"`
	EventType string             `json:"event_type"`
	Data      json.RawMessage    `json:"data"`
	CreatedAt pgtype.Timestamptz `json:"created_at"`
}

const listAgentRunEventsAfter = `-- name: ListAgentRunEventsAfter :many
SELECT id, run_id, event_type, data, created_at
FROM agent_run_events
WHERE run_id = $1 AND id > $2
ORDER BY id ASC
LIMIT $3
`

func (q *Queries) ListAgentRunEventsAfter(ctx context.Context, arg ListAgentRunEventsAfterParams) ([]AgentRunEvent, error) {
	rows, err := q.db.Query(ctx, listAgentRunEventsAfter, arg.RunID, arg.AfterID, arg.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AgentRunEvent{}
	for rows.Next() {
		var i AgentRunEvent
		if err := rows.Scan(&i.ID, &i.RunID, &i.EventType, &i.Data, &i.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

type ListAgentRunsParams struct {
	Limit  int32
	Offset int32
}

type ListAgentRunsRow struct {
	AgentRun
	AgentName string `json:"agent_name"`
	UserName  string `json:"user_name"`
	UserEmail string `json:"user_email"`
}

const listAgentRuns = `-- name: ListAgentRuns :many
SELECT r.id, r.user_id, r.agent_id, r.conversation_id, r.user_input, r.final_reply, r.tool_calls, r.steps, r.status, r.error_msg, r.duration_ms, r.created_at,
       COALESCE(a.name, '') AS agent_name,
       COALESCE(u.name, '') AS user_name,
       COALESCE(u.email, '') AS user_email
FROM agent_runs r
LEFT JOIN agents a ON a.id = r.agent_id
LEFT JOIN users  u ON u.id = r.user_id
ORDER BY r.created_at DESC
LIMIT $1 OFFSET $2
`

func (q *Queries) ListAgentRuns(ctx context.Context, arg ListAgentRunsParams) ([]ListAgentRunsRow, error) {
	rows, err := q.db.Query(ctx, listAgentRuns, arg.Limit, arg.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ListAgentRunsRow{}
	for rows.Next() {
		var i ListAgentRunsRow
		if err := rows.Scan(&i.ID, &i.UserID, &i.AgentID, &i.ConversationID, &i.UserInput, &i.FinalReply, &i.ToolCalls, &i.Steps, &i.Status, &i.ErrorMsg, &i.DurationMs, &i.CreatedAt, &i.AgentName, &i.UserName, &i.UserEmail); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

type ListUserAgentRunsParams struct {
	UserID  pgtype.UUID `json:"user_id"`
	AgentID pgtype.UUID `json:"agent_id"`
	Limit   int32       `json:"limit"`
}

const listUserAgentRuns = `-- name: ListUserAgentRuns :many
SELECT id, user_id, agent_id, conversation_id, user_input, final_reply, tool_calls, steps, status, error_msg, duration_ms, created_at
FROM agent_runs
WHERE user_id = $1
  AND agent_id = $2
  AND status = 'success'
  AND final_reply <> ''
ORDER BY created_at DESC
LIMIT $3
`

func (q *Queries) ListUserAgentRuns(ctx context.Context, arg ListUserAgentRunsParams) ([]AgentRun, error) {
	rows, err := q.db.Query(ctx, listUserAgentRuns, arg.UserID, arg.AgentID, arg.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AgentRun{}
	for rows.Next() {
		var i AgentRun
		if err := rows.Scan(&i.ID, &i.UserID, &i.AgentID, &i.ConversationID, &i.UserInput, &i.FinalReply, &i.ToolCalls, &i.Steps, &i.Status, &i.ErrorMsg, &i.DurationMs, &i.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

type DeleteUserAgentRunsParams struct {
	UserID  pgtype.UUID `json:"user_id"`
	AgentID pgtype.UUID `json:"agent_id"`
}

const deleteUserAgentRuns = `-- name: DeleteUserAgentRuns :exec
DELETE FROM agent_runs
WHERE user_id = $1
  AND agent_id = $2
`

func (q *Queries) DeleteUserAgentRuns(ctx context.Context, arg DeleteUserAgentRunsParams) error {
	_, err := q.db.Exec(ctx, deleteUserAgentRuns, arg.UserID, arg.AgentID)
	return err
}
