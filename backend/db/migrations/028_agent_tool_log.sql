-- 028: 跨轮工具历史(P3)
-- agent 每轮的紧凑工具记录以 role='tool_log' 持久化到会话消息表,
-- 下一轮注入 system prompt,让后续轮次"记得"之前执行过什么。
-- 原 CHECK 只允许 user/assistant,这里放宽加入 tool_log。
-- (tool_log 行不会进 LLM messages —— runner 的 sanitize 只放行 user/assistant;
--  前端会话历史读 agent_runs,同样不受影响。)

ALTER TABLE agent_conversation_messages
    DROP CONSTRAINT IF EXISTS agent_conversation_messages_role_check;

ALTER TABLE agent_conversation_messages
    ADD CONSTRAINT agent_conversation_messages_role_check
    CHECK (role IN ('user', 'assistant', 'tool_log'));
