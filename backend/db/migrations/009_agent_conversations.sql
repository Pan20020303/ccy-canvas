CREATE TABLE IF NOT EXISTS agent_conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title           TEXT NOT NULL DEFAULT '',
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, agent_id)
);

CREATE TABLE IF NOT EXISTS agent_conversation_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_user_updated
    ON agent_conversations(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent
    ON agent_conversations(agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_conversation_messages_conversation_created
    ON agent_conversation_messages(conversation_id, created_at ASC);

ALTER TABLE agent_runs
    ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES agent_conversations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
    ON agent_runs(conversation_id);
