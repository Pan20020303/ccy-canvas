package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// These project-scoped queries intentionally coexist with the generated
// legacy queries so old, unassigned conversations remain stored but cannot
// appear in (or be reused by) a canvas-specific agent thread.
func scanScopedConversation(row pgx.Row) (AgentConversation, error) {
	var item AgentConversation
	err := row.Scan(&item.ID, &item.UserID, &item.AgentID, &item.Title, &item.LastMessageAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func (q *Queries) GetScopedAgentConversation(ctx context.Context, id, userID, agentID pgtype.UUID, projectID string) (AgentConversation, error) {
	return scanScopedConversation(q.db.QueryRow(ctx, `
		SELECT id, user_id, agent_id, title, last_message_at, created_at, updated_at
		FROM agent_conversations
		WHERE id = $1 AND user_id = $2 AND agent_id = $3 AND project_id = $4`,
		id, userID, agentID, projectID))
}

func (q *Queries) GetLatestScopedAgentConversation(ctx context.Context, userID, agentID pgtype.UUID, projectID string) (AgentConversation, error) {
	return scanScopedConversation(q.db.QueryRow(ctx, `
		SELECT id, user_id, agent_id, title, last_message_at, created_at, updated_at
		FROM agent_conversations
		WHERE user_id = $1 AND agent_id = $2 AND project_id = $3
		ORDER BY updated_at DESC LIMIT 1`, userID, agentID, projectID))
}

func (q *Queries) InsertScopedAgentConversation(ctx context.Context, userID, agentID pgtype.UUID, projectID, title string) (AgentConversation, error) {
	return scanScopedConversation(q.db.QueryRow(ctx, `
		INSERT INTO agent_conversations (user_id, agent_id, project_id, title)
		VALUES ($1, $2, $3, $4)
		RETURNING id, user_id, agent_id, title, last_message_at, created_at, updated_at`,
		userID, agentID, projectID, title))
}

func (q *Queries) ListScopedAgentConversations(ctx context.Context, userID, agentID pgtype.UUID, projectID string) ([]ListUserAgentConversationsRow, error) {
	rows, err := q.db.Query(ctx, `
		SELECT c.id, c.user_id, c.agent_id, c.title, c.last_message_at, c.created_at, c.updated_at,
		       COALESCE((SELECT count(*) FROM agent_conversation_messages m WHERE m.conversation_id = c.id), 0)::int
		FROM agent_conversations c
		WHERE c.user_id = $1 AND c.agent_id = $2 AND c.project_id = $3
		ORDER BY c.updated_at DESC`, userID, agentID, projectID)
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

func (q *Queries) DeleteScopedAgentConversation(ctx context.Context, id, userID, agentID pgtype.UUID, projectID string) error {
	_, err := q.db.Exec(ctx, `DELETE FROM agent_conversations WHERE id = $1 AND user_id = $2 AND agent_id = $3 AND project_id = $4`, id, userID, agentID, projectID)
	return err
}

func (q *Queries) ClearScopedAgentConversations(ctx context.Context, userID, agentID pgtype.UUID, projectID string) error {
	_, err := q.db.Exec(ctx, `DELETE FROM agent_conversations WHERE user_id = $1 AND agent_id = $2 AND project_id = $3`, userID, agentID, projectID)
	return err
}
