import { useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Bot, Send, Square } from "lucide-react";
import clsx from "clsx";

import type { Edge, Node } from "@xyflow/react";

import { runAgent, type AgentSSEEvent } from "../../api/agent-run";
import {
  listAgentConversationHistory,
  listAgents,
  listSkills,
  type Agent,
  type Skill,
} from "../../api/skills";
import { useStore } from "../../store";
import {
  conversationTurnsFromHistoryItems,
  completeAgentConversationTurn,
  type AgentConversationTurn,
} from "../agent-conversation";
import { buildAgentRunMessage, getBoundSlashSkills } from "../agent-skill-commands";
import { getSkillCommandName } from "../settings/skill-agent-presenters";

const HISTORY_LIMIT = 12;

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
  const [skills, setSkills] = useState<Skill[]>([]);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentSSEEvent[]>([]);
  const [activeSkillName, setActiveSkillName] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<AgentConversationTurn[]>([]);
  const [loadedHistoryAgentId, setLoadedHistoryAgentId] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void Promise.all([listAgents(), listSkills()])
      .then(([agentRows, skillRows]) => {
        setAgents(agentRows);
        setSkills(skillRows);
      })
      .catch(() => {});
  }, []);

  const agentId: string = data.agentId ?? "";
  const goal: string = data.goal ?? "";
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === agentId), [agents, agentId]);
  const boundSkills = selectedAgent ? getBoundSlashSkills(selectedAgent, skills) : [];

  useEffect(() => {
    if (!agentId || loadedHistoryAgentId === agentId) {
      return;
    }
    void listAgentConversationHistory(agentId, HISTORY_LIMIT)
      .then((items) => {
        setConversationHistory(conversationTurnsFromHistoryItems(items));
        setLoadedHistoryAgentId(agentId);
      })
      .catch(() => {});
  }, [agentId, loadedHistoryAgentId]);

  const start = async () => {
    if (!agentId || !goal.trim() || running || !selectedAgent) {
      return;
    }

    const rawGoal = goal.trim();
    const outbound = buildAgentRunMessage(selectedAgent, skills, goal);
    setActiveSkillName(outbound.invokedSkillName);
    setEvents([]);
    setRunning(true);
    abortRef.current = await runAgent(
      agentId,
      { message: outbound.message, nodes: nodes as unknown[], edges: edges as unknown[], history: conversationHistory },
      (event) => {
        setEvents((prev) => [...prev, event]);
        if (event.type === "message") {
          setConversationHistory((prev) => completeAgentConversationTurn(prev, rawGoal, event.data.content, HISTORY_LIMIT));
        }
        if (event.type === "canvas_patch") {
          const patch = event.data;
          switch (patch.op) {
            case "add_node":
              addNode(patch.node as Node);
              break;
            case "add_edge": {
              const edge = patch.edge as Edge;
              onConnect({
                source: edge.source,
                target: edge.target,
                sourceHandle: edge.sourceHandle ?? null,
                targetHandle: edge.targetHandle ?? null,
              });
              break;
            }
            case "patch_node_data":
              updateNd(patch.node_id, patch.patch);
              break;
            case "run_node": {
              const node = useStore.getState().nodes.find((candidate) => candidate.id === patch.node_id);
              const nodeData = (node?.data ?? {}) as Record<string, string>;
              const prompt = nodeData.promptDraft ?? nodeData.content ?? "";
              if (prompt.trim()) {
                runNd(patch.node_id, { prompt });
              }
              break;
            }
          }
        }
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

  return (
    <div className={clsx("group w-[340px]")}>
      <div className="mb-2 flex items-center gap-1.5 pl-1 text-[11px] text-neutral-400">
        <Bot className="h-3 w-3 shrink-0" />
        <div className="min-w-0 truncate">{selectedAgent?.name ?? (zh ? "智能体节点" : "Agent")}</div>
      </div>
      <div
        className={clsx(
          "relative overflow-hidden rounded-[22px] border bg-[#15181d]/95 backdrop-blur-xl",
          selected ? "border-cyan-400/40" : "border-white/10",
        )}
      >
        <div className="space-y-2 p-3">
          <select
            value={agentId}
            onChange={(event) => {
              setLoadedHistoryAgentId(null);
              setConversationHistory([]);
              updateNodeData(id, { agentId: event.target.value });
            }}
            disabled={running}
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-neutral-200 outline-none"
          >
            <option value="">{zh ? "选择智能体..." : "Pick an agent..."}</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          {boundSkills.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {boundSkills.map((skill) => (
                <span key={skill.id} className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200">
                  {getSkillCommandName(skill)}
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            value={goal}
            onChange={(event) => updateNodeData(id, { goal: event.target.value })}
            disabled={running}
            rows={3}
            placeholder={zh ? "例如：/rewrite 把这段产品文案改得更有温度" : "For example: /rewrite Make this product copy feel warmer"}
            className="nodrag w-full resize-none rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
          />
          {activeSkillName ? (
            <div className="rounded-md border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1.5 text-[10px] text-cyan-100">
              {zh ? `本次已触发 ${activeSkillName}` : `Triggered ${activeSkillName} for this run`}
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <div className="text-[10px] text-neutral-500">
              {boundSkills.length > 0
                ? (zh ? "支持直接输入 /技能名" : "Supports /skill-name input")
                : (zh ? "未绑定 slash 技能" : "No slash skills bound")}
              {conversationHistory.length > 0 ? (
                <div>{zh ? `已保留 ${Math.floor(conversationHistory.length / 2)} 轮上下文` : `Keeping ${Math.floor(conversationHistory.length / 2)} prior turns`}</div>
              ) : null}
            </div>
            {running ? (
              <button onClick={stop} className="flex items-center gap-1 rounded-full bg-rose-500/20 px-3 py-1 text-xs text-rose-200 hover:bg-rose-500/30">
                <Square className="h-3 w-3" /> {zh ? "停止" : "Stop"}
              </button>
            ) : (
              <button
                onClick={start}
                disabled={!agentId || !goal.trim()}
                className="flex items-center gap-1 rounded-full bg-cyan-500/20 px-3 py-1 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-40"
              >
                <Send className="h-3 w-3" /> {zh ? "运行" : "Run"}
              </button>
            )}
          </div>
        </div>
        {conversationHistory.length > 0 ? (
          <div className="border-t border-white/8 bg-black/15 px-3 py-2 text-[10px] text-neutral-300">
            <div className="mb-1 uppercase tracking-[0.18em] text-neutral-500">{zh ? "最近上下文" : "Recent context"}</div>
            <div className="space-y-1">
              {conversationHistory.slice(-4).map((turn, index) => (
                <div key={`${turn.role}-${index}`} className="rounded border border-white/6 bg-white/[0.03] px-2 py-1">
                  <span className="mr-1 text-neutral-500">{turn.role === "user" ? (zh ? "用户：" : "User:") : (zh ? "智能体：" : "Agent:")}</span>
                  <span className="whitespace-pre-wrap">{turn.content}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {events.length > 0 ? (
          <div className="max-h-[160px] space-y-1 overflow-y-auto border-t border-white/8 bg-black/20 p-2 text-[10px] text-neutral-400">
            {events.slice(-12).map((event, index) => <Tiny key={index} event={event} />)}
          </div>
        ) : null}
      </div>
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-white/20 !bg-cyan-400" />
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-white/20 !bg-cyan-400" />
    </div>
  );
}

function Tiny({ event }: { event: AgentSSEEvent }) {
  switch (event.type) {
    case "tool_call":
      return <div className="text-cyan-300">tool {event.data.name}</div>;
    case "tool_result":
      return <div className={event.data.ok ? "text-neutral-500" : "text-rose-300"}>-&gt; {event.data.ok ? "ok" : event.data.error}</div>;
    case "message":
      return <div className="whitespace-pre-wrap text-emerald-300">ok {event.data.content}</div>;
    case "thought":
      return <div className="text-amber-200">... {event.data.content}</div>;
    case "error":
      return <div className="text-rose-300">err {event.data.message}</div>;
    case "done":
      return <div className="text-emerald-400/70">done · {event.data.steps} steps</div>;
    default:
      return null;
  }
}
