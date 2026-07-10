/**
 * Streaming agent runner — talks to POST /api/app/agents/:id/run via SSE.
 *
 * The browser sends:
 *   { message, nodes, edges }    // current canvas snapshot
 * and receives a stream of events:
 *   thought / tool_call / tool_result / message / canvas_patch / error / done
 *
 * `canvas_patch` events are applied to the local Zustand store directly so
 * the agent's mutations show up live (new nodes, new edges, prompt drafts).
 */

import type { Edge, Node } from "@xyflow/react";
import type { AgentConversationTurn } from "../components/agent-conversation";

export type AgentSSEEventType =
  | "thought" | "thought_delta" | "tool_call" | "tool_result"
  | "message" | "message_delta" | "canvas_patch"
  | "conversation" | "ask_user" | "usage" | "error" | "done";

export type AgentSSEEvent =
  | { type: "thought";       data: { content: string } }
  // 思考流:reasoning token 实时推送(deepseek/qwen 思考模型)——思考块流式增长。
  | { type: "thought_delta"; data: { delta: string } }
  | { type: "tool_call";     data: { id: string; name: string; arguments: string } }
  | { type: "tool_result";   data: { id: string; name: string; ok: boolean; result?: string; error?: string } }
  | { type: "message_delta"; data: { delta: string } }
  | { type: "message";       data: { content: string } }
  | { type: "canvas_patch";  data: CanvasPatch }
  | { type: "conversation";  data: { id: string } }
  | { type: "ask_user";      data: { question: string; options: string[]; allow_custom?: boolean } }
  // 每轮 LLM 调用后的 token 用量(最近一轮,prompt 已含全部历史)——驱动上下文窗口计量表。
  | { type: "usage";         data: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: "error";         data: { message: string } }
  | { type: "done";          data: { steps: number } };

export type CanvasPatch =
  | { op: "add_node";        node: Node }
  | { op: "add_edge";        edge: Edge }
  | { op: "patch_node_data"; node_id: string; patch: Record<string, unknown> }
  // model:agent 经 run_node(model=...) 指定生成模型(编排图片/视频生成)。
  | { op: "run_node";        node_id: string; model?: string };

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

/**
 * Open a streaming connection to an agent run. The callback is invoked
 * synchronously for each SSE event as it arrives. The returned function
 * aborts the in-flight request (use it when the user closes the panel).
 */
export async function runAgent(
  agentId: string,
  body: {
    message: string;
    nodes: unknown[];
    edges: unknown[];
    history?: AgentConversationTurn[];
    conversation_id?: string;
    model?: string;
    /** 当前项目 id:后端用它做记忆隔离域(每个项目的智能体记忆互相独立)。 */
    project_id?: string;
    /** 可用生成模型清单(image/video/audio)。注入 system prompt,
     *  让 agent 能挑模型并经 run_node(model=...) 编排生成。 */
    generation_models?: Record<string, string[]>;
    /** 深度思考开关(composer「深度思考」按钮)。省略=按模型默认;
     *  仅对思考类模型生效(后端按模型名 gate)。 */
    thinking?: boolean;
  },
  onEvent: (event: AgentSSEEvent) => void,
): Promise<() => void> {
  const controller = new AbortController();
  const url = `${apiBase}/api/app/agents/${agentId}/run`;

  // Fire-and-forget so the caller can cancel via the returned abort fn.
  (async () => {
    try {
      const resp = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text();
        onEvent({ type: "error", data: { message: `HTTP ${resp.status}: ${text.slice(0, 200)}` } });
        return;
      }
      if (!resp.body) {
        onEvent({ type: "error", data: { message: "No response body" } });
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frame separator is `\n\n`. Process whole frames; keep tail.
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSSEFrame(frame);
          if (parsed) onEvent(parsed);
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") return;
      onEvent({ type: "error", data: { message: (err as Error).message } });
    }
  })();

  return () => controller.abort();
}

function parseSSEFrame(frame: string): AgentSSEEvent | null {
  let eventName = "";
  let dataLine = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  if (!eventName) return null;
  try {
    const data = dataLine ? JSON.parse(dataLine) : {};
    return { type: eventName as AgentSSEEventType, data } as AgentSSEEvent;
  } catch {
    return null;
  }
}
