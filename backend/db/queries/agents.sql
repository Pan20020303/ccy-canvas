-- name: ListVisibleAgents :many
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at
FROM agents
WHERE enabled = TRUE
  AND (scope = 'global' OR (scope = 'personal' AND owner_id = $1))
ORDER BY scope ASC, created_at DESC;

-- name: ListAllAgents :many
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at
FROM agents
ORDER BY scope ASC, created_at DESC;

-- name: GetAgent :one
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at
FROM agents
WHERE id = $1;

-- name: InsertAgent :one
INSERT INTO agents (scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at;

-- name: UpdateAgent :one
UPDATE agents
SET name = $2,
    description = $3,
    avatar = $4,
    system_prompt = $5,
    model = $6,
    skill_ids = $7,
    canvas_tools = $8,
    strategy = $9,
    enabled = $10,
    updated_at = now()
WHERE id = $1
RETURNING id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at;

-- name: DeleteAgent :exec
DELETE FROM agents WHERE id = $1;
