-- Task durability columns for Asynq integration (P2 of the NewAPI/Redis plan).
--
-- Adds idempotency, durable payload, async task lifecycle markers so the
-- generation handler can:
--   - dedupe duplicate submits via request_id
--   - enqueue and recover via Asynq with the payload re-loadable from DB
--   - track which Asynq task currently owns a log row
--   - reflect cancellation and cache hits in audit
--
-- Status enum is extended; existing 'pending' rows remain valid (kept as
-- a synonym for 'queued' until a backfill is run separately).

ALTER TABLE generation_logs
  ADD COLUMN request_id      UUID,
  ADD COLUMN asynq_task_id   VARCHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN cancelled_at    TIMESTAMPTZ,
  ADD COLUMN cache_hit       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN request_payload JSONB;

-- Idempotency: only enforced for non-null values so legacy rows (no
-- request_id) don't collide.
CREATE UNIQUE INDEX idx_generation_logs_request_id
  ON generation_logs(request_id)
  WHERE request_id IS NOT NULL;

-- Reverse lookup so a frontend reconnect can fetch all active tasks
-- for the current user in one query.
CREATE INDEX idx_generation_logs_active
  ON generation_logs(user_id, status)
  WHERE status IN ('pending', 'queued', 'running', 'retrying');

-- Extend status enum. 'pending' kept for backward compatibility with
-- existing rows / inflight code paths; new submissions use 'queued'.
ALTER TABLE generation_logs DROP CONSTRAINT generation_logs_status_check;
ALTER TABLE generation_logs ADD CONSTRAINT generation_logs_status_check
  CHECK (status IN ('pending', 'queued', 'running', 'success', 'error', 'cancelled', 'retrying', 'dead'));
