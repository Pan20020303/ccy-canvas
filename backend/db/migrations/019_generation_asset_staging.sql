ALTER TABLE generation_logs
  ADD COLUMN IF NOT EXISTS staging_path TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS staging_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cos_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cos_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS asset_status VARCHAR(32) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS asset_error TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS asset_retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS asset_last_attempt_at TIMESTAMPTZ;

ALTER TABLE generation_logs DROP CONSTRAINT IF EXISTS generation_logs_status_check;
ALTER TABLE generation_logs ADD CONSTRAINT generation_logs_status_check
  CHECK (status IN ('pending', 'queued', 'running', 'persisting', 'success', 'error', 'cancelled', 'retrying', 'dead'));

CREATE INDEX IF NOT EXISTS idx_generation_logs_asset_persisting
  ON generation_logs(status, asset_status, asset_last_attempt_at)
  WHERE status = 'persisting';
