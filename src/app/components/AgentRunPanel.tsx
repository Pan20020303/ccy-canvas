import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Send, Sparkles, Square, Wrench, X } from "lucide-react";

import type { Edge, Node } from "@xyflow/react";

import { runAgent, type AgentSSEEvent } from "../api/agent-run";
import {
  clearAgentConversationHistory as clearPersistedConversationHistory,
  listAgentConversationHistory,
  listAgents,
  listSkills,
  type Agent,
  type Skill,
} from "../api/skills";
import { useStore } from "../store";
import {
  clearAgentConversationHistory,
  conversationTurnsFromHistoryItems,
  getAgentConversationHistory,
  recordAgentConversationTurn,
  type AgentConversationStore,
} from "./agent-conversation";
import { buildAgentRunMessage, getBoundSlashSkills } from "./agent-skill-commands";
import { getSkillCommandName } from "./settings/skill-agent-presenters";

const HISTORY_LIMIT = 12;

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
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [events, setEvents] = useState<AgentSSEEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [activeSkillName, setActiveSkillName] = useState<string | null>(null);
  const [conversationStore, setConversationStore] = useState<AgentConversationStore>({});
  const [loadedHistoryIds, setLoadedHistoryIds] = useState<Record<string, true>>({});
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    void Promise.all([listAgents(), listSkills()])
      .then(([agentRows, skillRows]) => {
        setAgents(agentRows);
        setSkills(skillRows);
        if (agentRows.length > 0 && !selectedId) {
          setSelectedId(agentRows[0].id);
        }
      })
      .catch(() => {});
  }, [open, selectedId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, selectedId, conversationStore]);

  useEffect(() => {
    if (!selectedId || loadedHistoryIds[selectedId]) {
      return;
    }
    void listAgentConversationHistory(selectedId, HISTORY_LIMIT)
      .then((items) => {
        setConversationStore((prev) => ({
          ...prev,
          [selectedId]: conversationTurnsFromHistoryItems(items),
        }));
        setLoadedHistoryIds((prev) => ({ ...prev, [selectedId]: true }));
      })
      .catch(() => {});
  }, [loadedHistoryIds, selectedId]);

  const selectedAgent = agents.find((agent) => agent.id === selectedId) ?? null;
  const boundSkills = selectedAgent ? getBoundSlashSkills(selectedAgent, skills) : [];
  const conversationHistory = useMemo(
    () => getAgentConversationHistory(conversationStore, selectedId),
    [conversationStore, selectedId],
  );

  const applyPatch = useCallback((event: AgentSSEEvent) => {
    if (event.type !== "canvas_patch") {
      return;
    }
    const patch = event.data;
    switch (patch.op) {
      case "add_node": {
        addNode(patch.node as Node);
        break;
      }
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
      case "patch_node_data": {
        updateNodeData(patch.node_id, patch.patch);
        break;
      }
      case "run_node": {
        const node = useStore.getState().nodes.find((candidate) => candidate.id === patch.node_id);
        const data = (node?.data ?? {}) as Record<string, string>;
        const prompt = data.promptDraft ?? data.content ?? "";
        if (prompt.trim()) {
          runNode(patch.node_id, { prompt });
        }
        break;
      }
    }
  }, [addNode, onConnect, runNode, updateNodeData]);

  const start = async () => {
    if (!selectedId || !message.trim() || running || !selectedAgent) {
      return;
    }

    const rawMessage = message.trim();
    const outbound = buildAgentRunMessage(selectedAgent, skills, message);
    setActiveSkillName(outbound.invokedSkillName);
    setEvents([]);
    setRunning(true);
    abortRef.current = await runAgent(
      selectedId,
      { message: outbound.message, nodes: nodes as unknown[], edges: edges as unknown[], history: conversationHistory },
      (event) => {
        setEvents((prev) => [...prev, event]);
        if (event.type === "message") {
          setConversationStore((prev) => recordAgentConversationTurn(prev, selectedId, rawMessage, event.data.content, HISTORY_LIMIT));
        }
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

  const clearHistory = async () => {
    if (!selectedId) {
      return;
    }
    setConversationStore((prev) => clearAgentConversationHistory(prev, selectedId));
    setLoadedHistoryIds((prev) => ({ ...prev, [selectedId]: true }));
    try {
      await clearPersistedConversationHistory(selectedId);
    } catch {
      // Keep the local state cleared even if the network request fails.
    }
  };

  if (!open) {
    return null;
  }

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
          onChange={(event) => setSelectedId(event.target.value)}
          disabled={running}
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-neutral-200 outline-none disabled:opacity-50"
        >
          {agents.length === 0 ? <option value="">{zh ? "暂无可用智能体" : "No agents available"}</option> : null}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
        {boundSkills.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {boundSkills.map((skill) => (
              <span key={skill.id} className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200">
                {getSkillCommandName(skill)}
              </span>
            ))}
          </div>
        ) : null}
        {conversationHistory.length > 0 ? (
          <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-neutral-500">
            <span>{zh ? `已保留 ${Math.floor(conversationHistory.length / 2)} 轮上下文` : `Keeping ${Math.floor(conversationHistory.length / 2)} prior turns in context`}</span>
            <button
              type="button"
              onClick={() => void clearHistory()}
              className="text-neutral-400 transition hover:text-white"
            >
              {zh ? "清空上下文" : "Clear context"}
            </button>
          </div>
        ) : null}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {activeSkillName ? (
          <div className="rounded-md border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-[11px] text-cyan-100">
            {zh ? `本次已触发技能 ${activeSkillName}` : `Triggered skill ${activeSkillName} for this run`}
          </div>
        ) : null}

        {conversationHistory.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
              {zh ? "上下文记录" : "Context history"}
            </div>
            {conversationHistory.map((turn, index) => (
              <ConversationBubble key={`${turn.role}-${index}`} role={turn.role} content={turn.content} zh={zh} compact />
            ))}
          </div>
        ) : null}

        {events.length === 0 && conversationHistory.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-neutral-500">
            {zh ? "告诉智能体你想做什么；若已绑定技能，也可以直接输入 /技能名 开始。" : "Tell the agent what to do; if skills are bound, you can also start with a slash command."}
          </div>
        ) : null}

        {events.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
              {zh ? "当前运行" : "Current run"}
            </div>
            {events.map((event, index) => <EventRow key={index} event={event} zh={zh} />)}
          </div>
        ) : null}

        {running ? (
          <div className="flex items-center gap-2 text-xs text-cyan-300">
            <Loader2 className="h-3 w-3 animate-spin" />
            {zh ? "思考中..." : "Thinking..."}
          </div>
        ) : null}
      </div>

      <div className="border-t border-white/8 p-3">
        <div className="mb-2 text-[10px] text-neutral-500">
          {boundSkills.length > 0
            ? zh
              ? "示例：/rewrite 把这段产品文案改得更有温度"
              : "Example: /rewrite Make this product copy feel warmer"
            : zh
              ? "这个智能体当前没有绑定 slash 技能"
              : "This agent currently has no bound slash skills"}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void start();
              }
            }}
            placeholder={zh ? "例如：/rewrite 把这段产品文案改得更有温度" : "For example: /rewrite Make this product copy feel warmer"}
            rows={2}
            className="flex-1 resize-none rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none focus:border-cyan-400/40"
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

function ConversationBubble({
  role,
  content,
  zh,
  compact = false,
}: {
  role: "user" | "assistant";
  content: string;
  zh: boolean;
  compact?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={`rounded-lg border p-2.5 ${isUser ? "border-white/10 bg-white/[0.04]" : "border-cyan-400/15 bg-cyan-500/[0.06]"}`}>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
        {isUser ? (zh ? "用户" : "user") : (zh ? "智能体" : "agent")}
      </div>
      <div className={`whitespace-pre-wrap text-neutral-200 ${compact ? "text-[11px]" : "text-xs"}`}>{content}</div>
    </div>
  );
}

function EventRow({ event, zh }: { event: AgentSSEEvent; zh: boolean }) {
  if (event.type === "message") {
    return <ConversationBubble role="assistant" content={event.data.content} zh={zh} />;
  }
  if (event.type === "message_delta") {
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
        -&gt; {event.data.ok ? (event.data.result ?? "ok") : (event.data.error ?? "error")}
      </div>
    );
  }
  if (event.type === "canvas_patch") {
    const op = (event.data as { op: string }).op;
    return <div className="pl-3 text-[10px] text-emerald-300/80">ok canvas: {op}</div>;
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
