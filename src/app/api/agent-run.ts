/** Durable streaming client for background agent jobs. */

import type { Edge, Node } from "@xyflow/react";
import type { AgentConversationTurn } from "../components/agent-conversation";
import { ApiClientError, readApiError } from "./client";
import { toUserMessage } from "./errors";
import { safeFailureMessage } from "./failure-message";

export type AgentSSEEventType =
  | "plan" | "progress"
  | "thought" | "thought_delta" | "tool_call" | "tool_result"
  | "message" | "message_delta" | "canvas_patch"
  | "conversation" | "ask_user" | "usage" | "runtime" | "delegation" | "connection_status" | "error" | "done";

export type AgentSSEEvent =
  | { type: "plan"; data: AgentPlanEventData }
  | { type: "progress"; data: AgentProgressEventData }
  | { type: "runtime"; data: { agent_name: string; model: string; policy: string } }
  | { type: "delegation"; data: { id: string; agent_name: string; status: string; model: string } }
  | { type: "thought"; data: { content: string } }
  | { type: "thought_delta"; data: { delta: string } }
  | { type: "tool_call"; data: { id: string; name: string; arguments: string } }
  | { type: "tool_result"; data: { id: string; name: string; ok: boolean; result?: string; error?: string } }
  | { type: "message_delta"; data: { delta: string } }
  | { type: "message"; data: { content: string } }
  | { type: "canvas_patch"; data: CanvasPatch }
  | { type: "conversation"; data: { id: string } }
  | { type: "ask_user"; data: { question: string; options: string[]; allow_custom?: boolean } }
  | { type: "usage"; data: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: "connection_status"; data: { state: "reconnecting" | "connected"; attempts: number } }
  | { type: "error"; data: { message: string; job_id?: string } }
  | { type: "done"; data: { steps: number } };

export type AgentPlanEventData = {
  steps: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" | "blocked" }>;
  summary?: string;
};
export type AgentProgressEventData = {
  id: string;
  label: string;
  phase?: string;
  tool_name?: string;
  node_ids?: string[];
  status: "running" | "completed" | "failed" | "waiting";
};

export type AgentEventMeta = {
  id: number;
  /** True when rebuilding an already-seen run after the panel remounts. */
  replayed: boolean;
};

type AgentEventHandler = (event: AgentSSEEvent, meta?: AgentEventMeta) => void;

type CanvasPatchRevision = {
  /** Revision this mutation was computed against. Omitted by older servers. */
  base_revision?: number;
  /** Revision after applying this mutation. */
  revision?: number;
};

export type CanvasPatch = (
  | { op: "add_node"; node: Node }
  | { op: "add_edge"; edge: Edge }
  | { op: "patch_node_data"; node_id: string; patch: Record<string, unknown> }
  | { op: "run_node"; node_id: string; prompt?: string; model?: string; aspect_ratio?: string; resolution?: string; requires_confirmation?: boolean }
  | { op: "move_node"; node_id: string; position: { x: number; y: number }; from_position?: { x: number; y: number } }
  | { op: "move_nodes"; moves: Array<{ node_id: string; position: { x: number; y: number }; from_position: { x: number; y: number } }> }
  | { op: "delete_node"; node_id: string }
  | { op: "create_group"; node_ids: string[]; name?: string }
) & CanvasPatchRevision;

export type CanvasPatchRevisionResult =
  | { accepted: true; nextRevision: number | null }
  | { accepted: false; nextRevision: number | null; reason: string };

/**
 * Enforce the per-agent-run patch sequence. Legacy patches without revision
 * metadata remain accepted; revisioned patches must be contiguous and based
 * on the last patch the browser applied.
 */
export function advanceCanvasPatchRevision(
  currentRevision: number | null,
  patch: CanvasPatch,
): CanvasPatchRevisionResult {
  const base = patch.base_revision;
  const next = patch.revision;
  if (base == null && next == null) return { accepted: true, nextRevision: currentRevision };
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(next) || base! < 0 || next! < 0) {
    return { accepted: false, nextRevision: currentRevision, reason: "画布 Patch 的版本信息不完整" };
  }
  if (next !== base! + 1) {
    return { accepted: false, nextRevision: currentRevision, reason: `画布 Patch 版本不连续（${base} → ${next}）` };
  }
  if (currentRevision != null && base !== currentRevision) {
    return {
      accepted: false,
      nextRevision: currentRevision,
      reason: `画布 Patch 冲突：当前版本 ${currentRevision}，收到基于版本 ${base} 的操作`,
    };
  }
  return { accepted: true, nextRevision: next! };
}

export type AgentRunBody = {
	 skill_id?: string;
  message: string;
  /** UI-only text. Machine preambles and skill payloads stay in `message`. */
  displayMessage?: string;
  nodes: unknown[];
  edges: unknown[];
  groups?: unknown[];
  history?: AgentConversationTurn[];
  conversation_id?: string;
  model?: string;
  project_id?: string;
  workspace_id?: string;
  /** Persisted canvas snapshot version used as this run's revision base. */
  canvas_revision?: number;
  task_context?: unknown;
  generation_models?: Record<string, string[]>;
  thinking?: boolean;
  reasoning_effort?: 'low' | 'high' | 'max';
  manual_confirmation?: boolean;
  vision_model?: string;
};

export async function cancelAgentJob(job: ActiveAgentJob): Promise<void> {
  const response = await fetch(`${apiBase}/api/app/agent-jobs/${encodeURIComponent(job.jobId)}/cancel`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw await readApiError(response);
  clearActiveJob(job.agentId, job.projectId ?? "", job.jobId);
}

export type ActiveAgentJob = {
  agentId: string;
  projectId?: string;
  jobId: string;
  conversationId: string;
  after: number;
  message?: string;
  manualConfirmation?: boolean;
};

type AgentJobState = {
  status: string;
  final_reply?: string;
  error_message?: string;
  steps?: number;
};

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const ACTIVE_JOB_PREFIX = "ccy:agent-job:";

function activeJobKey(agentId: string, projectId = "") {
  return `${ACTIVE_JOB_PREFIX}${agentId}${projectId ? `:${encodeURIComponent(projectId)}` : ""}`;
}

function saveActiveJob(job: ActiveAgentJob) {
  try { localStorage.setItem(activeJobKey(job.agentId, job.projectId), JSON.stringify(job)); } catch { /* optional */ }
}

function clearActiveJob(agentId: string, projectId: string, jobId: string) {
  try {
    const current = getActiveAgentJob(agentId, projectId);
    if (!current || current.jobId === jobId) localStorage.removeItem(activeJobKey(agentId, projectId));
  } catch { /* optional */ }
}

export function getActiveAgentJob(agentId: string, projectId = ""): ActiveAgentJob | null {
  try {
    const raw = localStorage.getItem(activeJobKey(agentId, projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveAgentJob>;
    if (!parsed.agentId || !parsed.jobId) return null;
    return {
      agentId: parsed.agentId,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      jobId: parsed.jobId,
      conversationId: parsed.conversationId ?? "",
      after: Number.isFinite(parsed.after) ? Number(parsed.after) : 0,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      manualConfirmation: parsed.manualConfirmation !== false,
    };
  } catch {
    return null;
  }
}

/** Create a durable job and observe it. Stopping closes observation only. */
export async function runAgent(
  agentId: string,
  body: AgentRunBody,
  onEvent: AgentEventHandler,
): Promise<() => void> {
  const controller = new AbortController();

  void (async () => {
    try {
      const { displayMessage, ...requestBody } = body;
      const resp = await fetch(`${apiBase}/api/app/agents/${agentId}/jobs`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!resp.ok) throw await readApiError(resp);
      const responseBody = await resp.json() as {
        data?: { job_id?: string; conversation_id?: string };
        job_id?: string;
        conversation_id?: string;
      };
      const created = responseBody.data ?? responseBody;
      if (!created.job_id) throw new Error("Agent job response missing job_id");

      const job: ActiveAgentJob = {
        agentId,
        ...(body.project_id ? { projectId: body.project_id } : {}),
        jobId: created.job_id,
        conversationId: created.conversation_id ?? "",
        after: 0,
        message: displayMessage?.trim() || body.message,
        manualConfirmation: body.manual_confirmation !== false,
      };
      saveActiveJob(job);
      if (job.conversationId) onEvent({ type: "conversation", data: { id: job.conversationId } });
      await observeAgentJob(job, onEvent, controller.signal);
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        onEvent({ type: "error", data: { message: agentConnectionError(err) } });
      }
    }
  })();

  return () => controller.abort();
}

export async function resumeAgentJob(
  job: ActiveAgentJob,
  onEvent: AgentEventHandler,
): Promise<() => void> {
  const controller = new AbortController();
  // The component state containing thoughts/tool cards is intentionally
  // ephemeral. Rebuild it from the durable event log after a reload or panel
  // close; events through the saved cursor are marked as replayed so canvas
  // mutations are shown but not executed twice.
  const replayThrough = job.after;
  void observeAgentJob({ ...job, after: 0 }, onEvent, controller.signal, replayThrough).catch((err: unknown) => {
    if ((err as Error).name !== "AbortError") {
      onEvent({ type: "error", data: { message: agentConnectionError(err), job_id: job.jobId } });
    }
  });
  return () => controller.abort();
}

async function observeAgentJob(
  initialJob: ActiveAgentJob,
  onEvent: AgentEventHandler,
  signal: AbortSignal,
  replayThrough = 0,
) {
  const job = { ...initialJob };
  let terminal = false;
  let sawFinalMessage = false;
  let consecutiveFailures = 0;
  let reconnecting = false;
  const streamController = new AbortController();
  const stopStream = () => streamController.abort();
  signal.addEventListener("abort", stopStream, { once: true });

  const completeFromState = (state: AgentJobState): boolean => {
    if (state.status !== "success" && state.status !== "error" && state.status !== "cancelled") return false;
    if (terminal) return true;
    terminal = true;
    if (state.status === "success") {
      if (!sawFinalMessage && state.final_reply?.trim()) {
        sawFinalMessage = true;
        onEvent({ type: "message", data: { content: state.final_reply } });
      }
      onEvent({ type: "done", data: { steps: state.steps ?? 0 } });
    } else {
      onEvent({
        type: "error",
        data: { message: safeFailureMessage(state.error_message) || (state.status === "cancelled" ? "任务已取消" : "智能体任务执行失败，未记录详细原因"), job_id: job.jobId },
      });
    }
    streamController.abort();
    return true;
  };

  // Independent status watchdog: even if a proxy/browser loses the final SSE
  // frame while keeping the socket open, the UI leaves “思考中” as soon as the
  // durable row becomes terminal.
  const watchdog = window.setInterval(() => {
    if (terminal || signal.aborted) return;
    void getAgentJobState(job.jobId, signal)
      .then(completeFromState)
      .catch(() => { /* the stream reconnect loop handles availability */ });
  }, 2000);

  try {
    while (!terminal && !signal.aborted) {
      try {
        const resp = await fetch(
          `${apiBase}/api/app/agent-jobs/${job.jobId}/events?after=${job.after}`,
          { credentials: "include", signal: streamController.signal },
        );
        if (!resp.ok) throw await readApiError(resp);
        if (!resp.body) throw new Error("No response body");
        if (reconnecting) {
          onEvent({ type: "connection_status", data: { state: "connected", attempts: consecutiveFailures } });
          reconnecting = false;
        }
        consecutiveFailures = 0;

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted && !terminal) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          let pendingDeltaType: "thought_delta" | "message_delta" | null = null;
          let pendingDeltaText = "";
          const flushDelta = () => {
            if (!pendingDeltaType || !pendingDeltaText) return;
            onEvent(pendingDeltaType === "thought_delta"
              ? { type: "thought_delta", data: { delta: pendingDeltaText } }
              : { type: "message_delta", data: { delta: pendingDeltaText } });
            pendingDeltaType = null;
            pendingDeltaText = "";
          };
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const parsed = parseSSEFrame(frame);
            if (!parsed) continue;
            if (parsed.id > job.after) {
              job.after = parsed.id;
              saveActiveJob(job);
            }
            if (parsed.event.type === "thought_delta" || parsed.event.type === "message_delta") {
              if (pendingDeltaType !== parsed.event.type) {
                flushDelta();
                pendingDeltaType = parsed.event.type;
              }
              pendingDeltaText += parsed.event.data.delta;
              continue;
            }
            flushDelta();
            if (parsed.event.type === "message") sawFinalMessage = true;
            if (parsed.event.type === "error") {
              parsed.event.data.message = safeFailureMessage(parsed.event.data.message) || "智能体任务执行失败，未记录详细原因";
              parsed.event.data.job_id = job.jobId;
            }
            onEvent(parsed.event, { id: parsed.id, replayed: parsed.id <= replayThrough });
            if (parsed.event.type === "done" || parsed.event.type === "error") {
              terminal = true;
              streamController.abort();
            }
          }
          flushDelta();
        }
        if (!terminal && !signal.aborted) {
          const state = await getAgentJobState(job.jobId, signal);
          if (!completeFromState(state)) await waitBeforeReconnect(signal);
        }
      } catch (err: unknown) {
        if (terminal || signal.aborted) break;
        // Authentication/permission failures cannot be repaired by reconnecting.
        // Preserve the saved job: the server may still be executing it.
        if (err instanceof ApiClientError && [401, 403, 404].includes(err.status)) throw err;
        consecutiveFailures += 1;
        try {
          if (completeFromState(await getAgentJobState(job.jobId, signal))) break;
        } catch { /* retry below */ }
        if (!reconnecting) {
          reconnecting = true;
          onEvent({ type: "connection_status", data: { state: "reconnecting", attempts: consecutiveFailures } });
        }
        if ((err as Error).name !== "AbortError") {
          await waitBeforeReconnect(signal, Math.min(5000, 700 * (2 ** Math.min(consecutiveFailures - 1, 3))));
        }
      }
    }
  } finally {
    window.clearInterval(watchdog);
    signal.removeEventListener("abort", stopStream);
    if (terminal) clearActiveJob(job.agentId, job.projectId ?? "", job.jobId);
  }
}

async function getAgentJobState(jobId: string, signal: AbortSignal): Promise<AgentJobState> {
  const resp = await fetch(`${apiBase}/api/app/agent-jobs/${jobId}`, {
    credentials: "include",
    signal,
  });
  if (!resp.ok) throw await readApiError(resp);
  const responseBody = await resp.json() as { data?: AgentJobState } & Partial<AgentJobState>;
  const body = responseBody.data ?? responseBody;
  return {
    status: body.status ?? "",
    final_reply: body.final_reply,
    error_message: body.error_message,
    steps: body.steps,
  };
}

function agentConnectionError(error: unknown): string {
  if (error instanceof ApiClientError) return toUserMessage(error, "zh");
  if (error instanceof TypeError) return "无法连接 Agent 服务，请检查网络连接。";
  return "Agent 连接异常，未收到有效的任务响应，请重试。";
}

function waitBeforeReconnect(signal: AbortSignal, delayMs = 700) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseSSEFrame(frame: string): { id: number; event: AgentSSEEvent } | null {
  let id = 0;
  let eventName = "";
  let dataLine = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
    else if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  if (!eventName) return null;
  try {
    const data = dataLine ? JSON.parse(dataLine) : {};
    return { id, event: { type: eventName as AgentSSEEventType, data } as AgentSSEEvent };
  } catch {
    return null;
  }
}
