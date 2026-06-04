// Hand-authored sqlc-style bindings for agent_runs.

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

type AgentRun struct {
	ID         pgtype.UUID        `json:"id"`
	UserID     pgtype.UUID        `json:"user_id"`
	AgentID    pgtype.UUID        `json:"agent_id"`
	UserInput  string             `json:"user_input"`
	FinalReply string             `json:"final_reply"`
	ToolCalls  int32              `json:"tool_calls"`
	Steps      int32              `json:"steps"`
	Status     string             `json:"status"`
	ErrorMsg   string             `json:"error_msg"`
	DurationMs int32              `json:"duration_ms"`
	CreatedAt  pgtype.Timestamptz `json:"created_at"`
}

type InsertAgentRunParams struct {
	UserID    pgtype.UUID `json:"user_id"`
	AgentID   pgtype.UUID `json:"agent_id"`
	UserInput string      `json:"user_input"`
}

const insertAgentRun = `-- name: InsertAgentRun :one
INSERT INTO agent_runs (user_id, agent_id, user_input, status)
VALUES ($1, $2, $3, 'pending')
RETURNING id, user_id, agent_id, user_input, final_reply, tool_calls, steps, status, error_msg, duration_ms, created_at
`

func (q *Queries) InsertAgentRun(ctx context.Context, arg InsertAgentRunParams) (AgentRun, error) {
	row := q.db.QueryRow(ctx, insertAgentRun, arg.UserID, arg.AgentID, arg.UserInput)
	var i AgentRun
	err := row.Scan(&i.ID, &i.UserID, &i.AgentID, &i.UserInput, &i.FinalReply, &i.ToolCalls, &i.Steps, &i.Status, &i.ErrorMsg, &i.DurationMs, &i.CreatedAt)
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
UPDATE agent_runs SET final_reply=$2, tool_calls=$3, steps=$4, status=$5, error_msg=$6, duration_ms=$7 WHERE id=$1
`

func (q *Queries) UpdateAgentRunResult(ctx context.Context, arg UpdateAgentRunResultParams) error {
	_, err := q.db.Exec(ctx, updateAgentRunResult, arg.ID, arg.FinalReply, arg.ToolCalls, arg.Steps, arg.Status, arg.ErrorMsg, arg.DurationMs)
	return err
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
SELECT r.id, r.user_id, r.agent_id, r.user_input, r.final_reply, r.tool_calls, r.steps, r.status, r.error_msg, r.duration_ms, r.created_at,
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
		if err := rows.Scan(&i.ID, &i.UserID, &i.AgentID, &i.UserInput, &i.FinalReply, &i.ToolCalls, &i.Steps, &i.Status, &i.ErrorMsg, &i.DurationMs, &i.CreatedAt, &i.AgentName, &i.UserName, &i.UserEmail); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}
