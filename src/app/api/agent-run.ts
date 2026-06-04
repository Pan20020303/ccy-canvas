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

export type AgentSSEEventType =
  | "thought" | "tool_call" | "tool_result"
  | "message" | "canvas_patch" | "error" | "done";

export type AgentSSEEvent =
  | { type: "thought";      data: { content: string } }
  | { type: "tool_call";    data: { id: string; name: string; arguments: string } }
  | { type: "tool_result";  data: { id: string; name: string; ok: boolean; result?: string; error?: string } }
  | { type: "message";      data: { content: string } }
  | { type: "canvas_patch"; data: CanvasPatch }
  | { type: "error";        data: { message: string } }
  | { type: "done";         data: { steps: number } };

export type CanvasPatch =
  | { op: "add_node";        node: Node }
  | { op: "add_edge";        edge: Edge }
  | { op: "patch_node_data"; node_id: string; patch: Record<string, unknown> }
  | { op: "run_node";        node_id: string };

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

/**
 * Open a streaming connection to an agent run. The callback is invoked
 * synchronously for each SSE event as it arrives. The returned function
 * aborts the in-flight request (use it when the user closes the panel).
 */
export async function runAgent(
  agentId: string,
  body: { message: string; nodes: unknown[]; edges: unknown[] },
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
