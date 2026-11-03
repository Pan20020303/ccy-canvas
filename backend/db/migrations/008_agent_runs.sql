-- Persist a row per agent run so admins can audit who ran what.
CREATE TABLE IF NOT EXISTS agent_runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id)  ON DELETE SET NULL,
    agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
    user_input  TEXT NOT NULL DEFAULT '',
    final_reply TEXT NOT NULL DEFAULT '',
    tool_calls  INT  NOT NULL DEFAULT 0,
    steps       INT  NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','success','error','cancelled')),
    error_msg   TEXT NOT NULL DEFAULT '',
    duration_ms INT  NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent       ON agent_runs(agent_id);
