-- name: ListProviderConfigs :many
SELECT id, service_type, vendor, name, api_spec, protocol, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, capabilities, parameter_schema,
       adapter_runtime, adapter_code, adapter_checksum, icon_key, icon_url,
       created_at, updated_at,
       failure_count, last_failure_at, last_error_msg, last_error_code, last_success_at,
       cooldown_until, consecutive_cooldowns
FROM provider_configs
ORDER BY service_type, priority ASC, created_at ASC;

-- name: GetProviderConfigByID :one
SELECT id, service_type, vendor, name, api_spec, protocol, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, capabilities, parameter_schema,
       adapter_runtime, adapter_code, adapter_checksum, icon_key, icon_url,
       created_at, updated_at,
       failure_count, last_failure_at, last_error_msg, last_error_code, last_success_at,
       cooldown_until, consecutive_cooldowns
FROM provider_configs
WHERE id = $1;

-- name: CreateProviderConfig :one
INSERT INTO provider_configs (service_type, vendor, name, api_spec, protocol, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model, priority, is_default, status,
       capabilities, parameter_schema, adapter_runtime, adapter_code, adapter_checksum, icon_key, icon_url)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
RETURNING id, service_type, vendor, name, api_spec, protocol, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, capabilities, parameter_schema,
       adapter_runtime, adapter_code, adapter_checksum, icon_key, icon_url,
       created_at, updated_at,
       failure_count, last_failure_at, last_error_msg, last_error_code, last_success_at,
       cooldown_until, consecutive_cooldowns;

-- name: UpdateProviderConfig :one
UPDATE provider_configs
SET service_type     = $2,
    vendor           = $3,
    name             = $4,
    api_spec         = $5,
    protocol         = $6,
    base_url         = $7,
    encrypted_api_key = $8,
    submit_endpoint  = $9,
    query_endpoint   = $10,
    model_list       = $11,
    default_model    = $12,
    priority         = $13,
    is_default       = $14,
    status           = $15,
    capabilities     = $16,
    parameter_schema = $17,
    adapter_runtime  = $18,
    adapter_code     = $19,
    adapter_checksum = $20,
    icon_key         = $21,
    icon_url         = $22,
    updated_at       = now()
WHERE id = $1
RETURNING id, service_type, vendor, name, api_spec, protocol, base_url, encrypted_api_key,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, capabilities, parameter_schema,
       adapter_runtime, adapter_code, adapter_checksum, icon_key, icon_url,
       created_at, updated_at,
       failure_count, last_failure_at, last_error_msg, last_error_code, last_success_at,
       cooldown_until, consecutive_cooldowns;

-- name: DeleteProviderConfig :exec
DELETE FROM provider_configs WHERE id = $1;

-- name: ListEnabledProviderConfigs :many
SELECT id, service_type, vendor, name, api_spec, protocol, base_url,
       submit_endpoint, query_endpoint, model_list, default_model,
       priority, is_default, status, capabilities, parameter_schema,
       icon_key, icon_url, created_at, updated_at,
       failure_count, last_failure_at, last_error_msg, last_error_code, last_success_at,
       cooldown_until, consecutive_cooldowns
FROM provider_configs
WHERE status = 'enabled'
ORDER BY service_type, priority ASC;

-- Channel health management. Used by modelcatalog.application.channel_health
-- to track failure counters and exponential-backoff cooldown windows.

-- name: MarkChannelSuccess :exec
UPDATE provider_configs
SET failure_count = 0,
    last_success_at = now(),
    consecutive_cooldowns = 0,
    cooldown_until = NULL,
    last_error_msg = '',
    updated_at = now()
WHERE id = $1;

-- name: IncrementChannelFailure :one
UPDATE provider_configs
SET failure_count = failure_count + 1,
    last_failure_at = now(),
    last_error_msg = $2,
    updated_at = now()
WHERE id = $1
RETURNING failure_count, consecutive_cooldowns;

-- name: SetChannelCooldown :exec
UPDATE provider_configs
SET cooldown_until = $2,
    consecutive_cooldowns = consecutive_cooldowns + 1,
    failure_count = 0,
    updated_at = now()
WHERE id = $1;

-- name: ResetChannelHealth :exec
UPDATE provider_configs
SET failure_count = 0,
    consecutive_cooldowns = 0,
    cooldown_until = NULL,
    last_error_msg = '',
    last_failure_at = NULL,
    updated_at = now()
WHERE id = $1;

-- name: InsertGenerationAttempt :one
INSERT INTO generation_attempts (
  generation_log_id, provider_config_id, vendor, attempt_number,
  http_status, error_msg, duration_ms
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, generation_log_id, provider_config_id, vendor, attempt_number,
          http_status, error_msg, duration_ms, created_at;

-- name: ListGenerationAttemptsByLog :many
SELECT id, generation_log_id, provider_config_id, vendor, attempt_number,
       http_status, error_msg, duration_ms, created_at
FROM generation_attempts
WHERE generation_log_id = $1
ORDER BY attempt_number ASC;
