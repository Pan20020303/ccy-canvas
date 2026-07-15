package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type AgentConversation struct {
	ID            pgtype.UUID        `json:"id"`
	UserID        pgtype.UUID        `json:"user_id"`
	AgentID       pgtype.UUID        `json:"agent_id"`
	Title         string             `json:"title"`
	LastMessageAt pgtype.Timestamptz `json:"last_message_at"`
	CreatedAt     pgtype.Timestamptz `json:"created_at"`
	UpdatedAt     pgtype.Timestamptz `json:"updated_at"`
}

type AgentConversationMessage struct {
	ID             pgtype.UUID        `json:"id"`
	ConversationID pgtype.UUID        `json:"conversation_id"`
	Role           string             `json:"role"`
	Content        string             `json:"content"`
	CreatedAt      pgtype.Timestamptz `json:"created_at"`
}

type GetAgentConversationByUserAndAgentParams struct {
	UserID  pgtype.UUID `json:"user_id"`
	AgentID pgtype.UUID `json:"agent_id"`
}

const getAgentConversationByUserAndAgent = `-- name: GetAgentConversationByUserAndAgent :one
SELECT id, user_id, agent_id, title, last_message_at, created_at, updated_at
FROM agent_conversations
WHERE user_id = $1
  AND agent_id = $2
ORDER BY updated_at DESC
LIMIT 1
`

func (q *Queries) GetAgentConversationByUserAndAgent(ctx context.Context, arg GetAgentConversationByUserAndAgentParams) (AgentConversation, error) {
	row := q.db.QueryRow(ctx, getAgentConversationByUserAndAgent, arg.UserID, arg.AgentID)
	var item AgentConversation
	err := row.Scan(&item.ID, &item.UserID, &item.AgentID, &item.Title, &item.LastMessageAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

type InsertAgentConversationParams struct {
	UserID pgtype.UUID `json:"user_id"`
	AgentID pgtype.UUID `json:"agent_id"`
	Title string `json:"title"`
}

const insertAgentConversation = `-- name: InsertAgentConversation :one
INSERT INTO agent_conversations (user_id, agent_id, title)
VALUES ($1, $2, $3)
RETURNING id, user_id, agent_id, title, last_message_at, created_at, updated_at
`

func (q *Queries) InsertAgentConversation(ctx context.Context, arg InsertAgentConversationParams) (AgentConversation, error) {
	row := q.db.QueryRow(ctx, insertAgentConversation, arg.UserID, arg.AgentID, arg.Title)
	var item AgentConversation
	err := row.Scan(&item.ID, &item.UserID, &item.AgentID, &item.Title, &item.LastMessageAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

type TouchAgentConversationParams struct {
	ID pgtype.UUID `json:"id"`
	Title string `json:"title"`
}

const touchAgentConversation = `-- name: TouchAgentConversation :one
UPDATE agent_conversations
SET title = $2,
    last_message_at = now(),
    updated_at = now()
WHERE id = $1
RETURNING id, user_id, agent_id, title, last_message_at, created_at, updated_at
`

func (q *Queries) TouchAgentConversation(ctx context.Context, arg TouchAgentConversationParams) (AgentConversation, error) {
	row := q.db.QueryRow(ctx, touchAgentConversation, arg.ID, arg.Title)
	var item AgentConversation
	err := row.Scan(&item.ID, &item.UserID, &item.AgentID, &item.Title, &item.LastMessageAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

type DeleteAgentConversationByUserAndAgentParams struct {
	UserID pgtype.UUID `json:"user_id"`
	AgentID pgtype.UUID `json:"agent_id"`
}

const deleteAgentConversationByUserAndAgent = `-- name: DeleteAgentConversationByUserAndAgent :exec
DELETE FROM agent_conversations
WHERE user_id = $1
  AND agent_id = $2
`

func (q *Queries) DeleteAgentConversationByUserAndAgent(ctx context.Context, arg DeleteAgentConversationByUserAndAgentParams) error {
	_, err := q.db.Exec(ctx, deleteAgentConversationByUserAndAgent, arg.UserID, arg.AgentID)
	return err
}

type InsertAgentConversationMessageParams struct {
	ConversationID pgtype.UUID `json:"conversation_id"`
	Role string `json:"role"`
	Content string `json:"content"`
}

const insertAgentConversationMessage = `-- name: InsertAgentConversationMessage :one
INSERT INTO agent_conversation_messages (conversation_id, role, content)
VALUES ($1, $2, $3)
RETURNING id, conversation_id, role, content, created_at
`

func (q *Queries) InsertAgentConversationMessage(ctx context.Context, arg InsertAgentConversationMessageParams) (AgentConversationMessage, error) {
	row := q.db.QueryRow(ctx, insertAgentConversationMessage, arg.ConversationID, arg.Role, arg.Content)
	var item AgentConversationMessage
	err := row.Scan(&item.ID, &item.ConversationID, &item.Role, &item.Content, &item.CreatedAt)
	return item, err
}

type ListAgentConversationMessagesParams struct {
	ConversationID pgtype.UUID `json:"conversation_id"`
	Limit int32 `json:"limit"`
}

const listAgentConversationMessages = `-- name: ListAgentConversationMessages :many
SELECT id, conversation_id, role, content, created_at
FROM (
    SELECT id, conversation_id, role, content, created_at
    FROM agent_conversation_messages
    WHERE conversation_id = $1
    ORDER BY created_at DESC
    LIMIT $2
) tail
ORDER BY created_at ASC
`

func (q *Queries) ListAgentConversationMessages(ctx context.Context, arg ListAgentConversationMessagesParams) ([]AgentConversationMessage, error) {
	rows, err := q.db.Query(ctx, listAgentConversationMessages, arg.ConversationID, arg.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AgentConversationMessage{}
	for rows.Next() {
		var item AgentConversationMessage
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.Role, &item.Content, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type GetAgentConversationByIDParams struct {
	ID      pgtype.UUID `json:"id"`
	UserID  pgtype.UUID `json:"user_id"`
	AgentID pgtype.UUID `json:"agent_id"`
}

const getAgentConversationByID = `-- name: GetAgentConversationByID :one
SELECT id, user_id, agent_id, title, last_message_at, created_at, updated_at
FROM agent_conversations
WHERE id = $1
  AND user_id = $2
  AND agent_id = $3
`

func (q *Queries) GetAgentConversationByID(ctx context.Context, arg GetAgentConversationByIDParams) (AgentConversation, error) {
	row := q.db.QueryRow(ctx, getAgentConversationByID, arg.ID, arg.UserID, arg.AgentID)
	var item AgentConversation
	err := row.Scan(&item.ID, &item.UserID, &item.AgentID, &item.Title, &item.LastMessageAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

type ListUserAgentConversationsParams struct {
	UserID  pgtype.UUID `json:"user_id"`
	AgentID pgtype.UUID `json:"agent_id"`
}

type ListUserAgentConversationsRow struct {
	ID            pgtype.UUID        `json:"id"`
	UserID        pgtype.UUID        `json:"user_id"`
	AgentID       pgtype.UUID        `json:"agent_id"`
	Title         string             `json:"title"`
	LastMessageAt pgtype.Timestamptz `json:"last_message_at"`
	CreatedAt     pgtype.Timestamptz `json:"created_at"`
	UpdatedAt     pgtype.Timestamptz `json:"updated_at"`
	MessageCount  int32              `json:"message_count"`
}

const listUserAgentConversations = `-- name: ListUserAgentConversations :many
SELECT c.id, c.user_id, c.agent_id, c.title, c.last_message_at, c.created_at, c.updated_at,
       COALESCE((SELECT count(*) FROM agent_conversation_messages m WHERE m.conversation_id = c.id), 0)::int AS message_count
FROM agent_conversations c
WHERE c.user_id = $1
  AND c.agent_id = $2
ORDER BY c.updated_at DESC
`

func (q *Queries) ListUserAgentConversations(ctx context.Context, arg ListUserAgentConversationsParams) ([]ListUserAgentConversationsRow, error) {
	rows, err := q.db.Query(ctx, listUserAgentConversations, arg.UserID, arg.AgentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ListUserAgentConversationsRow{}
	for rows.Next() {
		var item ListUserAgentConversationsRow
		if err := rows.Scan(&item.ID, &item.UserID, &item.AgentID, &item.Title, &item.LastMessageAt, &item.CreatedAt, &item.UpdatedAt, &item.MessageCount); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type DeleteAgentConversationByIDParams struct {
	ID      pgtype.UUID `json:"id"`
	UserID  pgtype.UUID `json:"user_id"`
	AgentID pgtype.UUID `json:"agent_id"`
}

const deleteAgentConversationByID = `-- name: DeleteAgentConversationByID :exec
DELETE FROM agent_conversations
WHERE id = $1
  AND user_id = $2
  AND agent_id = $3
`

func (q *Queries) DeleteAgentConversationByID(ctx context.Context, arg DeleteAgentConversationByIDParams) error {
	_, err := q.db.Exec(ctx, deleteAgentConversationByID, arg.ID, arg.UserID, arg.AgentID)
	return err
}

var _ pgx.Row
