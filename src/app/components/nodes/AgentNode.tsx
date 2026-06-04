import { useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Bot, Loader2, Play, Send, Square } from "lucide-react";
import clsx from "clsx";

import type { Edge, Node } from "@xyflow/react";

import { listAgents, type Agent } from "../../api/skills";
import { runAgent, type AgentSSEEvent } from "../../api/agent-run";
import { useStore } from "../../store";

/**
 * AgentNode — an agent embodied as a canvas node. The user picks an agent and
 * a goal directly on the node; the agent's stream is shown in-place, and any
 * canvas_patch events apply to the live React Flow graph just like the
 * floating panel.
 */
export function AgentNode({ id, data, selected }: any) {
  const language = useStore((s) => s.language);
  const zh = language === "zh";
  const updateNodeData = useStore((s) => s.updateNodeData);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const addNode = useStore((s) => s.addNode);
  const onConnect = useStore((s) => s.onConnect);
  const updateNd = useStore((s) => s.updateNodeData);
  const runNd = useStore((s) => s.runNode);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentSSEEvent[]>([]);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void listAgents().then(setAgents).catch(() => {});
  }, []);

  const agentId: string = data.agentId ?? "";
  const goal: string = data.goal ?? "";
  const selectedAgent = useMemo(() => agents.find((a) => a.id === agentId), [agents, agentId]);

  const start = async () => {
    if (!agentId || !goal.trim() || running) return;
    setEvents([]);
    setRunning(true);
    abortRef.current = await runAgent(agentId, { message: goal.trim(), nodes: nodes as unknown[], edges: edges as unknown[] }, (ev) => {
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "canvas_patch") {
        const p = ev.data;
        switch (p.op) {
          case "add_node": addNode(p.node as Node); break;
          case "add_edge": {
            const e = p.edge as Edge;
            onConnect({ source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null });
            break;
          }
          case "patch_node_data": updateNd(p.node_id, p.patch); break;
          case "run_node": {
            const n = useStore.getState().nodes.find((x) => x.id === p.node_id);
            const d = (n?.data ?? {}) as Record<string, string>;
            const prompt = d.promptDraft ?? d.content ?? "";
            if (prompt.trim()) runNd(p.node_id, { prompt });
            break;
          }
        }
      }
      if (ev.type === "done" || ev.type === "error") {
        setRunning(false);
        abortRef.current = null;
      }
    });
  };

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
    setRunning(false);
  };

  return (
    <div className={clsx("group w-[340px]")}>
      <div className="mb-2 flex items-center gap-1.5 pl-1 text-[11px] text-neutral-400">
        <Bot className="h-3 w-3 shrink-0" />
        <div className="min-w-0 truncate">{selectedAgent?.name ?? (zh ? "智能体节点" : "Agent")}</div>
      </div>
      <div className={clsx(
        "relative overflow-hidden rounded-[22px] border bg-[#15181d]/95 backdrop-blur-xl",
        selected ? "border-cyan-400/40" : "border-white/10",
      )}>
        <div className="p-3 space-y-2">
          <select
            value={agentId}
            onChange={(e) => updateNodeData(id, { agentId: e.target.value })}
            disabled={running}
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-neutral-200 outline-none"
          >
            <option value="">{zh ? "选择智能体…" : "Pick an agent…"}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <textarea
            value={goal}
            onChange={(e) => updateNodeData(id, { goal: e.target.value })}
            disabled={running}
            rows={3}
            placeholder={zh ? "目标 / 任务描述" : "Goal / task description"}
            className="nodrag w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none resize-none"
          />
          <div className="flex justify-end">
            {running ? (
              <button onClick={stop} className="flex items-center gap-1 rounded-full bg-rose-500/20 px-3 py-1 text-xs text-rose-200 hover:bg-rose-500/30">
                <Square className="h-3 w-3" /> {zh ? "停止" : "Stop"}
              </button>
            ) : (
              <button onClick={start} disabled={!agentId || !goal.trim()}
                className="flex items-center gap-1 rounded-full bg-cyan-500/20 px-3 py-1 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-40">
                <Send className="h-3 w-3" /> {zh ? "运行" : "Run"}
              </button>
            )}
          </div>
        </div>
        {events.length > 0 ? (
          <div className="max-h-[160px] overflow-y-auto border-t border-white/8 bg-black/20 p-2 text-[10px] text-neutral-400 space-y-1">
            {events.slice(-12).map((ev, i) => <Tiny key={i} event={ev} />)}
          </div>
        ) : null}
      </div>
      <Handle type="target" position={Position.Left}  className="!w-3 !h-3 !bg-cyan-400 !border-white/20" />
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-cyan-400 !border-white/20" />
    </div>
  );
}

function Tiny({ event }: { event: AgentSSEEvent }) {
  switch (event.type) {
    case "tool_call":   return <div className="text-cyan-300">▸ {event.data.name}</div>;
    case "tool_result": return <div className={event.data.ok ? "text-neutral-500" : "text-rose-300"}>↳ {event.data.ok ? "ok" : event.data.error}</div>;
    case "message":     return <div className="text-emerald-300 whitespace-pre-wrap">✓ {event.data.content}</div>;
    case "thought":     return <div className="text-amber-200">… {event.data.content}</div>;
    case "error":       return <div className="text-rose-300">✗ {event.data.message}</div>;
    case "done":        return <div className="text-emerald-400/70">done · {event.data.steps} steps</div>;
    default:            return null;
  }
}
