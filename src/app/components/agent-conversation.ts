export type AgentConversationRole = "user" | "assistant";

export type AgentConversationTurn = {
  role: AgentConversationRole;
  content: string;
  /** 附图(如引用的画布节点缩略图):随消息显示为 image parts。
   *  仅本地会话内有效 —— 服务器持久化的是纯文本,历史重载后不带图。 */
  images?: string[];
  toolCalls?: AgentConversationToolCall[];
};

export type AgentConversationToolCall = {
  name: string;
  args: string;
  output: string;
  status: "success" | "error";
};

export type AgentConversationStore = Record<string, AgentConversationTurn[]>;
export type PersistedConversationHistoryItem = {
  user_input: string;
  final_reply: string;
  tool_log?: string;
};

const CANVAS_REFERENCE_PREAMBLE = /^（参考画布节点：(.+?)）\s*\n?/u;

/** Keep machine routing context out of the user-facing conversation bubble. */
export function presentAgentUserInput(input: string): string {
  const normalized = input.trim();
  const match = normalized.match(CANVAS_REFERENCE_PREAMBLE);
  if (!match) return normalized;

  const references = match[1]
    .split(/[，,]/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const content = normalized.slice(match[0].length).trim();
  const compactReference = `📎 已引用 ${Math.max(1, references.length)} 个画布节点`;
  return content ? `${compactReference}\n${content}` : compactReference;
}

export function parsePersistedToolLog(toolLog: string | undefined): AgentConversationToolCall[] {
  const normalized = toolLog?.trim();
  if (!normalized) return [];

  return normalized.split(/\n(?=[✓✕]\s+)/u).map((block) => {
    const mark = block.charAt(0);
    const body = block.slice(1).trimStart();
    const argsStart = body.indexOf("(");
    const resultStart = body.lastIndexOf(") → ");

    if (argsStart <= 0 || resultStart <= argsStart) {
      return {
        name: "工具调用记录",
        args: "{}",
        output: block,
        status: mark === "✕" ? "error" : "success",
      };
    }

    return {
      name: body.slice(0, argsStart).trim() || "工具调用",
      args: body.slice(argsStart + 1, resultStart).trim() || "{}",
      output: body.slice(resultStart + 4).trim(),
      status: mark === "✕" ? "error" : "success",
    };
  });
}

export function appendConversationTurn(
  history: AgentConversationTurn[],
  role: AgentConversationRole,
  content: string,
  limit = 12,
  images?: string[],
): AgentConversationTurn[] {
  const normalized = content.trim();
  if (!normalized) {
    return history;
  }

  const turn: AgentConversationTurn = images && images.length > 0
    ? { role, content: normalized, images }
    : { role, content: normalized };
  const next = [...history, turn];
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
      turns.push({ role: "user", content: presentAgentUserInput(item.user_input) });
    }
    if (item.final_reply.trim()) {
      const toolCalls = parsePersistedToolLog(item.tool_log);
      turns.push(toolCalls.length > 0
        ? { role: "assistant", content: item.final_reply.trim(), toolCalls }
        : { role: "assistant", content: item.final_reply.trim() });
    }
  }
  return turns;
}
