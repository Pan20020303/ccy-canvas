-- Legacy single-row lookup. Returns the most recently updated conversation
-- when multiple now exist; callers that care about a specific conversation
-- should use GetAgentConversationByID instead.
-- name: GetAgentConversationByUserAndAgent :one
SELECT id, user_id, agent_id, title, last_message_at, created_at, updated_at
FROM agent_conversations
WHERE user_id = $1
  AND agent_id = $2
ORDER BY updated_at DESC
LIMIT 1;

-- name: GetAgentConversationByID :one
SELECT id, user_id, agent_id, title, last_message_at, created_at, updated_at
FROM agent_conversations
WHERE id = $1
  AND user_id = $2
  AND agent_id = $3;

-- name: ListUserAgentConversations :many
SELECT c.id, c.user_id, c.agent_id, c.title, c.last_message_at, c.created_at, c.updated_at,
       COALESCE((SELECT count(*) FROM agent_conversation_messages m WHERE m.conversation_id = c.id), 0)::int AS message_count
FROM agent_conversations c
WHERE c.user_id = $1
  AND c.agent_id = $2
ORDER BY c.updated_at DESC;

-- name: DeleteAgentConversationByID :exec
DELETE FROM agent_conversations
WHERE id = $1
  AND user_id = $2
  AND agent_id = $3;

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
