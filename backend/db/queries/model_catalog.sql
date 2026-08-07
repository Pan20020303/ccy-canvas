-- name: GetRelayProvider :one
SELECT id, name, provider_type, base_url, encrypted_api_key, status, last_sync_at, created_at, updated_at
FROM relay_providers
LIMIT 1;

-- name: CreateRelayProvider :one
INSERT INTO relay_providers (name, provider_type, base_url, encrypted_api_key)
VALUES ($1, $2, $3, $4)
RETURNING id, name, provider_type, base_url, encrypted_api_key, status, last_sync_at, created_at, updated_at;

-- name: UpdateRelayProvider :one
UPDATE relay_providers
SET base_url            = $2,
    encrypted_api_key   = $3,
    updated_at          = now()
WHERE id = $1
RETURNING id, name, provider_type, base_url, encrypted_api_key, status, last_sync_at, created_at, updated_at;

-- name: SetRelayProviderLastSync :exec
UPDATE relay_providers
SET last_sync_at = now(), updated_at = now()
WHERE id = $1;

-- name: ListModelDefinitions :many
SELECT id, provider_id, external_model_name, display_name, capability, status,
       parameter_schema, default_parameters, pricing_rule, cost_snapshot, sort_order, created_at, updated_at
FROM model_definitions
ORDER BY sort_order ASC, created_at ASC;

-- name: ListEnabledModelDefinitions :many
SELECT id, provider_id, external_model_name, display_name, capability, status,
       parameter_schema, default_parameters, pricing_rule, sort_order
FROM model_definitions
WHERE status = 'enabled'
  AND NOT EXISTS (
    SELECT 1
    FROM model_permission_rules denied
    WHERE denied.model_id = model_definitions.id
      AND denied.allowed = false
      AND (
        denied.user_id = $1
        OR denied.role = $2
      )
  )
  AND (
    NOT EXISTS (
      SELECT 1
      FROM model_permission_rules rule
      WHERE rule.model_id = model_definitions.id
    )
    OR EXISTS (
      SELECT 1
      FROM model_permission_rules allowed
      WHERE allowed.model_id = model_definitions.id
        AND allowed.allowed = true
        AND (
          allowed.user_id = $1
          OR allowed.role = $2
        )
    )
  )
ORDER BY sort_order ASC, created_at ASC;

-- name: GetModelDefinitionByID :one
SELECT id, provider_id, external_model_name, display_name, capability, status,
       parameter_schema, default_parameters, pricing_rule, cost_snapshot, sort_order, created_at, updated_at
FROM model_definitions
WHERE id = $1;

-- name: InsertModelDefinitionIfNotExists :one
INSERT INTO model_definitions (provider_id, external_model_name, display_name, capability)
VALUES ($1, $2, $3, $4)
ON CONFLICT (provider_id, external_model_name) DO NOTHING
RETURNING id, provider_id, external_model_name, display_name, capability, status,
          parameter_schema, default_parameters, pricing_rule, cost_snapshot, sort_order, created_at, updated_at;

-- name: UpdateModelDefinition :one
UPDATE model_definitions
SET display_name        = $2,
    capability          = $3,
    parameter_schema    = $4,
    default_parameters  = $5,
    pricing_rule        = $6,
    sort_order          = $7,
    updated_at          = now()
WHERE id = $1
RETURNING id, provider_id, external_model_name, display_name, capability, status,
          parameter_schema, default_parameters, pricing_rule, cost_snapshot, sort_order, created_at, updated_at;

-- name: SetModelStatus :one
UPDATE model_definitions
SET status = $2, updated_at = now()
WHERE id = $1
RETURNING id, provider_id, external_model_name, display_name, capability, status,
          parameter_schema, default_parameters, pricing_rule, cost_snapshot, sort_order, created_at, updated_at;
