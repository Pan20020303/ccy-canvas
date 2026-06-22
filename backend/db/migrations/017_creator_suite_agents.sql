-- Creator Suite agent deployment, routing settings, memory, and workspace data.

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS deploy_key TEXT,
    ADD COLUMN IF NOT EXISTS parent_deploy_key TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS model_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS provider_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS temperature DOUBLE PRECISION NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS max_output_tokens INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'generic',
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_deploy_key_unique
    ON agents(deploy_key)
    WHERE deploy_key IS NOT NULL AND deploy_key <> '';

CREATE INDEX IF NOT EXISTS idx_agents_parent_deploy_key
    ON agents(parent_deploy_key)
    WHERE parent_deploy_key <> '';

CREATE TABLE IF NOT EXISTS agent_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_memories (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    agent_id      UUID REFERENCES agents(id) ON DELETE CASCADE,
    isolation_key TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'memory',
    content       TEXT NOT NULL,
    embedding     JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    summarized    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_lookup
    ON agent_memories(user_id, agent_id, isolation_key, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_workspace_data (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    project_id   TEXT NOT NULL DEFAULT '',
    workspace_id TEXT NOT NULL DEFAULT '',
    key          TEXT NOT NULL,
    value        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, project_id, workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_data_project
    ON agent_workspace_data(user_id, project_id, workspace_id);
