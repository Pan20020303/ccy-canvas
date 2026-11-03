-- A canvas agent's chat threads belong to one project. Existing shared
-- conversations stay in the legacy empty scope; do not guess which canvas
-- owns a thread that may already contain turns from several projects.
ALTER TABLE agent_conversations
    ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_agent_conversations_project_updated
    ON agent_conversations(user_id, agent_id, project_id, updated_at DESC);
