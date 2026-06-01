-- name: ListProviderConfigs :many
SELECT id, service_type, vendor, name, api_spec, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, created_at, updated_at
FROM provider_configs
ORDER BY service_type, priority ASC, created_at ASC;

-- name: GetProviderConfigByID :one
SELECT id, service_type, vendor, name, api_spec, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, created_at, updated_at
FROM provider_configs
WHERE id = $1;

-- name: CreateProviderConfig :one
INSERT INTO provider_configs (service_type, vendor, name, api_spec, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model, priority, is_default, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING id, service_type, vendor, name, api_spec, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, created_at, updated_at;

-- name: UpdateProviderConfig :one
UPDATE provider_configs
SET service_type     = $2,
    vendor           = $3,
    name             = $4,
    api_spec         = $5,
    base_url         = $6,
    encrypted_api_key = $7,
    submit_endpoint  = $8,
    query_endpoint   = $9,
    model_list       = $10,
    default_model    = $11,
    priority         = $12,
    is_default       = $13,
    status           = $14,
    updated_at       = now()
WHERE id = $1
RETURNING id, service_type, vendor, name, api_spec, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, created_at, updated_at;

-- name: DeleteProviderConfig :exec
DELETE FROM provider_configs WHERE id = $1;

-- name: ListEnabledProviderConfigs :many
SELECT id, service_type, vendor, name, api_spec, base_url,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, created_at, updated_at
FROM provider_configs
WHERE status = 'enabled'
ORDER BY service_type, priority ASC;
