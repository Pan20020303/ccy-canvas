-- name: ListVisibleAgents :many
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at,
       COALESCE(deploy_key, '') AS deploy_key, parent_deploy_key, model_name, provider_id, temperature, max_output_tokens, runtime, metadata
FROM agents
WHERE enabled = TRUE
  AND (scope = 'global' OR (scope = 'personal' AND owner_id = $1))
ORDER BY scope ASC, created_at DESC;

-- name: ListAllAgents :many
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at,
       COALESCE(deploy_key, '') AS deploy_key, parent_deploy_key, model_name, provider_id, temperature, max_output_tokens, runtime, metadata
FROM agents
ORDER BY scope ASC, created_at DESC;

-- name: GetAgent :one
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at,
       COALESCE(deploy_key, '') AS deploy_key, parent_deploy_key, model_name, provider_id, temperature, max_output_tokens, runtime, metadata
FROM agents
WHERE id = $1;

-- name: GetAgentByDeployKey :one
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at,
       COALESCE(deploy_key, '') AS deploy_key, parent_deploy_key, model_name, provider_id, temperature, max_output_tokens, runtime, metadata
FROM agents
WHERE deploy_key = $1;

-- name: InsertAgent :one
INSERT INTO agents (scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled,
                    deploy_key, parent_deploy_key, model_name, provider_id, temperature, max_output_tokens, runtime, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULLIF($12, ''), $13, $14, $15, $16, $17, $18, $19)
RETURNING id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at,
          COALESCE(deploy_key, '') AS deploy_key, parent_deploy_key, model_name, provider_id, temperature, max_output_tokens, runtime, metadata;

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
    deploy_key = NULLIF($11, ''),
    parent_deploy_key = $12,
    model_name = $13,
    provider_id = $14,
    temperature = $15,
    max_output_tokens = $16,
    runtime = $17,
    metadata = $18,
    updated_at = now()
WHERE id = $1
RETURNING id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at,
          COALESCE(deploy_key, '') AS deploy_key, parent_deploy_key, model_name, provider_id, temperature, max_output_tokens, runtime, metadata;

-- name: DeleteAgent :exec
DELETE FROM agents WHERE id = $1;
