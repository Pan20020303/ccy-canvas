import { finishAgentTaskProgress, updateAgentTaskProgress, type AgentTaskProgressState } from "./agent/task-progress";
import type { AgentPlanEventData, AgentProgressEventData } from "../api/agent-run";

export type AgentConversationRole = "user" | "assistant";

export type AgentVideoReference = { url: string; name?: string; nodeId?: string; poster?: string };

export type AgentConversationTurn = {
  role: AgentConversationRole;
  content: string;
  /** Image URLs are also encoded in the saved user input, so a reload can restore them. */
  images?: string[];
  videos?: AgentVideoReference[];
  /** The editable user text, without the machine-readable reference preamble. */
  editText?: string;
  toolCalls?: AgentConversationToolCall[];
  /** Public execution plan and statuses; never model reasoning. */
  progress?: AgentTaskProgressState;
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
const IMAGE_REFERENCE_PREAMBLE = /^（参考图片：(.+?)）\s*\n?/u;
const VIDEO_REFERENCE_PREAMBLE = /^（参考视频：(.*)）(?:\r?\n|$)/u;

export function isVideoReferenceUrl(url: string): boolean {
  let source = url;
  for (let i = 0; i < 5; i++) {
    try {
      const parsed = new URL(source, 'http://localhost');
      const original = parsed.pathname === '/api/app/proxy-media' ? parsed.searchParams.get('url') : null;
      if (original) { source = original; continue; }
      return /\.(mp4|mov|webm|m4v|avi|mkv|ogv|mpeg|mpg)$/i.test(parsed.pathname);
    } catch { return false; }
  }
  return false;
}

export function videoReferencePreamble(videos: AgentVideoReference[]): string {
  return videos.map(video => `（参考视频：${JSON.stringify(video)}）\n`).join('');
}

export function imageReferencePreamble(urls: string[]): string {
  return urls.map((url) => `（参考图片：${url}）\n`).join("");
}

export function parseAgentUserInput(input: string): { content: string; images: string[]; videos: AgentVideoReference[]; canvasReferences: number } {
  let remaining = input.trim();
  const images: string[] = [];
  const videos: AgentVideoReference[] = [];
  const canvasEntries: string[] = [];
  let canvasReferences = 0;
  // Both kinds of reference are only accepted at the beginning of a turn.
  while (remaining) {
    const canvas = remaining.match(CANVAS_REFERENCE_PREAMBLE);
    if (canvas) {
      canvasReferences += canvas[1].split(/[，,]/u).filter((value) => value.trim()).length;
      canvasEntries.push(...canvas[1].split(/[，,]/u).filter(value => value.trim()));
      remaining = remaining.slice(canvas[0].length).trimStart();
      continue;
    }
    const video = remaining.match(VIDEO_REFERENCE_PREAMBLE);
    if (video) {
      try {
        const value: unknown = JSON.parse(video[1]);
        if (value && typeof value === 'object' && 'url' in value && typeof value.url === 'string') {
          const item = value as Record<string, unknown>;
          videos.push({url: value.url,
            ...(typeof item.name === 'string' ? {name:item.name} : {}),
            ...(typeof item.nodeId === 'string' ? {nodeId:item.nodeId} : {}),
            ...(typeof item.poster === 'string' ? {poster:item.poster} : {}),
          });
        }
      } catch { if (/^(https?:\/\/|\/)/i.test(video[1])) videos.push({url:video[1]}); }
      remaining = remaining.slice(video[0].length).trimStart();
      continue;
    }
    const image = remaining.match(IMAGE_REFERENCE_PREAMBLE);
    if (image) {
      const url = image[1].trim();
      // Older releases encoded video URLs as image attachments. Recover them
      // at read time without rewriting users' stored conversations.
      if (url && isVideoReferenceUrl(url)) {
        const onlyReference = canvasEntries.length === 1 ? canvasEntries[0] : '';
        const separator = onlyReference.lastIndexOf('#');
        videos.push({url, ...(separator > 0 ? {
          name: onlyReference.slice(0,separator), nodeId:onlyReference.slice(separator+1),
        } : {})});
      } else if (url) images.push(url);
      remaining = remaining.slice(image[0].length).trimStart();
      continue;
    }
    break;
  }
  return { content: remaining.trim(), images, videos, canvasReferences };
}

/** Keep machine routing context out of the user-facing conversation bubble. */
export function presentAgentUserInput(input: string): string {
  const parsed = parseAgentUserInput(input);
  const labels = [
    parsed.canvasReferences && !parsed.images.length && !parsed.videos.length ? `📎 已引用 ${parsed.canvasReferences} 个画布节点` : "",
    parsed.images.length && !parsed.content ? `📷 已附 ${parsed.images.length} 张图片` : "",
    parsed.videos.length && !parsed.content ? `🎬 已附 ${parsed.videos.length} 个视频` : "",
  ].filter(Boolean);
  return [...labels, parsed.content].filter(Boolean).join("\n");
}

export function parsePersistedToolLog(toolLog: string | undefined): AgentConversationToolCall[] {
  const normalized = toolLog?.trim();
  if (!normalized) return [];

  return normalized.split(/\n(?=[✓✕]\s+)/u).filter(block => !/^✓ public_progress\(\{\}\) → /u.test(block)).map((block) => {
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

/** Restore only explicitly public state, never interpreting ordinary tool output as progress. */
export function parsePersistedTaskProgress(toolLog: string | undefined): AgentTaskProgressState | undefined {
  const prefix = "✓ public_progress({}) → ";
  const record = toolLog?.split("\n").findLast(line => line.startsWith(prefix));
  if (!record) return undefined;
  try {
    const raw = JSON.parse(record.slice(prefix.length));
    let state: AgentTaskProgressState | undefined;
    if (raw.plan && Array.isArray(raw.plan.steps)) {
      const steps: AgentPlanEventData["steps"] = raw.plan.steps.filter((step: unknown) => {
        if (!step || typeof step !== "object") return false;
        const value = step as Record<string, unknown>;
        return typeof value.id === "string" && typeof value.title === "string" && ["pending", "in_progress", "completed", "blocked"].includes(String(value.status));
      }).slice(0, 6).map((step: AgentPlanEventData["steps"][number]) => ({ id: step.id, title: step.title.slice(0, 160), status: step.status }));
      state = updateAgentTaskProgress(state, { type: "plan", data: { steps, ...(typeof raw.plan.summary === "string" ? { summary: raw.plan.summary.slice(0, 240) } : {}) } });
    }
    if (raw.progress && typeof raw.progress.id === "string" && typeof raw.progress.label === "string" && ["running", "completed", "failed", "waiting"].includes(raw.progress.status)) {
      const activity: AgentProgressEventData = { id: raw.progress.id, label: raw.progress.label.slice(0, 240), status: raw.progress.status,
        ...(typeof raw.progress.tool_name === 'string' ? { tool_name: raw.progress.tool_name.slice(0, 80) } : {}),
        ...(typeof raw.progress.phase === 'string' ? { phase: raw.progress.phase.slice(0, 40) } : {}),
      };
      state = updateAgentTaskProgress(state, { type: "progress", data: activity });
    }
    return finishAgentTaskProgress(state, raw.progress?.status === "failed" ? "failed" : raw.progress?.status === "waiting" ? "waiting" : "completed");
  } catch { return undefined; }
}

export function appendConversationTurn(
  history: AgentConversationTurn[],
  role: AgentConversationRole,
  content: string,
  limit = 12,
  images?: string[],
  videos?: AgentVideoReference[],
): AgentConversationTurn[] {
  const normalized = content.trim();
  if (!normalized) {
    return history;
  }

  const turn: AgentConversationTurn = { role, content: normalized,
    ...(images?.length ? {images} : {}), ...(videos?.length ? {videos} : {}),
  };
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
      const parsed = parseAgentUserInput(item.user_input);
      turns.push({
        role: "user",
        content: presentAgentUserInput(item.user_input),
        ...(parsed.canvasReferences || parsed.images.length || parsed.videos.length ? { editText: parsed.content } : {}),
        ...(parsed.images.length ? { images: parsed.images } : {}),
        ...(parsed.videos.length ? { videos: parsed.videos } : {}),
      });
    }
    if (item.final_reply.trim()) {
      const toolCalls = parsePersistedToolLog(item.tool_log);
      const progress = parsePersistedTaskProgress(item.tool_log);
      turns.push({ role: "assistant", content: item.final_reply.trim(),
        ...(toolCalls.length ? { toolCalls } : {}), ...(progress ? { progress } : {}),
      });
    }
  }
  return turns;
}
