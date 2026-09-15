-- Allow multiple conversations per (user, agent) pair so users can keep
-- distinct chat threads with the same agent and switch between them, the
-- same way Claude / ChatGPT let you flip between chats.

ALTER TABLE agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_user_id_agent_id_key;
