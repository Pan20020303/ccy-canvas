-- Channel-health tracking on provider_configs + per-attempt log table.
--
-- Lets the routing layer skip providers that have failed N times in a row,
-- cool them down with exponential backoff, and surface health to admins.
-- Idempotent: all new columns use IF NOT EXISTS so re-running on a
-- partially-applied DB is safe.

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS failure_count INT NOT NULL DEFAULT 0;
ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;
ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS last_error_msg TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS consecutive_cooldowns INT NOT NULL DEFAULT 0;

-- Index lets the router efficiently find healthy providers (cooldown_until
-- NULL or in the past) for a given service_type at request time.
CREATE INDEX IF NOT EXISTS idx_provider_configs_health
    ON provider_configs(service_type, status, cooldown_until);

-- Per-attempt log. One row per actual upstream HTTP call. Lets admins see
-- "request X tried OpenAI (503) → fell back to NewAPI (200)" in the audit.
CREATE TABLE IF NOT EXISTS generation_attempts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    generation_log_id   UUID REFERENCES generation_logs(id) ON DELETE CASCADE,
    provider_config_id  UUID REFERENCES provider_configs(id) ON DELETE SET NULL,
    vendor              TEXT NOT NULL DEFAULT '',
    attempt_number      INT NOT NULL,
    http_status         INT,
    error_msg           TEXT NOT NULL DEFAULT '',
    duration_ms         INT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generation_attempts_log
    ON generation_attempts(generation_log_id);
CREATE INDEX IF NOT EXISTS idx_generation_attempts_provider
    ON generation_attempts(provider_config_id, created_at DESC);
