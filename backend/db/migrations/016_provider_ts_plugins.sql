-- TS provider plugins: optional adapter code + explicit icon metadata.
-- Existing rows keep using the built-in Go adapters.

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS adapter_runtime VARCHAR(16) NOT NULL DEFAULT 'go'
        CHECK (adapter_runtime IN ('go', 'ts'));

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS adapter_code TEXT NOT NULL DEFAULT '';

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS adapter_checksum VARCHAR(64) NOT NULL DEFAULT '';

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS icon_key VARCHAR(64) NOT NULL DEFAULT '';

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS icon_url TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_provider_configs_adapter_runtime
    ON provider_configs(adapter_runtime);
