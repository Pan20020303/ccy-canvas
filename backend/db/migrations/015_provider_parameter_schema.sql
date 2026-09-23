ALTER TABLE provider_configs
  ADD COLUMN IF NOT EXISTS parameter_schema JSONB NOT NULL DEFAULT '{}'::jsonb;
