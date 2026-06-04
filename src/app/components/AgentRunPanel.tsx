import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, X, Send, Loader2, Wrench, MessageSquare, Sparkles, Square } from "lucide-react";

import type { Edge, Node } from "@xyflow/react";

import { runAgent, type AgentSSEEvent } from "../api/agent-run";
import { listAgents, type Agent } from "../api/skills";
import { useStore } from "../store";

/**
 * Floating Agent Run panel — anchored bottom-right of the canvas.
 *
 * Lets the user pick an agent and type a goal; streams the agent's
 * thinking / tool calls / final message inline, and applies canvas_patch
 * events directly to the React Flow store so the canvas updates live.
 */
export function AgentRunPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const language = useStore((s) => s.language);
  const zh = language === "zh";
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const addNode = useStore((s) => s.addNode);
  const onConnect = useStore((s) => s.onConnect);
  const updateNodeData = useStore((s) => s.updateNodeData);
  const runNode = useStore((s) => s.runNode);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [events, setEvents] = useState<AgentSSEEvent[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void listAgents().then((rows) => {
      setAgents(rows);
      if (rows.length > 0 && !selectedId) setSelectedId(rows[0].id);
    }).catch(() => {});
  }, [open, selectedId]);

  // Auto-scroll to the latest event.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events]);

  const applyPatch = useCallback((event: AgentSSEEvent) => {
    if (event.type !== "canvas_patch") return;
    const patch = event.data;
    switch (patch.op) {
      case "add_node": {
        addNode(patch.node as Node);
        break;
      }
      case "add_edge": {
        const e = patch.edge as Edge;
        onConnect({
          source: e.source, target: e.target,
          sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
        });
        break;
      }
      case "patch_node_data": {
        updateNodeData(patch.node_id, patch.patch);
        break;
      }
      case "run_node": {
        // Pull current prompt draft for the node and submit.
        const node = useStore.getState().nodes.find((n) => n.id === patch.node_id);
        const data = (node?.data ?? {}) as Record<string, string>;
        const prompt = data.promptDraft ?? data.content ?? "";
        if (prompt.trim()) {
          runNode(patch.node_id, { prompt });
        }
        break;
      }
    }
  }, [addNode, onConnect, updateNodeData, runNode]);

  const start = async () => {
    if (!selectedId || !message.trim() || running) return;
    setEvents([]);
    setRunning(true);
    abortRef.current = await runAgent(
      selectedId,
      { message: message.trim(), nodes: nodes as unknown[], edges: edges as unknown[] },
      (event) => {
        setEvents((prev) => [...prev, event]);
        applyPatch(event);
        if (event.type === "done" || event.type === "error") {
          setRunning(false);
          abortRef.current = null;
        }
      },
    );
  };

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
    setRunning(false);
  };

  if (!open) return null;

  return (
    <div className="absolute bottom-6 right-6 z-40 flex h-[560px] w-[420px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15181d]/95 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-cyan-300" />
          <span className="text-sm font-medium text-neutral-100">{zh ? "智能体" : "Agent"}</span>
        </div>
        <button onClick={onClose} className="text-neutral-500 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="border-b border-white/8 px-4 py-2">
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={running}
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-neutral-200 outline-none disabled:opacity-50"
        >
          {agents.length === 0 ? <option value="">{zh ? "暂无可用智能体" : "No agents available"}</option> : null}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {events.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-neutral-500">
            {zh ? "告诉智能体你想做什么，它会调用工具操控画布。" : "Tell the agent what to do — it can manipulate the canvas via tools."}
          </div>
        ) : null}
        {events.map((ev, idx) => <EventRow key={idx} event={ev} zh={zh} />)}
        {running ? <div className="flex items-center gap-2 text-xs text-cyan-300"><Loader2 className="h-3 w-3 animate-spin" /> {zh ? "思考中…" : "Thinking…"}</div> : null}
      </div>

      <div className="border-t border-white/8 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void start(); } }}
            placeholder={zh ? "例：为右边的产品图生成 3 个不同角度的视频" : "e.g. Generate 3 video variants for the product image on the right"}
            rows={2}
            className="flex-1 rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none focus:border-cyan-400/40 resize-none"
            disabled={running}
          />
          {running ? (
            <button onClick={stop} className="flex h-8 w-8 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25">
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              onClick={() => void start()}
              disabled={!message.trim() || !selectedId}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/40 disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EventRow({ event, zh }: { event: AgentSSEEvent; zh: boolean }) {
  if (event.type === "message") {
    return (
      <div className="rounded-lg border border-white/8 bg-white/[0.03] p-2.5">
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-500">
          <MessageSquare className="h-3 w-3" /> {zh ? "回复" : "reply"}
        </div>
        <div className="mt-1 whitespace-pre-wrap text-xs text-neutral-200">{event.data.content}</div>
      </div>
    );
  }
  if (event.type === "message_delta") {
    // Final reply is rendered as a full "message" event after deltas finish;
    // deltas are stored individually so we don't double-render them here.
    return <span className="text-xs text-neutral-300">{event.data.delta}</span>;
  }
  if (event.type === "thought") {
    return (
      <div className="text-xs text-neutral-400">
        <Sparkles className="mr-1 inline h-3 w-3 text-amber-300" />
        {event.data.content}
      </div>
    );
  }
  if (event.type === "tool_call") {
    return (
      <div className="rounded border border-cyan-400/15 bg-cyan-500/[0.05] p-2 text-[11px]">
        <div className="flex items-center gap-1 text-cyan-300">
          <Wrench className="h-3 w-3" /> {event.data.name}
        </div>
        <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[10px] text-neutral-400">{event.data.arguments}</pre>
      </div>
    );
  }
  if (event.type === "tool_result") {
    return (
      <div className={`pl-3 text-[10px] ${event.data.ok ? "text-neutral-500" : "text-rose-300"}`}>
        ↳ {event.data.ok ? (event.data.result ?? "ok") : (event.data.error ?? "error")}
      </div>
    );
  }
  if (event.type === "canvas_patch") {
    const op = (event.data as { op: string }).op;
    return <div className="pl-3 text-[10px] text-emerald-300/80">✓ canvas: {op}</div>;
  }
  if (event.type === "error") {
    return (
      <div className="rounded border border-rose-400/20 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
        {event.data.message}
      </div>
    );
  }
  if (event.type === "done") {
    return <div className="text-[10px] text-emerald-300/70">{zh ? `完成 · 共 ${event.data.steps} 步` : `done · ${event.data.steps} steps`}</div>;
  }
  return null;
}
