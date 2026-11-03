-- Gateway metadata, alert center, and cache-friendly indexes.
--
-- This migration keeps existing provider_configs rows compatible while
-- adding the fields needed for arbitrary NewAPI / OpenAI-compatible relays.

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS protocol VARCHAR(32) NOT NULL DEFAULT 'openai_compatible';

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(64) NOT NULL DEFAULT '';

-- Cooldown columns remain for backward compatibility but are no longer used
-- for automatic routing decisions in CHANNEL_POLICY=single.
UPDATE provider_configs
SET protocol = CASE
    WHEN api_spec = 'ark' THEN 'native'
    WHEN api_spec = 'custom' THEN 'openai_compatible'
    ELSE 'openai_compatible'
END
WHERE protocol = '';

CREATE INDEX IF NOT EXISTS idx_provider_configs_protocol
    ON provider_configs(protocol);

CREATE TABLE IF NOT EXISTS admin_alerts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_config_id UUID REFERENCES provider_configs(id) ON DELETE SET NULL,
    generation_log_id  UUID REFERENCES generation_logs(id) ON DELETE SET NULL,
    service_type       VARCHAR(32) NOT NULL DEFAULT '',
    model              VARCHAR(128) NOT NULL DEFAULT '',
    error_code         VARCHAR(64) NOT NULL DEFAULT '',
    error_message      TEXT NOT NULL DEFAULT '',
    source             VARCHAR(32) NOT NULL DEFAULT 'ccy_canvas',
    severity           VARCHAR(16) NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('low', 'medium', 'high')),
    status             VARCHAR(16) NOT NULL DEFAULT 'unread'
        CHECK (status IN ('unread', 'read', 'resolved')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_status
    ON admin_alerts(status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_provider
    ON admin_alerts(provider_config_id, last_seen_at DESC);
