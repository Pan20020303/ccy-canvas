package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

type AgentSetting struct {
	Key       string             `json:"key"`
	Value     []byte             `json:"value"`
	UpdatedAt pgtype.Timestamptz `json:"updated_at"`
}

const getAgentSetting = `-- name: GetAgentSetting :one
SELECT key, value, updated_at
FROM agent_settings
WHERE key = $1
`

func (q *Queries) GetAgentSetting(ctx context.Context, key string) (AgentSetting, error) {
	row := q.db.QueryRow(ctx, getAgentSetting, key)
	var i AgentSetting
	err := row.Scan(&i.Key, &i.Value, &i.UpdatedAt)
	return i, err
}

type UpsertAgentSettingParams struct {
	Key   string `json:"key"`
	Value []byte `json:"value"`
}

const upsertAgentSetting = `-- name: UpsertAgentSetting :one
INSERT INTO agent_settings (key, value)
VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
RETURNING key, value, updated_at
`

func (q *Queries) UpsertAgentSetting(ctx context.Context, arg UpsertAgentSettingParams) (AgentSetting, error) {
	row := q.db.QueryRow(ctx, upsertAgentSetting, arg.Key, arg.Value)
	var i AgentSetting
	err := row.Scan(&i.Key, &i.Value, &i.UpdatedAt)
	return i, err
}

type AgentMemory struct {
	ID           pgtype.UUID        `json:"id"`
	UserID       pgtype.UUID        `json:"user_id"`
	AgentID      pgtype.UUID        `json:"agent_id"`
	IsolationKey string             `json:"isolation_key"`
	Role         string             `json:"role"`
	Content      string             `json:"content"`
	Embedding    []byte             `json:"embedding"`
	Metadata     []byte             `json:"metadata"`
	Summarized   bool               `json:"summarized"`
	CreatedAt    pgtype.Timestamptz `json:"created_at"`
	UpdatedAt    pgtype.Timestamptz `json:"updated_at"`
}

type InsertAgentMemoryParams struct {
	UserID       pgtype.UUID `json:"user_id"`
	AgentID      pgtype.UUID `json:"agent_id"`
	IsolationKey string      `json:"isolation_key"`
	Role         string      `json:"role"`
	Content      string      `json:"content"`
	Embedding    []byte      `json:"embedding"`
	Metadata     []byte      `json:"metadata"`
	Summarized   bool        `json:"summarized"`
}

const insertAgentMemory = `-- name: InsertAgentMemory :one
INSERT INTO agent_memories (user_id, agent_id, isolation_key, role, content, embedding, metadata, summarized)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, user_id, agent_id, isolation_key, role, content, embedding, metadata, summarized, created_at, updated_at
`

func (q *Queries) InsertAgentMemory(ctx context.Context, arg InsertAgentMemoryParams) (AgentMemory, error) {
	row := q.db.QueryRow(ctx, insertAgentMemory,
		arg.UserID, arg.AgentID, arg.IsolationKey, arg.Role, arg.Content, arg.Embedding, arg.Metadata, arg.Summarized)
	var i AgentMemory
	err := row.Scan(&i.ID, &i.UserID, &i.AgentID, &i.IsolationKey, &i.Role, &i.Content, &i.Embedding, &i.Metadata, &i.Summarized, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

type ListAgentMemoriesParams struct {
	UserID       pgtype.UUID `json:"user_id"`
	AgentID      pgtype.UUID `json:"agent_id"`
	IsolationKey string      `json:"isolation_key"`
	Limit        int32       `json:"limit"`
}

const listAgentMemories = `-- name: ListAgentMemories :many
SELECT id, user_id, agent_id, isolation_key, role, content, embedding, metadata, summarized, created_at, updated_at
FROM agent_memories
WHERE user_id = $1 AND agent_id = $2 AND isolation_key = $3
ORDER BY created_at DESC
LIMIT $4
`

func (q *Queries) ListAgentMemories(ctx context.Context, arg ListAgentMemoriesParams) ([]AgentMemory, error) {
	rows, err := q.db.Query(ctx, listAgentMemories, arg.UserID, arg.AgentID, arg.IsolationKey, arg.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AgentMemory{}
	for rows.Next() {
		var i AgentMemory
		if err := rows.Scan(&i.ID, &i.UserID, &i.AgentID, &i.IsolationKey, &i.Role, &i.Content, &i.Embedding, &i.Metadata, &i.Summarized, &i.CreatedAt, &i.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

type UpsertAgentWorkspaceDataParams struct {
	UserID      pgtype.UUID `json:"user_id"`
	ProjectID   string      `json:"project_id"`
	WorkspaceID string      `json:"workspace_id"`
	Key         string      `json:"key"`
	Value       []byte      `json:"value"`
}

const upsertAgentWorkspaceData = `-- name: UpsertAgentWorkspaceData :exec
INSERT INTO agent_workspace_data (user_id, project_id, workspace_id, key, value)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, project_id, workspace_id, key)
DO UPDATE SET value = EXCLUDED.value, updated_at = now()
`

func (q *Queries) UpsertAgentWorkspaceData(ctx context.Context, arg UpsertAgentWorkspaceDataParams) error {
	_, err := q.db.Exec(ctx, upsertAgentWorkspaceData, arg.UserID, arg.ProjectID, arg.WorkspaceID, arg.Key, arg.Value)
	return err
}
