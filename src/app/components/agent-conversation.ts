export type AgentConversationRole = "user" | "assistant";

export type AgentConversationTurn = {
  role: AgentConversationRole;
  content: string;
};

export type AgentConversationStore = Record<string, AgentConversationTurn[]>;
export type PersistedConversationHistoryItem = {
  user_input: string;
  final_reply: string;
};

export function appendConversationTurn(
  history: AgentConversationTurn[],
  role: AgentConversationRole,
  content: string,
  limit = 12,
): AgentConversationTurn[] {
  const normalized = content.trim();
  if (!normalized) {
    return history;
  }

  const next = [...history, { role, content: normalized }];
  return next.slice(-limit);
}

export function completeAgentConversationTurn(
  history: AgentConversationTurn[],
  userMessage: string,
  assistantMessage: string,
  limit = 12,
): AgentConversationTurn[] {
  if (!userMessage.trim() || !assistantMessage.trim()) {
    return history;
  }
  const withUser = appendConversationTurn(history, "user", userMessage, limit);
  return appendConversationTurn(withUser, "assistant", assistantMessage, limit);
}

export function getAgentConversationHistory(
  store: AgentConversationStore,
  agentId: string | null | undefined,
): AgentConversationTurn[] {
  if (!agentId) {
    return [];
  }
  return store[agentId] ?? [];
}

export function recordAgentConversationTurn(
  store: AgentConversationStore,
  agentId: string,
  userMessage: string,
  assistantMessage: string,
  limit = 12,
): AgentConversationStore {
  if (!agentId) {
    return store;
  }

  return {
    ...store,
    [agentId]: completeAgentConversationTurn(store[agentId] ?? [], userMessage, assistantMessage, limit),
  };
}

export function clearAgentConversationHistory(
  store: AgentConversationStore,
  agentId: string,
): AgentConversationStore {
  if (!agentId || !(agentId in store)) {
    return store;
  }

  const next = { ...store };
  delete next[agentId];
  return next;
}

export function conversationTurnsFromHistoryItems(
  items: PersistedConversationHistoryItem[],
): AgentConversationTurn[] {
  const turns: AgentConversationTurn[] = [];
  for (const item of items) {
    if (item.user_input.trim()) {
      turns.push({ role: "user", content: item.user_input.trim() });
    }
    if (item.final_reply.trim()) {
      turns.push({ role: "assistant", content: item.final_reply.trim() });
    }
  }
  return turns;
}
