-- name: GetAgentConversationByUserAndAgent :one
SELECT id, user_id, agent_id, title, last_message_at, created_at, updated_at
FROM agent_conversations
WHERE user_id = $1
  AND agent_id = $2;

-- name: InsertAgentConversation :one
INSERT INTO agent_conversations (user_id, agent_id, title)
VALUES ($1, $2, $3)
RETURNING id, user_id, agent_id, title, last_message_at, created_at, updated_at;

-- name: TouchAgentConversation :one
UPDATE agent_conversations
SET title = $2,
    last_message_at = now(),
    updated_at = now()
WHERE id = $1
RETURNING id, user_id, agent_id, title, last_message_at, created_at, updated_at;

-- name: DeleteAgentConversationByUserAndAgent :exec
DELETE FROM agent_conversations
WHERE user_id = $1
  AND agent_id = $2;

-- name: InsertAgentConversationMessage :one
INSERT INTO agent_conversation_messages (conversation_id, role, content)
VALUES ($1, $2, $3)
RETURNING id, conversation_id, role, content, created_at;

-- name: ListAgentConversationMessages :many
SELECT id, conversation_id, role, content, created_at
FROM agent_conversation_messages
WHERE conversation_id = $1
ORDER BY created_at ASC
LIMIT $2;
