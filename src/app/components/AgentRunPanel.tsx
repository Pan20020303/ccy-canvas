import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Copy, Film, Loader2, MessageSquarePlus, MessagesSquare, Music2, Play, Plus, Send, Sparkles, Square, Trash2, User2, Wrench, X } from "lucide-react";
import gsap from "gsap";

import { useMountFadeIn } from "./motion/use-motion";

import type { Edge, Node } from "@xyflow/react";

import { runAgent, type AgentSSEEvent } from "../api/agent-run";
import {
  createAgentConversation,
  deleteAgentConversation,
  listAgentConversationHistory,
  listAgentConversations,
  listAgents,
  listSkills,
  type Agent,
  type AgentConversationSummary,
  type Skill,
} from "../api/skills";
import { useStore } from "../store";
import {
  appendConversationTurn,
  conversationTurnsFromHistoryItems,
  getAgentConversationHistory,
  type AgentConversationStore,
} from "./agent-conversation";
import { buildAgentRunMessage, getAllInvokableSlashSkills, getBoundSlashSkills } from "./agent-skill-commands";
import { getSkillCommandName } from "./settings/skill-agent-presenters";

const HISTORY_LIMIT = 12;
const CONVERSATIONS_KEY = (agentId: string, convId: string) => `${agentId}::${convId}`;

function shouldReduceMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

type ToolInvocation = {
  id: string;
  name: string;
  args: string;
  startedAt: number;
  status: "running" | "success" | "error";
  durationMs?: number;
  output?: string;
};

type RunStep =
  | { kind: "thought"; id: string; content: string }
  | { kind: "tool"; id: string; invocation: ToolInvocation }
  | { kind: "canvas"; id: string; op: string }
  | { kind: "error"; id: string; message: string }
  | {
      kind: "pending_run";
      id: string;
      nodeId: string;
      nodeType: string;
      serviceType: string;
      prompt: string;
      availableModels: string[];
      // Lifecycle: user picks a model → confirmed (we kick off runNode);
      // or skipped (do nothing). Lives in state so the card can show its
      // resolution after the fact.
      status: "pending" | "confirmed" | "skipped";
      chosenModel?: string;
    };

/**
 * Claude-style agent run panel.
 *
 * - User bubbles right, assistant bubbles left.
 * - Tool calls render as compact cards with live elapsed counter while
 *   the call is running; collapse/expand to reveal raw args and result.
 * - Run-level seconds counter at the top.
 * - Thin dark scrollbar matching the rest of the app.
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
  const backendModels = useStore((s) => s.backendModels);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [activeSkillName, setActiveSkillName] = useState<string | null>(null);

  // Conversations live as `${agentId}::${convId}` → turns[]. Switching
  // conversations swaps which key the UI renders.
  const [conversationStore, setConversationStore] = useState<AgentConversationStore>({});
  const [loadedHistoryIds, setLoadedHistoryIds] = useState<Record<string, true>>({});

  // Per-agent: list of all conversation threads + which one is active.
  const [conversationsByAgent, setConversationsByAgent] = useState<Record<string, AgentConversationSummary[]>>({});
  const [activeConversationId, setActiveConversationId] = useState<Record<string, string>>({});
  const [showConversationMenu, setShowConversationMenu] = useState(false);
  const [showAgentMenu, setShowAgentMenu] = useState(false);

  // Per-run streaming state.
  const [streamingReply, setStreamingReply] = useState("");
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runFinishedMs, setRunFinishedMs] = useState<number | null>(null);

  // Slash command picker: opens when the input starts with `/`. Mirrors the
  // Claude / Cursor behavior where typing `/` reveals bound skill templates.
  const [slashIndex, setSlashIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ticking clock so live elapsed counters refresh every 100ms while running.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running && !runSteps.some((s) => s.kind === "tool" && s.invocation.status === "running")) {
      return;
    }
    const id = window.setInterval(() => setTick((t) => t + 1), 100);
    return () => window.clearInterval(id);
  }, [running, runSteps]);

  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);

  // Panel enter animation: slide up + fade in on open. Runs every time the
  // panel mounts (which `open` controls — when closed the whole tree is
  // unmounted so the next open replays the entrance).
  useEffect(() => {
    if (!open || !panelRef.current) return;
    if (shouldReduceMotion()) {
      gsap.set(panelRef.current, { autoAlpha: 1, y: 0, scale: 1 });
      return;
    }
    const tween = gsap.from(panelRef.current, {
      autoAlpha: 0,
      y: 18,
      scale: 0.96,
      duration: 0.32,
      ease: "power3.out",
      clearProps: "transform,opacity,visibility",
    });
    return () => { tween.kill(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void Promise.all([listAgents(), listSkills()])
      .then(([agentRows, skillRows]) => {
        setAgents(agentRows ?? []);
        setSkills(skillRows ?? []);
        if ((agentRows ?? []).length > 0 && !selectedId) {
          setSelectedId(agentRows[0].id);
        }
      })
      .catch(() => {});
  }, [open, selectedId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversationStore, streamingReply, runSteps, selectedId]);

  // Load this agent's conversation list whenever the agent changes. Pick the
  // most recent thread as active (server returns them ordered DESC), or
  // implicitly start a "ghost" empty thread when none exist yet.
  useEffect(() => {
    if (!selectedId) return;
    if (conversationsByAgent[selectedId]) return;
    void listAgentConversations(selectedId)
      .then((rows) => {
        const list = rows ?? [];
        setConversationsByAgent((prev) => ({ ...prev, [selectedId]: list }));
        if (list.length > 0 && !activeConversationId[selectedId]) {
          setActiveConversationId((prev) => ({ ...prev, [selectedId]: list[0].id }));
        }
      })
      .catch(() => {});
  }, [activeConversationId, conversationsByAgent, selectedId]);

  const activeConvId = selectedId ? activeConversationId[selectedId] ?? null : null;
  const conversationKey = selectedId && activeConvId ? CONVERSATIONS_KEY(selectedId, activeConvId) : null;

  // Lazy-load message history per thread.
  useEffect(() => {
    if (!selectedId || !activeConvId || !conversationKey) return;
    if (loadedHistoryIds[conversationKey]) return;
    void listAgentConversationHistory(selectedId, HISTORY_LIMIT, activeConvId)
      .then((items) => {
        setConversationStore((prev) => ({
          ...prev,
          [conversationKey]: conversationTurnsFromHistoryItems(items ?? []),
        }));
        setLoadedHistoryIds((prev) => ({ ...prev, [conversationKey]: true }));
      })
      .catch(() => {});
  }, [activeConvId, conversationKey, loadedHistoryIds, selectedId]);

  const selectedAgent = agents.find((agent) => agent.id === selectedId) ?? null;
  const boundSkills = selectedAgent ? getBoundSlashSkills(selectedAgent, skills) : [];
  const conversationHistory = useMemo(
    () => getAgentConversationHistory(conversationStore, conversationKey),
    [conversationStore, conversationKey],
  );
  const conversations = selectedId ? conversationsByAgent[selectedId] ?? [] : [];

  const selectAgent = useCallback((agentId: string) => {
    if (running) return;
    setSelectedId(agentId);
    setShowAgentMenu(false);
    setShowConversationMenu(false);
    setStreamingReply("");
    setRunSteps([]);
    setRunStartedAt(null);
    setRunFinishedMs(null);
  }, [running]);

  // Slash menu: open when the message looks like `/foo...` and no space has
  // been typed yet. Discovery spans ALL invokable skills (not just bound) so
  // a freshly-imported skill is reachable immediately.
  const allInvokableSkills = useMemo(() => getAllInvokableSlashSkills(skills), [skills]);
  const slashSuggestions = useMemo(() => {
    const trimmed = message.trimStart();
    if (!trimmed.startsWith("/")) return [] as Skill[];
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace >= 0) return [] as Skill[];
    const filter = trimmed.slice(1).toLowerCase();
    return allInvokableSkills.filter((skill) => {
      const command = getSkillCommandName(skill).replace(/^\//, "").toLowerCase();
      const name = skill.name.toLowerCase();
      return command.includes(filter) || name.includes(filter);
    });
  }, [allInvokableSkills, message]);

  const applySlashCompletion = (skill: Skill) => {
    setMessage(getSkillCommandName(skill) + " ");
    setSlashIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const applyPatch = useCallback((event: AgentSSEEvent) => {
    if (event.type !== "canvas_patch") return;
    const patch = event.data;
    switch (patch.op) {
      case "add_node": {
        // Belt-and-braces: ensure `.data` exists so node renderers don't crash
        // when the agent (or an upstream serializer) omitted the field.
        const incoming = patch.node as Node;
        const safe: Node = {
          ...incoming,
          data: (incoming.data ?? {}) as Record<string, unknown>,
        };
        addNode(safe);
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
      case "patch_node_data":
        updateNodeData(patch.node_id, patch.patch);
        break;
      case "run_node": {
        const node = useStore.getState().nodes.find((candidate) => candidate.id === patch.node_id);
        const data = (node?.data ?? {}) as Record<string, string>;
        const prompt = data.promptDraft ?? data.content ?? "";
        if (!prompt.trim()) break;

        const serviceTypeMap: Record<string, string> = {
          textNode: "text",
          imageNode: "image",
          videoNode: "video",
          audioNode: "audio",
        };
        const serviceType = serviceTypeMap[node?.type ?? ""] ?? "text";

        // Aggregate every model the user has configured, regardless of which
        // provider's service_type it belongs to. Users may want to override
        // and try a model from a different family — we surface them all and
        // let them choose. Models from the matching service_type sort first
        // so the natural default is at the top.
        const allConfiguredModels: string[] = [];
        const seen = new Set<string>();
        const matchFirst = [...backendModels].sort((a, b) => {
          const aMatch = a.service_type === serviceType ? 0 : 1;
          const bMatch = b.service_type === serviceType ? 0 : 1;
          return aMatch - bMatch;
        });
        for (const cfg of matchFirst) {
          for (const m of cfg.model_list ?? []) {
            if (!seen.has(m)) {
              seen.add(m);
              allConfiguredModels.push(m);
            }
          }
        }

        const matchingProvider = backendModels.find((cfg) => cfg.service_type === serviceType);
        const fallbackModel = matchingProvider?.default_model
          ?? matchingProvider?.model_list?.[0]
          ?? allConfiguredModels[0]
          ?? "";

        if (allConfiguredModels.length === 0) {
          setRunSteps((prev) => [...prev, {
            kind: "error",
            id: `runerr-${prev.length}`,
            message: "无法运行：还没有任何模型配置，请到「管理后台 → 模型配置」添加。",
          }]);
          break;
        }

        // Expensive media (video / audio) needs human approval before kicking
        // off — pop a confirmation card with model picker. Image and text
        // auto-run since they're fast and cheap.
        const needsConfirmation = serviceType === "video" || serviceType === "audio";
        if (needsConfirmation) {
          setRunSteps((prev) => [...prev, {
            kind: "pending_run",
            id: `pending-${prev.length}`,
            nodeId: patch.node_id,
            nodeType: node?.type ?? "",
            serviceType,
            prompt,
            availableModels: allConfiguredModels,
            status: "pending",
            chosenModel: data.model || fallbackModel,
          }]);
        } else {
          const model = data.model || fallbackModel;
          runNode(patch.node_id, { prompt, model });
        }
        break;
      }
    }
  }, [addNode, onConnect, runNode, updateNodeData]);

  const start = async () => {
    if (!selectedId || !message.trim() || running || !selectedAgent) return;

    const rawMessage = message.trim();
    const outbound = buildAgentRunMessage(selectedAgent, skills, message);
    const targetAgentId = selectedId;

    // The active conversation id may be null on a fresh agent panel (no
    // conversations exist yet) — backend will create one and emit the new
    // id back as a `conversation` SSE event, which we apply on the fly.
    let runConversationId = activeConvId;
    const initialKey = runConversationId
      ? CONVERSATIONS_KEY(targetAgentId, runConversationId)
      : null;

    // Push the user bubble immediately into whichever bucket we're rendering.
    if (initialKey) {
      setConversationStore((prev) => ({
        ...prev,
        [initialKey]: appendConversationTurn(prev[initialKey] ?? [], "user", rawMessage, HISTORY_LIMIT),
      }));
    }
    setMessage("");
    setActiveSkillName(outbound.invokedSkillName);
    setStreamingReply("");
    setRunSteps([]);
    const startedAt = performance.now();
    setRunStartedAt(startedAt);
    setRunFinishedMs(null);
    setRunning(true);

    const priorHistory = conversationHistory;

    // Tracks the "current bucket key" for callbacks; updated if the server
    // hands us a brand-new conversation id mid-flight.
    let currentKey = initialKey;

    abortRef.current = await runAgent(
      targetAgentId,
      {
        message: outbound.message,
        nodes: nodes as unknown[],
        edges: edges as unknown[],
        history: priorHistory,
        conversation_id: runConversationId ?? undefined,
      },
      (event) => {
        switch (event.type) {
          case "conversation": {
            const newId = event.data.id;
            const newKey = CONVERSATIONS_KEY(targetAgentId, newId);
            if (runConversationId !== newId) {
              runConversationId = newId;
              setActiveConversationId((prev) => ({ ...prev, [targetAgentId]: newId }));
              // Migrate the user bubble we optimistically pushed under a
              // null key into the now-known conversation bucket.
              if (!currentKey) {
                setConversationStore((prev) => ({
                  ...prev,
                  [newKey]: appendConversationTurn(prev[newKey] ?? [], "user", rawMessage, HISTORY_LIMIT),
                }));
              }
              currentKey = newKey;
            }
            break;
          }
          case "message_delta":
            setStreamingReply((prev) => prev + event.data.delta);
            break;
          case "message": {
            const finalText = event.data.content;
            setStreamingReply("");
            if (currentKey) {
              setConversationStore((prev) => ({
                ...prev,
                [currentKey!]: appendConversationTurn(prev[currentKey!] ?? [], "assistant", finalText, HISTORY_LIMIT),
              }));
            }
            // Refresh the conversation list so the title/count auto-update.
            void listAgentConversations(targetAgentId)
              .then((rows) => setConversationsByAgent((prev) => ({ ...prev, [targetAgentId]: rows ?? [] })))
              .catch(() => {});
            break;
          }
          case "thought":
            setRunSteps((prev) => [...prev, {
              kind: "thought",
              id: `thought-${prev.length}`,
              content: event.data.content,
            }]);
            break;
          case "tool_call":
            setRunSteps((prev) => [...prev, {
              kind: "tool",
              id: `tool-${prev.length}`,
              invocation: {
                id: `tool-${prev.length}`,
                name: event.data.name,
                args: event.data.arguments,
                startedAt: performance.now(),
                status: "running",
              },
            }]);
            break;
          case "tool_result":
            setRunSteps((prev) => {
              // Finalize the latest running tool invocation.
              for (let i = prev.length - 1; i >= 0; i--) {
                const step = prev[i];
                if (step.kind === "tool" && step.invocation.status === "running") {
                  const inv = step.invocation;
                  const updated: RunStep = {
                    ...step,
                    invocation: {
                      ...inv,
                      status: event.data.ok ? "success" : "error",
                      durationMs: performance.now() - inv.startedAt,
                      output: event.data.ok ? (event.data.result ?? "") : (event.data.error ?? ""),
                    },
                  };
                  const next = prev.slice();
                  next[i] = updated;
                  return next;
                }
              }
              return prev;
            });
            break;
          case "canvas_patch":
            setRunSteps((prev) => [...prev, {
              kind: "canvas",
              id: `canvas-${prev.length}`,
              op: (event.data as { op: string }).op,
            }]);
            applyPatch(event);
            break;
          case "error":
            setRunSteps((prev) => [...prev, {
              kind: "error",
              id: `err-${prev.length}`,
              message: event.data.message,
            }]);
            setRunning(false);
            setRunFinishedMs(performance.now() - startedAt);
            abortRef.current = null;
            break;
          case "done":
            setRunning(false);
            setRunFinishedMs(performance.now() - startedAt);
            abortRef.current = null;
            break;
        }
      },
    );
  };

  const submitWithMotion = () => {
    if (sendButtonRef.current && !shouldReduceMotion()) {
      gsap.fromTo(
        sendButtonRef.current,
        { scale: 0.84, rotation: -10 },
        {
          scale: 1,
          rotation: 0,
          duration: 0.46,
          ease: "elastic.out(1, 0.55)",
          overwrite: "auto",
          clearProps: "transform",
        },
      );
    }
    void start();
  };

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
    setRunning(false);
    if (runStartedAt != null) {
      setRunFinishedMs(performance.now() - runStartedAt);
    }
  };

  // Pending-run card handlers — confirm fires the actual generation, skip
  // discards it, and updatePendingModel lets the user pick a different model
  // before they confirm.
  const confirmPendingRun = (stepId: string) => {
    setRunSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === stepId);
      if (idx < 0) return prev;
      const step = prev[idx];
      if (step.kind !== "pending_run" || step.status !== "pending") return prev;
      const model = step.chosenModel ?? step.availableModels[0] ?? "";
      if (!model) return prev;
      // Side-effect: actually trigger the run.
      runNode(step.nodeId, { prompt: step.prompt, model });
      const next = prev.slice();
      next[idx] = { ...step, status: "confirmed", chosenModel: model };
      return next;
    });
  };

  const skipPendingRun = (stepId: string) => {
    setRunSteps((prev) => prev.map((s) => {
      if (s.id !== stepId || s.kind !== "pending_run" || s.status !== "pending") return s;
      return { ...s, status: "skipped" };
    }));
  };

  const updatePendingModel = (stepId: string, model: string) => {
    setRunSteps((prev) => prev.map((s) => {
      if (s.id !== stepId || s.kind !== "pending_run") return s;
      return { ...s, chosenModel: model };
    }));
  };

  // Start a brand-new chat thread, leaving the prior one intact in the list.
  const newChat = async () => {
    if (!selectedId) return;
    setShowConversationMenu(false);
    setStreamingReply("");
    setRunSteps([]);
    setRunStartedAt(null);
    setRunFinishedMs(null);
    try {
      const created = await createAgentConversation(selectedId, "");
      setConversationsByAgent((prev) => ({
        ...prev,
        [selectedId]: [created, ...(prev[selectedId] ?? [])],
      }));
      setActiveConversationId((prev) => ({ ...prev, [selectedId]: created.id }));
      const key = CONVERSATIONS_KEY(selectedId, created.id);
      setConversationStore((prev) => ({ ...prev, [key]: [] }));
      setLoadedHistoryIds((prev) => ({ ...prev, [key]: true }));
    } catch {
      // surface a silent failure; user can retry from the same button
    }
  };

  // Switch to an existing thread.
  const switchToConversation = (cid: string) => {
    if (!selectedId) return;
    setActiveConversationId((prev) => ({ ...prev, [selectedId]: cid }));
    setStreamingReply("");
    setRunSteps([]);
    setRunStartedAt(null);
    setRunFinishedMs(null);
    setShowConversationMenu(false);
  };

  const removeConversation = async (cid: string) => {
    if (!selectedId) return;
    try {
      await deleteAgentConversation(selectedId, cid);
    } catch {
      return;
    }
    setConversationsByAgent((prev) => {
      const remaining = (prev[selectedId] ?? []).filter((c) => c.id !== cid);
      return { ...prev, [selectedId]: remaining };
    });
    const key = CONVERSATIONS_KEY(selectedId, cid);
    setConversationStore((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    if (activeConvId === cid) {
      const remaining = (conversationsByAgent[selectedId] ?? []).filter((c) => c.id !== cid);
      setActiveConversationId((prev) => ({ ...prev, [selectedId]: remaining[0]?.id ?? "" }));
    }
  };

  const handleClose = useCallback(() => {
    if (!panelRef.current || shouldReduceMotion()) {
      onClose();
      return;
    }
    gsap.to(panelRef.current, {
      autoAlpha: 0,
      y: 14,
      scale: 0.985,
      duration: 0.18,
      ease: "power2.in",
      overwrite: "auto",
      onComplete: onClose,
    });
  }, [onClose]);

  if (!open) return null;

  const hasAnyContent = conversationHistory.length > 0 || streamingReply || runSteps.length > 0;

  // Live elapsed of the current run.
  const liveElapsedMs = runStartedAt != null
    ? (runFinishedMs ?? (performance.now() - runStartedAt))
    : 0;
  void tick; // depend on tick so React re-renders the counters

  return (
    <div
      ref={panelRef}
      className="absolute bottom-6 right-6 z-40 flex h-[680px] w-[560px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15181d]/95 shadow-2xl backdrop-blur-xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-cyan-300" />
          <span className="text-sm font-medium text-neutral-100">{zh ? "智能体" : "Agent"}</span>
          {runStartedAt != null ? (
            <span className={`ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] tabular-nums ${
              running ? "bg-cyan-500/15 text-cyan-200" : "bg-white/[0.04] text-neutral-400"
            }`}>
              {running ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : null}
              {formatElapsed(liveElapsedMs)}
            </span>
          ) : null}
        </div>
        <button onClick={handleClose} className="text-neutral-500 transition hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Agent picker + conversation switcher */}
      <div className="relative border-b border-white/8 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <AgentPicker
            agents={agents}
            selectedId={selectedId}
            selectedAgent={selectedAgent}
            open={showAgentMenu}
            disabled={running}
            zh={zh}
            onToggle={() => {
              if (running) return;
              setShowConversationMenu(false);
              setShowAgentMenu((value) => !value);
            }}
            onPick={selectAgent}
            onClose={() => setShowAgentMenu(false)}
          />
          <select
            value={selectedId ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
            disabled
            aria-hidden="true"
            tabIndex={-1}
            className="hidden"
          >
            {agents.length === 0 ? <option value="">{zh ? "暂无可用智能体" : "No agents available"}</option> : null}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setShowAgentMenu(false);
              setShowConversationMenu((v) => !v);
            }}
            disabled={running || !selectedId}
            className="flex items-center gap-1.5 rounded border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-white/5 disabled:opacity-40"
            title={zh ? "切换会话" : "Switch conversation"}
          >
            <MessagesSquare className="h-3 w-3" />
            <span className="max-w-[110px] truncate">
              {currentConversationTitle(conversations, activeConvId, zh)}
            </span>
            <ChevronDown className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => void newChat()}
            disabled={running || !selectedId}
            className="flex items-center gap-1 rounded border border-cyan-400/30 bg-cyan-500/10 px-2 py-1.5 text-[11px] text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40"
            title={zh ? "新建会话" : "New chat"}
          >
            <MessageSquarePlus className="h-3 w-3" />
          </button>
        </div>
        {boundSkills.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {boundSkills.map((skill) => (
              <span key={skill.id} className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200">
                {getSkillCommandName(skill)}
              </span>
            ))}
          </div>
        ) : null}

        {showConversationMenu ? (
          <ConversationMenu
            conversations={conversations}
            activeId={activeConvId}
            onPick={switchToConversation}
            onDelete={(cid) => void removeConversation(cid)}
            onClose={() => setShowConversationMenu(false)}
            onNew={() => void newChat()}
            zh={zh}
          />
        ) : null}
      </div>

      {/* Conversation scroll area */}
      <div
        ref={scrollRef}
        // Stop wheel from bubbling up to ReactFlow (which would zoom the
        // canvas) so users can scroll the chat naturally.
        onWheel={(event) => event.stopPropagation()}
        className="prompt-editor-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {activeSkillName ? (
          <div className="rounded-md border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-[11px] text-cyan-100">
            {zh ? `本次已触发技能 ${activeSkillName}` : `Triggered skill ${activeSkillName}`}
          </div>
        ) : null}

        {!hasAnyContent ? (
          <div className="flex h-full items-center justify-center text-center text-xs text-neutral-500">
            {zh
              ? "告诉智能体你想做什么；若已绑定技能，也可以直接输入 /技能名 开始。"
              : "Tell the agent what to do; if skills are bound, you can also start with a slash command."}
          </div>
        ) : null}

        {conversationHistory.map((turn, index) => (
          <ChatBubble key={`turn-${index}`} role={turn.role} content={turn.content} />
        ))}

        {/* Per-run steps surface between the last user turn and the streaming reply. */}
        {runSteps.length > 0 ? (
          <div className="space-y-2 pl-9">
            {runSteps.map((step) => (
              <RunStepRow
                key={step.id}
                step={step}
                tick={tick}
                zh={zh}
                onConfirmRun={confirmPendingRun}
                onSkipRun={skipPendingRun}
                onPickModel={updatePendingModel}
              />
            ))}
          </div>
        ) : null}

        {streamingReply ? (
          <ChatBubble role="assistant" content={streamingReply} streaming />
        ) : running && runSteps.length === 0 ? (
          <div className="flex items-center gap-2 pl-9 text-xs text-cyan-300">
            <Loader2 className="h-3 w-3 animate-spin" />
            {zh ? "思考中…" : "Thinking…"}
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <div className="relative border-t border-white/8 p-3">
        {/* Slash command popup — appears when the message starts with `/`. */}
        {slashSuggestions.length > 0 ? (
          <SlashMenu
            suggestions={slashSuggestions}
            activeIndex={slashIndex}
            onPick={(skill) => applySlashCompletion(skill)}
            zh={zh}
          />
        ) : null}
        <div className="mb-1.5 text-[10px] text-neutral-500">
          {allInvokableSkills.length > 0
            ? zh ? `输入 / 唤出技能（共 ${allInvokableSkills.length} 个）` : `Type / to invoke a skill (${allInvokableSkills.length} available)`
            : zh ? "暂无可用技能 — 去「设置 → 我的技能」新建或导入一个" : "No skills installed — open Settings → Skills to create or import one"}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setSlashIndex(0);
            }}
            onKeyDown={(event) => {
              // Slash menu keyboard navigation takes precedence.
              if (slashSuggestions.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((i) => (i + 1) % slashSuggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                  event.preventDefault();
                  applySlashCompletion(slashSuggestions[slashIndex]);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMessage("");
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitWithMotion();
              }
            }}
            placeholder={zh ? "输入消息，/ 唤出技能，Enter 发送，Shift+Enter 换行" : "Type a message, / for skills, Enter to send"}
            rows={3}
            onWheel={(event) => event.stopPropagation()}
            className="prompt-editor-scroll flex-1 resize-none rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-neutral-100 outline-none transition focus:border-cyan-400/40"
            disabled={running}
          />
          {running ? (
            <button onClick={stop} className="flex h-10 w-10 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25" title={zh ? "停止" : "Stop"}>
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              ref={sendButtonRef}
              onClick={submitWithMotion}
              disabled={!message.trim() || !selectedId}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-500/20 text-cyan-200 transition hover:bg-cyan-500/40 disabled:opacity-40"
              title={zh ? "发送" : "Send"}
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentPicker({
  agents,
  selectedId,
  selectedAgent,
  open,
  disabled,
  zh,
  onToggle,
  onPick,
  onClose,
}: {
  agents: Agent[];
  selectedId: string | null;
  selectedAgent: Agent | null;
  open: boolean;
  disabled: boolean;
  zh: boolean;
  onToggle: () => void;
  onPick: (agentId: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof globalThis.Node && !rootRef.current.contains(event.target)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !menuRef.current || shouldReduceMotion()) return;
    const ctx = gsap.context(() => {
      const items = menuRef.current?.querySelectorAll("[data-agent-picker-item]");
      gsap.fromTo(
        menuRef.current,
        { autoAlpha: 0, y: 8, scale: 0.98 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.22,
          ease: "power3.out",
          clearProps: "transform,opacity,visibility",
        },
      );
      if (items?.length) {
        gsap.fromTo(
          items,
          { autoAlpha: 0, x: -6 },
          {
            autoAlpha: 1,
            x: 0,
            duration: 0.18,
            ease: "power2.out",
            stagger: 0.035,
            delay: 0.03,
            clearProps: "transform,opacity,visibility",
          },
        );
      }
    }, menuRef);
    return () => ctx.revert();
  }, [open]);

  const selectedModel = selectedAgent?.model || "";

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs outline-none transition ${
          open
            ? "border-cyan-400/35 bg-cyan-500/10 text-cyan-100 shadow-[0_0_0_1px_rgba(34,211,238,0.12)]"
            : "border-white/10 bg-black/30 text-neutral-200 hover:border-white/18 hover:bg-white/[0.04]"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Bot className={`h-3.5 w-3.5 shrink-0 ${selectedAgent?.enabled === false ? "text-neutral-500" : "text-cyan-300"}`} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{selectedAgent?.name || (zh ? "选择智能体" : "Select agent")}</span>
            {selectedModel ? <span className="block truncate text-[10px] text-neutral-500">{selectedModel}</span> : null}
          </span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-neutral-500 transition ${open ? "rotate-180 text-cyan-300" : ""}`} />
      </button>

      {open ? (
        <div
          ref={menuRef}
          className="prompt-editor-scroll absolute left-0 right-0 top-[calc(100%+8px)] z-[60] max-h-[280px] overflow-y-auto rounded-xl border border-white/10 bg-[#171a20]/98 p-1.5 shadow-2xl shadow-black/45 backdrop-blur-xl"
        >
          {agents.length === 0 ? (
            <div className="px-3 py-3 text-center text-[11px] text-neutral-500">
              {zh ? "暂无可用智能体" : "No agents available"}
            </div>
          ) : null}
          {agents.map((agent) => {
            const active = agent.id === selectedId;
            const model = agent.model || "";
            return (
              <button
                key={agent.id}
                type="button"
                data-agent-picker-item
                onClick={() => onPick(agent.id)}
                className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                  active ? "bg-cyan-500/15 text-cyan-100" : "text-neutral-300 hover:bg-white/[0.05] hover:text-neutral-100"
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${
                  agent.enabled ? (active ? "bg-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.45)]" : "bg-emerald-400/80") : "bg-neutral-600"
                }`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{agent.name}</span>
                  <span className="block truncate text-[10px] text-neutral-500">
                    {model || (zh ? "未配置模型" : "No model configured")}
                  </span>
                </span>
                {active ? <Check className="h-3.5 w-3.5 shrink-0 text-cyan-300" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ChatBubble({
  role,
  content,
  streaming = false,
}: {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  // Mount animation: user bubbles slide in from the right, assistant from
  // the left, both fade-in. Keeps the visual rhythm of a real chat.
  const bubbleRef = useMountFadeIn<HTMLDivElement>(
    isUser ? { opacity: 0, x: 18 } : { opacity: 0, x: -18 },
    { duration: 0.26 },
  );
  if (isUser) {
    return (
      <div ref={bubbleRef} className="group flex items-start justify-end gap-2">
        <div className="flex max-w-[78%] flex-col items-end">
          <div className="rounded-2xl rounded-tr-sm bg-cyan-500/20 px-3.5 py-2.5 text-sm text-neutral-100 ring-1 ring-cyan-400/20">
            <div className="whitespace-pre-wrap break-words">{content}</div>
          </div>
          <BubbleActions content={content} align="end" />
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 ring-1 ring-cyan-400/30">
          <User2 className="h-3.5 w-3.5 text-cyan-200" />
        </div>
      </div>
    );
  }
  return (
    <div ref={bubbleRef} className="group flex items-start gap-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.06] ring-1 ring-white/10">
        <Bot className="h-3.5 w-3.5 text-neutral-300" />
      </div>
      <div className="flex max-w-[78%] flex-col items-start">
        <div className="rounded-2xl rounded-tl-sm bg-white/[0.04] px-3.5 py-2.5 text-sm text-neutral-100 ring-1 ring-white/8">
          <div className="whitespace-pre-wrap break-words">
            {content}
            {streaming ? <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-cyan-300" /> : null}
          </div>
        </div>
        {!streaming ? <BubbleActions content={content} align="start" /> : null}
      </div>
    </div>
  );
}

function BubbleActions({ content, align }: { content: string; align: "start" | "end" }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // Fall back to a hidden textarea so older browsers / non-secure
      // contexts (http://localhost) without the Clipboard API still work.
      const textarea = document.createElement("textarea");
      textarea.value = content;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand("copy"); } catch { /* swallowed */ }
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`mt-1 flex items-center gap-1 opacity-0 transition group-hover:opacity-100 ${align === "end" ? "self-end" : "self-start"}`}>
      <button
        type="button"
        onClick={() => void copy()}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-white/5 hover:text-neutral-200"
        title={copied ? "已复制" : "复制"}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        <span>{copied ? "已复制" : "复制"}</span>
      </button>
    </div>
  );
}

function RunStepRow({
  step,
  tick,
  zh,
  onConfirmRun,
  onSkipRun,
  onPickModel,
}: {
  step: RunStep;
  tick: number;
  zh: boolean;
  onConfirmRun: (stepId: string) => void;
  onSkipRun: (stepId: string) => void;
  onPickModel: (stepId: string, model: string) => void;
}) {
  void tick;
  if (step.kind === "thought") {
    return (
      <div className="flex items-start gap-1.5 text-[11px] text-neutral-400">
        <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" />
        <span className="leading-relaxed">{step.content}</span>
      </div>
    );
  }
  if (step.kind === "tool") {
    return <ToolInvocationCard invocation={step.invocation} zh={zh} />;
  }
  if (step.kind === "canvas") {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-emerald-300/80">
        <span className="h-1 w-1 rounded-full bg-emerald-400/80" />
        {zh ? `画布操作 · ${step.op}` : `canvas · ${step.op}`}
      </div>
    );
  }
  if (step.kind === "pending_run") {
    return (
      <PendingRunCard
        step={step}
        zh={zh}
        onConfirm={() => onConfirmRun(step.id)}
        onSkip={() => onSkipRun(step.id)}
        onPickModel={(model) => onPickModel(step.id, model)}
      />
    );
  }
  return (
    <div className="rounded border border-rose-400/20 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
      {step.message}
    </div>
  );
}

function PendingRunCard({
  step,
  zh,
  onConfirm,
  onSkip,
  onPickModel,
}: {
  step: Extract<RunStep, { kind: "pending_run" }>;
  zh: boolean;
  onConfirm: () => void;
  onSkip: () => void;
  onPickModel: (model: string) => void;
}) {
  const isVideo = step.serviceType === "video";
  const Icon = isVideo ? Film : Music2;
  const typeLabel = isVideo ? (zh ? "视频生成" : "Video generation") : (zh ? "音频生成" : "Audio generation");

  if (step.status === "skipped") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] text-neutral-500">
        <Icon className="h-3.5 w-3.5" />
        {zh ? `已跳过 · ${typeLabel}` : `Skipped · ${typeLabel}`}
      </div>
    );
  }
  if (step.status === "confirmed") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-500/[0.06] px-3 py-2 text-[11px] text-emerald-200">
        <Icon className="h-3.5 w-3.5" />
        {zh ? `已运行 · ${typeLabel} · ${step.chosenModel}` : `Started · ${typeLabel} · ${step.chosenModel}`}
      </div>
    );
  }

  const currentModel = step.chosenModel ?? step.availableModels[0] ?? "";
  const cardRef = useMountFadeIn<HTMLDivElement>({ opacity: 0, y: 8, scale: 0.97 }, { duration: 0.3 });
  return (
    <div ref={cardRef} className="rounded-lg border border-amber-400/30 bg-amber-500/[0.06] p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-200">
        <Icon className="h-3.5 w-3.5" />
        {zh ? `等待确认 · ${typeLabel}` : `Awaiting confirmation · ${typeLabel}`}
      </div>
      <div className="mt-1.5 max-h-16 overflow-hidden text-[11px] leading-5 text-neutral-300">
        {step.prompt.length > 160 ? step.prompt.slice(0, 160) + "…" : step.prompt}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <label className="text-[10px] uppercase tracking-wider text-neutral-500">{zh ? "模型" : "Model"}</label>
        <select
          value={currentModel}
          onChange={(e) => onPickModel(e.target.value)}
          className="flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-amber-400/40"
          title={zh ? "可以选择任意已配置的模型" : "Pick any configured model"}
        >
          {step.availableModels.map((m, idx) => (
            <option key={`${m}-${idx}`} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onSkip}
          className="rounded px-2.5 py-1 text-[11px] text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
        >
          {zh ? "跳过" : "Skip"}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!currentModel}
          className="flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-500/20 px-3 py-1 text-[11px] font-medium text-amber-100 transition hover:bg-amber-500/30 disabled:opacity-40"
        >
          <Play className="h-3 w-3" />
          {zh ? "运行" : "Run"}
        </button>
      </div>
    </div>
  );
}

function ToolInvocationCard({ invocation, zh }: { invocation: ToolInvocation; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const running = invocation.status === "running";
  const elapsedMs = running
    ? performance.now() - invocation.startedAt
    : (invocation.durationMs ?? 0);

  const statusTone = running
    ? "border-cyan-400/30 bg-cyan-500/[0.06]"
    : invocation.status === "success"
      ? "border-emerald-400/25 bg-emerald-500/[0.05]"
      : "border-rose-400/25 bg-rose-500/[0.06]";

  const statusDot = running
    ? "bg-cyan-300 animate-pulse"
    : invocation.status === "success"
      ? "bg-emerald-400"
      : "bg-rose-400";

  const friendlyName = humanizeToolName(invocation.name, zh);
  const cardRef = useMountFadeIn<HTMLDivElement>({ opacity: 0, y: 4, scale: 0.98 }, { duration: 0.22 });

  return (
    <div ref={cardRef} className={`overflow-hidden rounded-lg border ${statusTone}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {expanded ? <ChevronDown className="h-3 w-3 text-neutral-400" /> : <ChevronRight className="h-3 w-3 text-neutral-400" />}
        <Wrench className="h-3 w-3 text-neutral-300" />
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot}`} />
        <span className="flex-1 truncate text-[11px] font-medium text-neutral-200">
          {friendlyName}
          <span className="ml-1.5 font-mono text-[10px] text-neutral-500">{invocation.name}</span>
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-neutral-400">
          {formatElapsed(elapsedMs)}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-white/[0.04] bg-black/20 px-2.5 py-2 text-[10px]">
          {invocation.args ? (
            <div>
              <div className="mb-1 uppercase tracking-wider text-neutral-500">{zh ? "入参" : "args"}</div>
              <pre className="prompt-editor-scroll max-h-32 overflow-auto whitespace-pre-wrap font-mono text-neutral-300">{invocation.args}</pre>
            </div>
          ) : null}
          {invocation.output ? (
            <div className="mt-2">
              <div className={`mb-1 uppercase tracking-wider ${invocation.status === "error" ? "text-rose-300" : "text-neutral-500"}`}>
                {invocation.status === "error" ? (zh ? "错误" : "error") : (zh ? "返回" : "result")}
              </div>
              <pre className={`prompt-editor-scroll max-h-32 overflow-auto whitespace-pre-wrap font-mono ${invocation.status === "error" ? "text-rose-200" : "text-neutral-300"}`}>{invocation.output}</pre>
            </div>
          ) : null}
          {running ? <div className="text-neutral-500">{zh ? "执行中…" : "Running…"}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// Maps canvas/skill tool names to a short human-friendly label.
// Falls back to the raw name when no mapping exists (e.g. user-defined skills).
function humanizeToolName(name: string, zh: boolean): string {
  const en: Record<string, string> = {
    list_nodes: "List nodes",
    find_nodes: "Find nodes",
    read_node: "Read node",
    create_node: "Create node",
    connect_nodes: "Connect nodes",
    set_prompt: "Set prompt",
    run_node: "Run node",
    move_node: "Move node",
    delete_node: "Delete node",
    create_group: "Create group",
  };
  const cn: Record<string, string> = {
    list_nodes: "列出节点",
    find_nodes: "查找节点",
    read_node: "读取节点",
    create_node: "新建节点",
    connect_nodes: "连接节点",
    set_prompt: "设置提示词",
    run_node: "运行节点",
    move_node: "移动节点",
    delete_node: "删除节点",
    create_group: "创建组",
  };
  const dict = zh ? cn : en;
  return dict[name] ?? name;
}

function SlashMenu({
  suggestions,
  activeIndex,
  onPick,
  zh,
}: {
  suggestions: Skill[];
  activeIndex: number;
  onPick: (skill: Skill) => void;
  zh: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuRef.current || shouldReduceMotion()) return;
    const ctx = gsap.context(() => {
      const items = menuRef.current?.querySelectorAll("[data-slash-menu-item]");
      gsap.fromTo(
        menuRef.current,
        { autoAlpha: 0, y: 10, scale: 0.985 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.2,
          ease: "power3.out",
          clearProps: "transform,opacity,visibility",
        },
      );
      if (items?.length) {
        gsap.fromTo(
          items,
          { autoAlpha: 0, y: 4 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.16,
            ease: "power2.out",
            stagger: 0.025,
            clearProps: "transform,opacity,visibility",
          },
        );
      }
    }, menuRef);
    return () => ctx.revert();
  }, []);

  return (
    <div ref={menuRef} className="prompt-editor-scroll absolute bottom-[110px] left-3 right-3 z-50 max-h-[280px] overflow-y-auto rounded-lg border border-white/10 bg-[#1a1d23]/98 p-1.5 shadow-2xl backdrop-blur-xl">
      <div className="px-2.5 pb-1 pt-1 text-[10px] uppercase tracking-wider text-neutral-500">
        {zh ? "技能" : "Skills"}
      </div>
      {suggestions.map((skill, idx) => {
        const isActive = idx === activeIndex;
        return (
          <button
            key={skill.id}
            type="button"
            data-slash-menu-item
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(skill);
            }}
            className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-xs transition ${
              isActive ? "bg-cyan-500/15 text-cyan-100" : "text-neutral-300 hover:bg-white/[0.04]"
            }`}
          >
            <Sparkles className={`mt-0.5 h-3 w-3 shrink-0 ${isActive ? "text-cyan-300" : "text-neutral-500"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`font-mono text-[11px] ${isActive ? "text-cyan-200" : "text-cyan-300"}`}>
                  {getSkillCommandName(skill)}
                </span>
                <span className="truncate text-[11px]">{skill.name}</span>
              </div>
              {skill.description ? (
                <div className="mt-0.5 truncate text-[10px] text-neutral-500">{skill.description}</div>
              ) : null}
            </div>
          </button>
        );
      })}
      <div className="border-t border-white/[0.04] px-2.5 pt-1.5 text-[10px] text-neutral-500">
        {zh ? "↑↓ 选择 · Enter / Tab 插入 · Esc 关闭" : "↑↓ navigate · Enter / Tab insert · Esc dismiss"}
      </div>
    </div>
  );
}

function ConversationMenu({
  conversations,
  activeId,
  onPick,
  onDelete,
  onClose,
  onNew,
  zh,
}: {
  conversations: AgentConversationSummary[];
  activeId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onNew: () => void;
  zh: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof globalThis.Node && !rootRef.current.contains(e.target)) onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    if (!rootRef.current || shouldReduceMotion()) return;
    const ctx = gsap.context(() => {
      const rows = rootRef.current?.querySelectorAll("[data-conversation-row]");
      gsap.fromTo(
        rootRef.current,
        { autoAlpha: 0, y: 8, scale: 0.985 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.22,
          ease: "power3.out",
          clearProps: "transform,opacity,visibility",
        },
      );
      if (rows?.length) {
        gsap.fromTo(
          rows,
          { autoAlpha: 0, x: 6 },
          {
            autoAlpha: 1,
            x: 0,
            duration: 0.16,
            ease: "power2.out",
            stagger: 0.025,
            clearProps: "transform,opacity,visibility",
          },
        );
      }
    }, rootRef);
    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={rootRef}
      className="prompt-editor-scroll absolute right-4 top-[58px] z-50 max-h-[360px] w-[300px] overflow-y-auto rounded-lg border border-white/10 bg-[#1a1d23]/98 p-1.5 shadow-2xl backdrop-blur-xl"
    >
      <button
        type="button"
        onClick={onNew}
        className="mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-cyan-200 hover:bg-cyan-500/10"
      >
        <Plus className="h-3.5 w-3.5" />
        {zh ? "新建会话" : "New chat"}
      </button>
      {conversations.length === 0 ? (
        <div className="px-2.5 py-3 text-center text-[11px] text-neutral-500">
          {zh ? "暂无历史会话" : "No conversations yet"}
        </div>
      ) : null}
      {conversations.map((c) => {
        const isActive = c.id === activeId;
        return (
          <div
            key={c.id}
            data-conversation-row
            className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition ${
              isActive ? "bg-white/[0.06] text-neutral-100" : "text-neutral-300 hover:bg-white/[0.03]"
            }`}
          >
            <button
              type="button"
              onClick={() => onPick(c.id)}
              className="flex min-w-0 flex-1 flex-col items-start text-left"
            >
              <span className="w-full truncate">
                {c.title || (zh ? "未命名会话" : "Untitled chat")}
              </span>
              <span className="mt-0.5 text-[10px] text-neutral-500">
                {c.message_count} {zh ? "条消息" : "msgs"} · {formatRelative(c.updated_at, zh)}
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!confirm(zh ? "删除这个会话？" : "Delete this conversation?")) return;
                onDelete(c.id);
              }}
              className="opacity-0 transition group-hover:opacity-100 text-neutral-500 hover:text-rose-300"
              title={zh ? "删除" : "Delete"}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function currentConversationTitle(conversations: AgentConversationSummary[], activeId: string | null, zh: boolean): string {
  if (!activeId) return zh ? "新会话" : "New chat";
  const found = conversations.find((c) => c.id === activeId);
  if (!found) return zh ? "新会话" : "New chat";
  return found.title || (zh ? "未命名会话" : "Untitled chat");
}

function formatRelative(iso: string, zh: boolean): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diffSec = Math.max(0, (Date.now() - ts) / 1000);
  if (diffSec < 60) return zh ? "刚刚" : "just now";
  if (diffSec < 3600) return zh ? `${Math.floor(diffSec / 60)} 分钟前` : `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return zh ? `${Math.floor(diffSec / 3600)} 小时前` : `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return zh ? `${Math.floor(diffSec / 86400)} 天前` : `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m${rs}s`;
}
