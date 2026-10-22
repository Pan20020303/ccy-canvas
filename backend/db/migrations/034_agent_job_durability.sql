-- Durable agent jobs: the HTTP request creates a job, while a background
-- worker owns execution.  SSE clients only observe the append-only event log
-- and may reconnect with the last event id after a refresh.

ALTER TABLE agent_runs
    DROP CONSTRAINT IF EXISTS agent_runs_status_check;

ALTER TABLE agent_runs
    ADD COLUMN IF NOT EXISTS request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE agent_runs
    ADD CONSTRAINT agent_runs_status_check
    CHECK (status IN ('pending','queued','running','waiting','success','error','cancelled'));

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_status_created
    ON agent_runs(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_events (
    id         BIGSERIAL PRIMARY KEY,
    run_id     UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id_id
    ON agent_run_events(run_id, id);
