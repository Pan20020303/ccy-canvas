import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Bot, BrainCircuit, Check, ChevronDown, ChevronLeft, ChevronRight, Cpu, Film, GitBranch, Hand, ImageIcon, Loader2, MessageSquarePlus, MessagesSquare, Mic, Music2, PanelLeft, Play, Plus, Sparkles, Square, Trash2, Wrench, X, Zap } from "lucide-react";
import gsap from "gsap";

import { useMountFadeIn } from "./motion/use-motion";

import type { Edge, Node } from "@xyflow/react";

import {
  advanceCanvasPatchRevision,
  getActiveAgentJob,
  resumeAgentJob,
  runAgent,
  type AgentEventMeta,
  type AgentSSEEvent,
  type CanvasPatch,
} from "../api/agent-run";
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
  presentAgentUserInput,
  type AgentConversationStore,
} from "./agent-conversation";
import { buildAgentRunMessage, getAllInvokableSlashSkills } from "./agent-skill-commands";
import {
  buildQuestionnaireReply,
  firstUnansweredQuestionIndex,
  selectQuestionAnswer,
  type AgentQuestionPage,
} from "./agent-questionnaire";
import { getSkillCommandName } from "./settings/skill-agent-presenters";
import { displayNameOf, getCurrentUser } from "../api/me";
import { toRenderableMediaUrl } from "../reference-media";
import { ModelBrandIcon } from "./ModelBrandIcon";
import { SkillLibraryDialog, SkillQuickPicker } from "./SkillLibrary";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { getRotatingSkillBatch, getSkillDisplayName } from "../skill-display";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AgentThread, AgentThreadList, useAgentThreadRuntime } from "./agent/AgentAssistantThread";
import { getModelTemplate, isThinkingCapableModel, isThinkingDefaultOn } from "../model-templates";
import { pickVisionModel } from "./nodes/director-blocking";
import { getProviderModelDisplayName, getProviderModelPresentation } from "../api/providerConfigs";
import { presentCanvasOperation, type CanvasOperationEntity } from "./agent/canvas-operation-presenter";
import { GenerationBatch } from "./agent/generation-batch";

// 从服务器拉取的历史轮数(后端上限 50)。
const HISTORY_FETCH_LIMIT = 50;
// 内存中保留的消息条数上限:面板显示的就是这份历史,裁小了会让长会话
// "只剩后半截"。400 条 ≈ 200 轮,远超正常会话长度,仅防极端内存膨胀。
const HISTORY_LIMIT = 400;
const CONVERSATIONS_KEY = (agentId: string, convId: string) => `${agentId}::${convId}`;

function shouldReduceMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 从已启用 provider 提取生成模型清单(image/video/audio),供 agent 编排生成。 */
function buildGenerationModelCatalog(configs: { service_type: string; capabilities?: string[]; model_list: string[] }[]): Record<string, string[]> | undefined {
  const byKind: Record<string, string[]> = {};
  for (const cfg of configs) {
    const kinds = new Set<string>([cfg.service_type, ...(cfg.capabilities ?? [])]);
    for (const kind of kinds) {
      if (kind !== "image" && kind !== "video" && kind !== "audio") continue;
      for (const m of cfg.model_list ?? []) {
        const list = (byKind[kind] ??= []);
        if (!list.includes(m)) list.push(m);
      }
    }
  }
  return Object.keys(byKind).length > 0 ? byKind : undefined;
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
  // streaming=true 表示 reasoning 流还在增长(thought_delta 持续追加);
  // 收到叙述文本/工具调用/最终回复时闭合。
  | { kind: "thought"; id: string; content: string; streaming?: boolean }
  | { kind: "tool"; id: string; invocation: ToolInvocation }
  | { kind: "canvas"; id: string; patch: CanvasPatch }
  | ({ kind: "ask_user" } & AgentQuestionPage)
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

type NonQuestionRunStep = Exclude<RunStep, { kind: "ask_user" }>;
type InteractiveRunStep =
  | Extract<RunStep, { kind: "ask_user" }>
  | Extract<RunStep, { kind: "pending_run" }>
  | Extract<RunStep, { kind: "canvas" }>
  | Extract<RunStep, { kind: "error" }>;
type NonQuestionInteractiveStep = Exclude<InteractiveRunStep, { kind: "ask_user" }>;
type CanvasRunStep = Extract<RunStep, { kind: "canvas" }>;
type InteractiveRenderItem =
  | { kind: "canvas_group"; id: string; steps: CanvasRunStep[] }
  | { kind: "step"; id: string; step: Exclude<NonQuestionInteractiveStep, { kind: "canvas" }> };

function groupCanvasOperations(steps: NonQuestionInteractiveStep[]): InteractiveRenderItem[] {
  return steps.reduce<InteractiveRenderItem[]>((items, step) => {
    if (step.kind !== "canvas") {
      items.push({ kind: "step", id: step.id, step });
      return items;
    }
    const previous = items.at(-1);
    if (previous?.kind === "canvas_group") {
      previous.steps.push(step);
    } else {
      items.push({ kind: "canvas_group", id: step.id, steps: [step] });
    }
    return items;
  }, []);
}

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
  const moveNodeTo = useStore((s) => s.moveNodeTo);
  const deleteNodes = useStore((s) => s.deleteNodes);
  const createGroup = useStore((s) => s.createGroup);
  const backendModels = useStore((s) => s.backendModels);
  const requestCanvasFocus = useStore((s) => s.requestCanvasFocus);
  const panelWidth = useStore((s) => s.agentPanelWidth);
  const setPanelWidth = useStore((s) => s.setAgentPanelWidth);
  const setPanelResizing = useStore((s) => s.setAgentPanelResizing);
  // 左缘拖拽调宽:pointerdown 后跟随全局 pointermove(宽度 = 视口宽 - 指针x),
  // 拖拽期间禁用 body 文本选择 + 全局让位过渡(画布/导航实时跟手),松手结束。
  const [resizing, setResizing] = useState(false);
  const startResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    setResizing(true);
    setPanelResizing(true);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onMove = (e: PointerEvent) => setPanelWidth(window.innerWidth - e.clientX);
    const onUp = () => {
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
      setPanelResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [setPanelWidth, setPanelResizing]);
  const startAgentNodePick = useStore((s) => s.startAgentNodePick);
  const cancelAgentNodePick = useStore((s) => s.cancelAgentNodePick);
  const agentNodePickActive = useStore((s) => s.agentNodePickActive);
  const agentPickedNode = useStore((s) => s.agentPickedNode);
  const clearAgentPickedNode = useStore((s) => s.clearAgentPickedNode);
  // Canvas nodes the user attached as references via "从画布添加".
  const [referencedNodes, setReferencedNodes] = useState<{ id: string; label: string; thumb: string }[]>([]);
  // Voice input (browser SpeechRecognition; best-effort, no backend).
  const [listening, setListening] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [userName, setUserName] = useState("");
  // Per-message model override (composer "+" → 模型). null = use agent's model.
  const [overrideModel, setOverrideModel] = useState<string | null>(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [showSkillLibrary, setShowSkillLibrary] = useState(false);
  const [skillBatchIndex, setSkillBatchIndex] = useState(0);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [showModelMenu, setShowModelMenu] = useState(false);
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

  // Execution mode (frontend-only, persisted in localStorage). "manual" = the
  // agent asks once per turn/model (PendingRunCard);
  // "auto" = it runs generations autonomously. NOTE: the confirmation gate is
  // entirely frontend (see applyPatch's needsConfirmation) — this does NOT touch
  // the backend AgentUseMode (which controls sub-agent routing, a separate axis).
  const [executionMode, setExecutionMode] = useState<"manual" | "auto">(() => {
    try {
      return localStorage.getItem("agentExecutionMode") === "auto" ? "auto" : "manual";
    } catch {
      return "manual";
    }
  });
  const changeExecutionMode = useCallback((next: "manual" | "auto") => {
    setExecutionMode(next);
    try { localStorage.setItem("agentExecutionMode", next); } catch { /* ignore */ }
  }, []);
  // Left history sidebar collapse (persisted).
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("agentSidebarCollapsed");
      return v == null ? true : v === "1"; // default collapsed for the clean drawer look
    } catch {
      return true;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => {
      const next = !value;
      try { localStorage.setItem("agentSidebarCollapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Per-run streaming state.
  const [streamingReply, setStreamingReply] = useState("");
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const generationBatchRef = useRef<GenerationBatch | null>(null);
  const pendingSequenceRef = useRef(0);
  const resetGenerationBatch = useCallback(() => {
    const project = useStore.getState().activeProjectId;
    const backendProject = useStore.getState().activeBackendProjectId;
    const batch = new GenerationBatch(async request => {
      const state = useStore.getState();
      if (state.activeProjectId !== project || state.activeBackendProjectId !== backendProject) {
        throw new Error('画布项目已切换，未提交的生成已停止，请回原项目重新发起。');
      }
      if (!state.nodes.some(node => node.id === request.nodeId)) throw new Error('节点已删除，已跳过生成。');
      // This turn has already been approved (or explicitly uses automatic
      // execution). Do not open the canvas's second per-node confirmation.
      await state.runNode(request.nodeId, {prompt: request.prompt, model: request.model, skipConfirm: true});
    }, (request, error) => {
      if (generationBatchRef.current !== batch) return;
      setRunSteps(prev => [...prev, {kind: 'error', id: `batch-error-${request.id}`,
        message: error instanceof Error ? error.message : String(error)}]);
    });
    generationBatchRef.current = batch;
    return batch;
  }, []);
  const [questionPage, setQuestionPage] = useState(0);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runFinishedMs, setRunFinishedMs] = useState<number | null>(null);
  const [connectionState, setConnectionState] = useState<"reconnecting" | null>(null);
  // 当前 run 所属的会话 key:运行状态(思考中/步骤/流式文本)只渲染在这个会话
  // 下面 —— 新建/切换会话时不再"串台"到别的会话。
  const [runConvKey, setRunConvKey] = useState<string | null>(null);
  // 深度思考开关(composer)。null=未手动设置,按当前模型默认;模型切换时重置。
  const [deepThinking, setDeepThinking] = useState<boolean | null>(null);
  // 上下文窗口用量(最近一轮 LLM 调用的 usage;prompt 已含全部历史)。
  // 驱动 composer 右下角的「602.7k / 1.0M (60%)」计量表。切换会话时清零。
  const [ctxUsage, setCtxUsage] = useState<{ prompt: number; completion: number; total: number } | null>(null);

  // Slash command picker: opens when the input starts with `/`. Mirrors the
  // Claude / Cursor behavior where typing `/` reveals bound skill templates.
  const [slashIndex, setSlashIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const skillButtonRef = useRef<HTMLButtonElement>(null);

  // composer 自适应高度(DeepSeek 式):随内容自动长高,到 40vh 封顶后
  // 才在框内出滚动条;清空(发送后)自动缩回两行。
  // 依赖带上 open:面板 display:none 时 scrollHeight 为 0,若在隐藏时把
  // 高度写死成 0px,重新打开后输入框就"消失"了 —— 不可见时不写高度,
  // 打开时再重算一遍。
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const sh = ta.scrollHeight;
    if (sh <= 0) {
      ta.style.height = ""; // 不可见:清掉内联高度,交还 rows=2 默认
      return;
    }
    const max = Math.round(window.innerHeight * 0.4);
    ta.style.height = `${Math.min(sh, max)}px`;
    ta.style.overflowY = sh > max ? "auto" : "hidden";
  }, [message, open]);

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
  const canvasPatchRevisionRef = useRef<number | null>(null);
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
      x: 48,
      duration: 0.3,
      ease: "power3.out",
      clearProps: "transform,opacity,visibility",
    });
    return () => { tween.kill(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void Promise.all([listAgents(), listSkills()])
      .then(([agentRows, skillRows]) => {
        // Only surface TOP-LEVEL (orchestrator) agents in the picker. Child /
        // sub-agents (those with a parent_deploy_key) are not picked directly —
        // the parent invokes them on demand via its sub-agent tools. This keeps
        // the picker to a single orchestrator instead of a long list of子智能体.
        const topLevel = (agentRows ?? []).filter((a) => !a.parent_deploy_key);
        setAgents(topLevel);
        setSkills(skillRows ?? []);
        if (topLevel.length > 0) {
          // No agent picker is shown — default to the production orchestrator
          // (it dispatches to its sub-agents on demand). Also re-select if the
          // current selectedId is stale (e.g. a child agent that was filtered
          // out) — otherwise selectedAgent is null and the model badge vanishes.
          setSelectedId((cur) => {
            if (cur && topLevel.some((a) => a.id === cur)) return cur;
            const preferred =
              topLevel.find((a) => a.deploy_key === "productionAgent" && a.enabled) ??
              topLevel.find((a) => a.enabled) ??
              topLevel[0];
            return preferred?.id ?? cur;
          });
        }
      })
      .catch(() => {});
  }, [open, selectedId]);

  const refreshSkills = useCallback(async () => {
    try {
      const rows = await listSkills();
      setSkills(rows ?? []);
    } catch {
      // Keep the current skill library visible when refresh fails.
    }
  }, []);

  // Greeting needs a display name — fetch the current user once.
  useEffect(() => {
    if (!open || userName) return;
    void getCurrentUser().then((u) => setUserName(displayNameOf(u))).catch(() => {});
  }, [open, userName]);

  // When the user picks a canvas node (pick mode), append it as a reference chip.
  useEffect(() => {
    if (!agentPickedNode) return;
    setReferencedNodes((prev) => (prev.some((n) => n.id === agentPickedNode.id) ? prev : [...prev, agentPickedNode]));
    clearAgentPickedNode();
  }, [agentPickedNode, clearAgentPickedNode]);

  // (自动滚动由 assistant-ui 的 ThreadPrimitive.Viewport 接管。)

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
    void listAgentConversationHistory(selectedId, HISTORY_FETCH_LIMIT, activeConvId)
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
  const conversationHistory = useMemo(
    () => getAgentConversationHistory(conversationStore, conversationKey),
    [conversationStore, conversationKey],
  );
  const conversations = selectedId ? conversationsByAgent[selectedId] ?? [] : [];

  // 当前 run 是否属于正在显示的会话:不是就不渲染 思考中/步骤/流式文本
  // (它们只出现在发起 run 的那个会话下面,切换会话不串台)。
  const runHere = runConvKey === conversationKey;

  // assistant-ui runtime:消息线程 + 会话列表(ThreadList adapter)共用。
  // start 是 const 声明在后 —— onSend 回调只在事件时执行,届时已初始化。
  const threadRuntime = useAgentThreadRuntime({
    history: conversationHistory,
    runSteps: runHere ? runSteps : [],
    streamingReply: runHere ? streamingReply : "",
    running: running && runHere,
    onSend: (text) => void start(text),
    threadList: {
      threadId: activeConvId ?? undefined,
      threads: conversations.map((c) => ({
        id: c.id,
        status: "regular" as const,
        title: c.title?.trim() || undefined,
      })),
      onSwitchToThread: (id) => switchToConversation(id),
      onSwitchToNewThread: () => void newChat(),
      onDelete: (id) => void removeConversation(id),
    },
  });

  // 选中消息文本 → 以 markdown 引用块插入 composer(SelectionToolbar「引用」)。
  const quoteIntoComposer = useCallback((text: string) => {
    const quoted = text.trim().split("\n").map((l) => `> ${l}`).join("\n");
    setMessage((prev) => `${quoted}\n\n${prev}`);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Slash menu: open when the message looks like `/foo...` and no space has
  // been typed yet. Discovery spans ALL invokable skills (not just bound) so
  // a freshly-imported skill is reachable immediately.
  const allInvokableSkills = useMemo(() => getAllInvokableSlashSkills(skills), [skills]);
  const modelPresentation = useMemo(
    () => getProviderModelPresentation(backendModels),
    [backendModels],
  );
  const modelDisplayName = useCallback(
    (modelID: string) => getProviderModelDisplayName(modelID, modelPresentation),
    [modelPresentation],
  );
  // Flattened, de-duped list of every configured model name — powers the
  // composer "+" → 模型 per-message override picker.
  const allModels = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const cfg of backendModels) {
      // Agents run on chat/LLM models only — service_type "text". Image/video
      // models would never resolve a chat endpoint for the agent loop.
      if (cfg.service_type !== "text") continue;
      for (const m of cfg.model_list ?? []) {
        if (m && !seen.has(m)) { seen.add(m); out.push(m); }
      }
    }
    return out;
  }, [backendModels]);
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
    // Skill selection is represented by its own full-width chip. Keeping the
    // slash command out of the textarea avoids leaking internal identifiers
    // into the user's prompt.
    setMessage("");
    setSelectedSkillId(skill.id);
    setSlashIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // 自动追踪 agent 创建的节点:视口平滑飞行到新节点并选中(requestCanvasFocus,
  // 420ms 动画)。大画布上用户不用再满图找 agent 刚建的节点。300ms 去抖 ——
  // agent 连创多个节点时镜头只飞向最后一个,不来回乱飞。
  const focusTimerRef = useRef<number | null>(null);
  const scheduleNodeFocus = useCallback((nodeId: string) => {
    if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => {
      focusTimerRef.current = null;
      requestCanvasFocus(nodeId);
    }, 300);
  }, [requestCanvasFocus]);

  const applyPatch = useCallback((event: AgentSSEEvent) => {
    if (event.type !== "canvas_patch") return;
    const patch = event.data;
    const revisionResult = advanceCanvasPatchRevision(canvasPatchRevisionRef.current, patch);
    if (!revisionResult.accepted) {
      setRunSteps((prev) => [...prev, {
        kind: "error",
        id: `patch-conflict-${prev.length}`,
        message: `${revisionResult.reason}。该操作未应用，请重新发起任务。`,
      }]);
      return;
    }
    canvasPatchRevisionRef.current = revisionResult.nextRevision;
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
        if (safe.id) scheduleNodeFocus(safe.id);
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
      case "move_node":
        moveNodeTo(patch.node_id, patch.position);
        scheduleNodeFocus(patch.node_id);
        break;
      case "delete_node":
        deleteNodes([patch.node_id]);
        break;
      case "create_group":
        createGroup(patch.node_ids, patch.name);
        break;
      case "run_node": {
        // The backend includes prompt/model in every run patch. Keeping the
        // event self-contained prevents rapid add/set/run streams from racing
        // the React store and leaving random batch items blank or on defaults.
        if (typeof patch.model === "string" && patch.model.trim()) {
          updateNodeData(patch.node_id, { model: patch.model.trim() });
        }
        const node = useStore.getState().nodes.find((candidate) => candidate.id === patch.node_id);
        const data = (node?.data ?? {}) as Record<string, string>;
        const prompt = typeof patch.prompt === "string" ? patch.prompt : (data.promptDraft ?? data.content ?? "");
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

        const model = patch.model || data.model || fallbackModel;
        const batch = generationBatchRef.current ?? resetGenerationBatch();
        const request = {id: `pending-${++pendingSequenceRef.current}`, nodeId: patch.node_id, serviceType, prompt, model};
        const disposition = batch.register(request, executionMode === "auto");
        if (disposition === "duplicate") break;
        setRunSteps((prev) => [...prev, {
            kind: "pending_run",
            id: request.id,
            nodeId: patch.node_id,
            nodeType: node?.type ?? "",
            serviceType,
            prompt,
            availableModels: allConfiguredModels,
            status: disposition,
            // agent 经 run_node(model=...) 指定的模型优先(编排生图/生视频)。
            chosenModel: batch.approvedModel(request),
          }]);
        break;
      }
    }
  }, [addNode, onConnect, updateNodeData, moveNodeTo, deleteNodes, createGroup, executionMode, backendModels, scheduleNodeFocus, resetGenerationBatch]);

  // 闭合最后一个仍在流式增长的思考步骤 —— 一旦模型开始输出叙述文本/工具调用/
  // 最终回复,说明这一段 reasoning 已经结束(ReasoningBlock 随之收起并定格耗时)。
  const sealStreamingThought = (steps: RunStep[]): RunStep[] => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.kind === "thought" && s.streaming) {
        const next = steps.slice();
        next[i] = { ...s, streaming: false };
        return next;
      }
    }
    return steps;
  };

  const start = async (overrideMessage?: string) => {
    const source = overrideMessage ?? message;
    if (!selectedId || !source.trim() || running || !selectedAgent) return;

    const rawMessage = source.trim();
    resetGenerationBatch();
    const outbound = buildAgentRunMessage(selectedAgent, skills, source, selectedSkillId);
    const invokedSkill = selectedSkillId
      ? skills.find((skill) => skill.id === selectedSkillId)
      : undefined;
    const invokedSkillDisplayName = invokedSkill
      ? getSkillDisplayName(invokedSkill)
      : outbound.invokedSkillName;
    // Prepend any canvas-node references the user attached via "从画布添加".
    const refPreamble = referencedNodes.length
      ? `（参考画布节点：${referencedNodes.map((n) => `${n.label}#${n.id.slice(0, 6)}`).join("，")}）\n`
      : "";
    // 引用的画布节点缩略图 → 随用户消息显示为 image parts(点击可放大)。
    const turnImages = referencedNodes
      .map((n) => (n.thumb ? toRenderableMediaUrl(n.thumb, { thumbWidth: 720 }) : ""))
      .filter(Boolean);
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
        [initialKey]: appendConversationTurn(prev[initialKey] ?? [], "user", rawMessage, HISTORY_LIMIT, turnImages),
      }));
    }
    setMessage("");
    setSelectedSkillId(null);
    setReferencedNodes([]);
    setActiveSkillName(invokedSkillDisplayName);
    setStreamingReply("");
    setRunSteps([]);
    setRunConvKey(initialKey);
    const startedAt = performance.now();
    setRunStartedAt(startedAt);
    setRunFinishedMs(null);
    setConnectionState(null);
    setRunning(true);
    canvasPatchRevisionRef.current = useStore.getState().canvasRevision;

    const priorHistory = conversationHistory;

    // Tracks the "current bucket key" for callbacks; updated if the server
    // hands us a brand-new conversation id mid-flight.
    let currentKey = initialKey;

    abortRef.current = await runAgent(
      targetAgentId,
      {
        message: refPreamble + outbound.message,
        displayMessage: rawMessage,
        nodes: nodes as unknown[],
        edges: edges as unknown[],
        groups: useStore.getState().groups as unknown[],
        history: priorHistory,
        conversation_id: runConversationId ?? undefined,
        model: overrideModel ?? undefined,
        // 记忆隔离域:每个项目的智能体记忆互相独立(save_memory / deep_retrieve /
        // 自动轮次记忆都按 user+agent+project 隔离)。
        project_id: useStore.getState().activeBackendProjectId ?? undefined,
        canvas_revision: useStore.getState().canvasRevision,
        // 可用生成模型清单 → system prompt,让 agent 编排图片/视频生成
        // (create_node + set_prompt + run_node(model=...))。
        generation_models: buildGenerationModelCatalog(backendModels),
        // 深度思考开关:仅思考类模型下发;未手动设置时按模型默认档位。
        thinking: thinkingSupported ? thinkingOn : undefined,
        // 视觉模型:后端据此注册 analyze_image 看图工具(没配就不注册)。
        vision_model: pickVisionModel(backendModels) ?? undefined,
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
                  [newKey]: appendConversationTurn(prev[newKey] ?? [], "user", rawMessage, HISTORY_LIMIT, turnImages),
                }));
              }
              // 标记该会话历史已就绪:否则 conversationKey 变化会触发历史
              // 拉取,run 未落库时拉到空数组,把乐观 push 的气泡整个覆盖
              // (首次运行"只见思考中、不见回答"的根因)。
              setLoadedHistoryIds((prev) => ({ ...prev, [newKey]: true }));
              currentKey = newKey;
              setRunConvKey(newKey);
            }
            break;
          }
          case "thought_delta":
            // reasoning 流:追加到最后一个开放的思考步骤;没有就开一个新块。
            setRunSteps((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                const s = prev[i];
                if (s.kind === "thought" && s.streaming) {
                  const next = prev.slice();
                  next[i] = { ...s, content: s.content + event.data.delta };
                  return next;
                }
              }
              return [...prev, { kind: "thought", id: `thought-${prev.length}`, content: event.data.delta, streaming: true }];
            });
            break;
          case "message_delta":
            setRunSteps(sealStreamingThought);
            setStreamingReply((prev) => prev + event.data.delta);
            break;
          case "message": {
            const finalText = event.data.content;
            setRunSteps(sealStreamingThought);
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
            setRunSteps((prev) => [...sealStreamingThought(prev), {
              kind: "thought",
              id: `thought-${prev.length}`,
              content: event.data.content,
            }]);
            break;
          case "ask_user":
            setRunSteps((prev) => [...prev, {
              kind: "ask_user",
              id: `ask-${prev.length}`,
              question: event.data.question,
              options: Array.isArray(event.data.options) ? event.data.options : [],
              allowCustom: event.data.allow_custom !== false,
            }]);
            break;
          case "tool_call":
            setRunSteps((prev) => [...sealStreamingThought(prev), {
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
              patch: event.data,
            }]);
            applyPatch(event);
            break;
          case "usage":
            setCtxUsage({
              prompt: event.data.prompt_tokens,
              completion: event.data.completion_tokens,
              total: event.data.total_tokens,
            });
            break;
          case "connection_status":
            setConnectionState(event.data.state === "reconnecting" ? "reconnecting" : null);
            break;
          case "error":
            setRunSteps((prev) => [...sealStreamingThought(prev), {
              kind: "error",
              id: `err-${prev.length}`,
              message: event.data.message,
            }]);
            setRunning(false);
            setRunFinishedMs(performance.now() - startedAt);
            setConnectionState(null);
            abortRef.current = null;
            break;
          case "done":
            setRunSteps(sealStreamingThought);
            setRunning(false);
            setRunFinishedMs(performance.now() - startedAt);
            setConnectionState(null);
            abortRef.current = null;
            break;
        }
      },
    );
  };

  // Re-attach to a durable run after a reload, route change, or panel close.
  // Closing this observer never cancels the backend job; the persisted event
  // cursor lets the next mount continue without replaying applied patches.
  useEffect(() => {
    if (!open || !selectedId || abortRef.current) return;
    const job = getActiveAgentJob(selectedId);
    if (!job) return;

    const targetAgentId = selectedId;
    let currentKey = job.conversationId
      ? CONVERSATIONS_KEY(targetAgentId, job.conversationId)
      : null;
    const startedAt = performance.now();
    let disposed = false;
    canvasPatchRevisionRef.current = null;
    resetGenerationBatch();

    if (job.conversationId) {
      setActiveConversationId((prev) => ({ ...prev, [targetAgentId]: job.conversationId }));
      setLoadedHistoryIds((prev) => ({ ...prev, [currentKey!]: true }));
      setRunConvKey(currentKey);
      if (job.message) {
        const displayJobMessage = presentAgentUserInput(job.message);
        setConversationStore((prev) => {
          const turns = prev[currentKey!] ?? [];
          const alreadyPresent = turns.some((turn) => turn.role === "user" && turn.content === displayJobMessage);
          if (alreadyPresent) return prev;
          return {
            ...prev,
            [currentKey!]: appendConversationTurn(turns, "user", displayJobMessage, HISTORY_LIMIT),
          };
        });
      }
    }
    setStreamingReply("");
    setRunSteps([]);
    setRunStartedAt(startedAt);
    setRunFinishedMs(null);
    setConnectionState(null);
    setRunning(true);

    void resumeAgentJob(job, (event, meta?: AgentEventMeta) => {
      switch (event.type) {
        case "conversation": {
          const newID = event.data.id;
          currentKey = CONVERSATIONS_KEY(targetAgentId, newID);
          setActiveConversationId((prev) => ({ ...prev, [targetAgentId]: newID }));
          setLoadedHistoryIds((prev) => ({ ...prev, [currentKey!]: true }));
          setRunConvKey(currentKey);
          break;
        }
        case "thought_delta":
          setRunSteps((prev) => {
            for (let index = prev.length - 1; index >= 0; index--) {
              const step = prev[index];
              if (step.kind === "thought" && step.streaming) {
                const next = prev.slice();
                next[index] = { ...step, content: step.content + event.data.delta };
                return next;
              }
            }
            return [...prev, { kind: "thought", id: `thought-${prev.length}`, content: event.data.delta, streaming: true }];
          });
          break;
        case "message_delta":
          setRunSteps(sealStreamingThought);
          setStreamingReply((prev) => prev + event.data.delta);
          break;
        case "message":
          setRunSteps(sealStreamingThought);
          setStreamingReply("");
          if (currentKey) {
            setConversationStore((prev) => {
              const turns = prev[currentKey!] ?? [];
              const duplicate = turns.some((turn) => turn.role === "assistant" && turn.content === event.data.content.trim());
              if (duplicate) return prev;
              return {
                ...prev,
                [currentKey!]: appendConversationTurn(turns, "assistant", event.data.content, HISTORY_LIMIT),
              };
            });
          }
          void listAgentConversations(targetAgentId)
            .then((rows) => setConversationsByAgent((prev) => ({ ...prev, [targetAgentId]: rows ?? [] })))
            .catch(() => {});
          break;
        case "thought":
          setRunSteps((prev) => [...sealStreamingThought(prev), {
            kind: "thought",
            id: `thought-${prev.length}`,
            content: event.data.content,
          }]);
          break;
        case "ask_user":
          setRunSteps((prev) => [...prev, {
            kind: "ask_user",
            id: `ask-${prev.length}`,
            question: event.data.question,
            options: Array.isArray(event.data.options) ? event.data.options : [],
            allowCustom: event.data.allow_custom !== false,
          }]);
          break;
        case "tool_call":
          setRunSteps((prev) => [...sealStreamingThought(prev), {
            kind: "tool",
            id: `tool-${prev.length}`,
            invocation: {
              id: event.data.id || `tool-${prev.length}`,
              name: event.data.name,
              args: event.data.arguments,
              startedAt: performance.now(),
              status: "running",
            },
          }]);
          break;
        case "tool_result":
          setRunSteps((prev) => {
            for (let index = prev.length - 1; index >= 0; index--) {
              const step = prev[index];
              if (step.kind === "tool" && step.invocation.status === "running") {
                const next = prev.slice();
                next[index] = {
                  ...step,
                  invocation: {
                    ...step.invocation,
                    status: event.data.ok ? "success" : "error",
                    durationMs: performance.now() - step.invocation.startedAt,
                    output: event.data.ok ? (event.data.result ?? "") : (event.data.error ?? ""),
                  },
                };
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
            patch: event.data,
          }]);
          if (!meta?.replayed) applyPatch(event);
          break;
        case "usage":
          setCtxUsage({
            prompt: event.data.prompt_tokens,
            completion: event.data.completion_tokens,
            total: event.data.total_tokens,
          });
          break;
        case "connection_status":
          setConnectionState(event.data.state === "reconnecting" ? "reconnecting" : null);
          break;
        case "error":
          setRunSteps((prev) => [...sealStreamingThought(prev), {
            kind: "error",
            id: `err-${prev.length}`,
            message: event.data.message,
          }]);
          setRunning(false);
          setRunFinishedMs(performance.now() - startedAt);
          setConnectionState(null);
          abortRef.current = null;
          break;
        case "done":
          setRunSteps(sealStreamingThought);
          setRunning(false);
          setRunFinishedMs(performance.now() - startedAt);
          setConnectionState(null);
          abortRef.current = null;
          break;
      }
    }).then((stopObserving) => {
      if (disposed) stopObserving();
      else abortRef.current = stopObserving;
    });

    return () => {
      disposed = true;
      abortRef.current?.();
      abortRef.current = null;
    };
  }, [applyPatch, open, selectedId]);

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
    generationBatchRef.current?.stop();
    abortRef.current?.();
    abortRef.current = null;
    setRunSteps(sealStreamingThought);
    setRunning(false);
    if (runStartedAt != null) {
      setRunFinishedMs(performance.now() - runStartedAt);
    }
  };

  // Pending-run card handlers — confirm fires the actual generation, skip
  // discards it, and updatePendingModel lets the user pick a different model
  // before they confirm.
  const confirmPendingRun = (stepId: string) => {
    const step = runSteps.find(s => s.id === stepId);
    if (!step || step.kind !== "pending_run" || step.status !== "pending") return;
    const model = step.chosenModel ?? step.availableModels[0] ?? "";
    const accepted = generationBatchRef.current?.approve(stepId, model) ?? [];
    const ids = new Set(accepted.map(request => request.id));
    // No generation side effects inside a React updater (StrictMode can replay it).
    setRunSteps(prev => prev.map(s => s.kind === "pending_run" && ids.has(s.id)
      ? {...s, status: "confirmed", chosenModel: model} : s));
  };

  const skipPendingRun = (stepId: string) => {
    generationBatchRef.current?.skip(stepId);
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
  // 同 switchToConversation:进行中的 run 状态不清空(渲染层按会话隔离)。
  const newChat = async () => {
    if (!selectedId) return;
    if (!running) {
      setStreamingReply("");
      setRunSteps([]);
      setRunStartedAt(null);
      setRunFinishedMs(null);
      setCtxUsage(null);
      setRunConvKey(null);
    }
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

  // Switch to an existing thread. 有 run 在跑时保留其状态 —— 运行中的
  // 思考/步骤只在 runConvKey 对应的会话里渲染(见 runHere gating),切走
  // 不清空,切回还能看到进行中的 run。
  const switchToConversation = (cid: string) => {
    if (!selectedId) return;
    setActiveConversationId((prev) => ({ ...prev, [selectedId]: cid }));
    if (!running) {
      setStreamingReply("");
      setRunSteps([]);
      setRunStartedAt(null);
      setRunFinishedMs(null);
      setCtxUsage(null);
      setRunConvKey(null);
    }
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
      x: 32,
      duration: 0.16,
      ease: "power2.in",
      overwrite: "auto",
      onComplete: onClose,
    });
  }, [onClose]);

  // Keep the panel MOUNTED across open/close (display toggle, not unmount) so an
  // in-flight agent run / streaming SSE and the history sidebar state survive a
  // close. The enter animation still fires via the `open`-keyed effect above.
  const hasAnyContent = conversationHistory.length > 0 || streamingReply || runSteps.length > 0;
  // 思考/工具步骤进 assistant-ui 消息流;交互与信息型卡片(提问/待确认生成/
  // 画布操作/错误)保留原有卡片组件,渲染在消息之后。仅在 run 所属会话显示。
  const interactiveSteps = (runHere ? runSteps : []).filter(
    (s): s is InteractiveRunStep => s.kind === "ask_user" || s.kind === "pending_run" || s.kind === "canvas" || s.kind === "error",
  );
  const questionSteps = interactiveSteps.filter(
    (step): step is Extract<RunStep, { kind: "ask_user" }> => step.kind === "ask_user",
  );
  const nonQuestionInteractiveSteps = interactiveSteps.filter(
    (step): step is NonQuestionInteractiveStep => step.kind !== "ask_user",
  );
  const interactiveRenderItems = groupCanvasOperations(nonQuestionInteractiveSteps);
  useEffect(() => {
    setQuestionPage((current) => (
      questionSteps.length === 0 ? 0 : Math.min(current, questionSteps.length - 1)
    ));
  }, [questionSteps.length]);

  const updateQuestionSelection = (questionId: string, answer: string) => {
    setRunSteps((previous) => previous.map((step) => (
      step.kind === "ask_user" && step.id === questionId
        ? { ...step, selectedAnswer: answer.trim() }
        : step
    )));
  };

  const continueQuestionnaire = (questionId: string, answer: string) => {
    const answeredQuestions = selectQuestionAnswer(questionSteps, questionId, answer);
    setRunSteps((previous) => previous.map((step) => {
      if (step.kind !== "ask_user") return step;
      return answeredQuestions.find((question) => question.id === step.id) ?? step;
    }));

    const currentIndex = answeredQuestions.findIndex((question) => question.id === questionId);
    if (currentIndex >= 0 && currentIndex < answeredQuestions.length - 1) {
      setQuestionPage(currentIndex + 1);
      return;
    }

    const unansweredIndex = firstUnansweredQuestionIndex(answeredQuestions);
    if (unansweredIndex >= 0) {
      setQuestionPage(unansweredIndex);
      return;
    }

    const reply = buildQuestionnaireReply(answeredQuestions, zh ? "zh" : "en");
    if (reply) void start(reply);
  };

  const skillBatchCount = Math.max(1, Math.ceil(allInvokableSkills.length / 5));
  const quickChips = getRotatingSkillBatch(allInvokableSkills, skillBatchIndex, 5);
  const selectedComposerSkill = selectedSkillId
    ? skills.find((skill) => skill.id === selectedSkillId) ?? null
    : null;
  const applyQuickChip = (skill: Skill) => {
    setSelectedSkillId(skill.id);
    setShowSkillMenu(false);
    setShowSkillLibrary(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const showNextSkillBatch = () => {
    setSkillBatchIndex((current) => (current + 1) % skillBatchCount);
  };
  const currentModel = overrideModel ?? selectedAgent?.model ?? "";
  // 模型默认选中已有的:agent 没配置默认模型时,自动选第一个可用文本模型,
  // 不让用户面对空的「选择模型」。
  useEffect(() => {
    if (!overrideModel && !selectedAgent?.model && allModels.length > 0) {
      setOverrideModel(allModels[0]);
    }
  }, [overrideModel, selectedAgent?.model, allModels]);
  // 深度思考:换模型后回到该模型的默认档位(qwen3.7 默认关,deepseek 等默认开)。
  useEffect(() => { setDeepThinking(null); }, [currentModel]);
  const thinkingSupported = isThinkingCapableModel(currentModel);
  const thinkingOn = deepThinking ?? isThinkingDefaultOn(currentModel);
  // Provider config that owns a model name — powers the brand icon.
  const modelConfig = (m: string) => backendModels.find((c) => (c.model_list ?? []).includes(m));
  const removeReferencedNode = (id: string) => setReferencedNodes((prev) => prev.filter((n) => n.id !== id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const speechSupported = typeof window !== "undefined" && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const toggleMic = () => {
    if (!speechSupported) return;
    if (listening) { recognitionRef.current?.stop?.(); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = zh ? "zh-CN" : "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (event: any) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) text += event.results[i][0].transcript;
      if (text) setMessage((m) => (m.trim() ? m.trimEnd() + " " : "") + text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  };

  // Live elapsed of the current run.
  const liveElapsedMs = runStartedAt != null
    ? (runFinishedMs ?? (performance.now() - runStartedAt))
    : 0;
  void tick; // depend on tick so React re-renders the counters

  return (
    <div
      ref={panelRef}
      style={{ display: open ? "flex" : "none", width: panelWidth }}
      className="absolute inset-y-0 right-0 z-40 flex h-full flex-col overflow-hidden border-l border-[var(--agent-border)] bg-[var(--agent-bg)] shadow-[0_0_40px_rgba(0,0,0,0.5)]"
    >
      {/* 左缘拖拽手柄:拖动调节面板宽度(380–860px,持久化)。 */}
      <div
        onPointerDown={startResize}
        title={zh ? "拖动调节宽度" : "Drag to resize"}
        className={`absolute inset-y-0 left-0 z-50 w-1.5 cursor-ew-resize transition-colors ${resizing ? "bg-cyan-400/50" : "bg-transparent hover:bg-cyan-400/30"}`}
      />
      {agentNodePickActive ? createPortal(
        <div className="fixed left-1/2 top-4 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-400/30 bg-[#15181d]/95 px-4 py-2 text-xs text-cyan-100 shadow-2xl backdrop-blur">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
          {zh ? "选择模式 · 点击画布节点添加为引用" : "Pick mode · click a canvas node to add as reference"}
          <button type="button" onClick={() => cancelAgentNodePick()} className="ml-1 text-neutral-400 transition hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>,
        document.body,
      ) : null}
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-neutral-300" />
          <span className="text-sm font-medium text-neutral-100">{zh ? "智能体" : "Agent"}</span>
          {/* 读秒移到消息流「思考中…」上方(AgentThread elapsedMs);运行中
              header 只留一个轻量转圈,提示后台有 run(含切到其他会话时)。 */}
          {running ? <Loader2 className="ml-1 h-3 w-3 animate-spin text-neutral-400" /> : null}
        </div>
        <div className="flex items-center gap-1 text-neutral-500">
          <button type="button" onClick={() => void newChat()} disabled={running || !selectedId} className="rounded-md p-1.5 transition hover:bg-white/5 hover:text-white disabled:opacity-40" title={zh ? "新建会话" : "New chat"}>
            <Plus className="h-4 w-4" />
          </button>
          <button type="button" onClick={toggleSidebar} className="rounded-md p-1.5 transition hover:bg-white/5 hover:text-white" title={zh ? "历史会话" : "History"}>
            <PanelLeft className="h-4 w-4" />
          </button>
          <button onClick={handleClose} className="rounded-md p-1.5 transition hover:bg-white/5 hover:text-white" title={zh ? "关闭" : "Close"}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body: 会话列表(assistant-ui ThreadList)+ 主栏。共享同一 runtime。 */}
      <AssistantRuntimeProvider runtime={threadRuntime}>
      {/* min-w-0:flex 子项默认 min-width:auto,超宽内容(w-max 的 GFM 表格)
          会把整列撑破面板,右半截被 overflow-hidden 裁掉(表格也因此失去
          横向滚动)。锁死宽度后,宽表格回到自己的 overflow-x 容器里滚。 */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {!sidebarCollapsed ? <AgentThreadList zh={zh} /> : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">

      {/* Conversation thread — assistant-ui 驱动(结构化 parts + markdown +
          自动滚动/回到底部)。交互型卡片(提问/待确认生成/画布操作/错误)经
          footer 插槽渲染在消息之后。 */}
      {activeSkillName ? (
        <div className="mx-4 mt-3 rounded-md border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-[11px] text-cyan-100">
          {zh ? `本次已触发技能 ${activeSkillName}` : `Triggered skill ${activeSkillName}`}
        </div>
      ) : null}
      {connectionState === "reconnecting" && running && runHere ? (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-amber-400/20 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-100">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          {zh ? "实时连接正在恢复，后台任务仍在运行，过程记录不会丢失。" : "Reconnecting to live updates. The background job is still running and progress is preserved."}
        </div>
      ) : null}
      <AgentThread
        zh={zh}
        runSteps={runHere ? runSteps : []}
        streamingReply={runHere ? streamingReply : ""}
        running={running && runHere}
        elapsedMs={running && runHere ? liveElapsedMs : null}
        onQuote={quoteIntoComposer}
        footer={
          interactiveSteps.length > 0 ? (
            <div className="space-y-2">
              {questionSteps.length > 0 ? (
                <QuestionnaireCard
                  questions={questionSteps}
                  page={questionPage}
                  zh={zh}
                  disabled={running}
                  onPageChange={setQuestionPage}
                  onSelect={updateQuestionSelection}
                  onContinue={continueQuestionnaire}
                  onIgnore={(questionId) => continueQuestionnaire(
                    questionId,
                    zh ? "已忽略此问题" : "Skipped this question",
                  )}
                />
              ) : null}
              {interactiveRenderItems.map((item) => (
                item.kind === "canvas_group" ? (
                  <CanvasOperationsCard key={item.id} steps={item.steps} zh={zh} />
                ) : (
                  <RunStepRow
                    key={item.id}
                    step={item.step}
                    tick={tick}
                    zh={zh}
                    onConfirmRun={confirmPendingRun}
                    onSkipRun={skipPendingRun}
                    onPickModel={updatePendingModel}
                    modelDisplayName={modelDisplayName}
                  />
                )
              ))}
            </div>
          ) : null
        }
      />

      {/* Composer —— shrink-0:无论消息区多长,对话框永远完整固定在底部。 */}
      <div className="relative shrink-0 border-t border-[var(--agent-border)] p-3">
        {/* Slash command popup — appears when the message starts with `/`. */}
        {slashSuggestions.length > 0 ? (
          <SlashMenu
            suggestions={slashSuggestions}
            activeIndex={slashIndex}
            onPick={(skill) => applySlashCompletion(skill)}
            zh={zh}
          />
        ) : null}
        {referencedNodes.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {referencedNodes.map((n) => (
              <span key={n.id} className="inline-flex items-center gap-1 rounded-md border border-[var(--agent-border)] bg-white/[0.05] py-0.5 pl-0.5 pr-1.5 text-[10px] text-neutral-200">
                {n.thumb ? (
                  <img src={toRenderableMediaUrl(n.thumb, { thumbWidth: 720 })} alt="" className="h-4 w-4 rounded object-cover" />
                ) : (
                  <ImageIcon className="h-3.5 w-3.5 text-neutral-500" />
                )}
                <span className="max-w-[110px] truncate">{n.label}</span>
                <button type="button" onClick={() => removeReferencedNode(n.id)} className="text-neutral-500 transition hover:text-rose-300">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {/* Greeting + quick chips, bottom-anchored (empty state). */}
        {!hasAnyContent ? (
          <div className="mb-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[10px] text-neutral-300">{zh ? "用" : "U"}</span>
              <span className="text-[13px] text-neutral-400">{userName ? `Hi ${userName}!` : "Hi!"}</span>
            </div>
            <div className="text-[17px] font-semibold leading-snug text-neutral-100">
              {zh ? "今天一起创作点什么？" : "What shall we create today?"}
            </div>
            {quickChips.length > 0 ? (
              <div className="pt-0.5">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-neutral-300">
                    <Wrench className="h-3.5 w-3.5 shrink-0 text-cyan-300/80" />
                    <span className="truncate">{zh ? "让 Skill 帮你迈出第一步" : "Start with a Skill"}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setShowSkillLibrary(true)}
                      className="rounded-md px-1.5 py-1 text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200"
                    >
                      {zh ? "全部" : "All"}
                    </button>
                    {allInvokableSkills.length > 5 ? (
                      <button
                        type="button"
                        onClick={showNextSkillBatch}
                        className="rounded-md px-1.5 py-1 text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200"
                      >
                        {zh ? "换一批" : "Refresh"}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                {quickChips.map((skill, index) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => applyQuickChip(skill)}
                    className={`group flex min-w-0 items-center gap-2 rounded-xl border border-[var(--agent-border)] bg-white/[0.025] px-2.5 py-2 text-left transition hover:border-cyan-300/25 hover:bg-white/[0.06] hover:text-white ${index === 4 ? "col-span-2" : ""}`}
                    title={skill.description || skill.name}
                  >
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.04] text-neutral-500 transition group-hover:text-cyan-200">
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] font-medium text-neutral-300 group-hover:text-white">{getSkillDisplayName(skill)}</span>
                      <span className="block truncate font-mono text-[9px] text-neutral-600">{getSkillCommandName(skill)}</span>
                    </span>
                  </button>
                ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Single rounded composer container. */}
        <div className="rounded-2xl border border-[var(--agent-border)] bg-white/[0.03] px-3 pb-2 pt-2.5 transition focus-within:border-white/25">
          {selectedComposerSkill ? (
            <div className="mb-2 flex w-full min-w-0 items-center gap-2 rounded-lg border border-cyan-400/25 bg-cyan-500/[0.08] px-2.5 py-2 text-cyan-50">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                {getSkillDisplayName(selectedComposerSkill)}
              </span>
              <button
                type="button"
                onClick={() => setSelectedSkillId(null)}
                disabled={running}
                aria-label={zh ? "移除已选技能" : "Remove selected skill"}
                title={zh ? "移除已选技能" : "Remove selected skill"}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-cyan-100/60 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            value={message}
            onChange={(event) => {
              const nextMessage = event.target.value;
              setMessage(nextMessage);
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
            placeholder={zh ? "描述操作或用 @ 引用…" : "Describe an action, or @ to reference…"}
            rows={2}
            onWheel={(event) => event.stopPropagation()}
            className="prompt-editor-scroll w-full resize-none bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
            disabled={running}
          />
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <Popover
              open={showAttachMenu}
              onOpenChange={(nextOpen) => {
                if (nextOpen) setShowSkillMenu(false);
                setShowAttachMenu(nextOpen);
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={running}
                  title={zh ? "添加画布素材" : "Add from canvas"}
                  aria-label={zh ? "添加画布素材" : "Add from canvas"}
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition disabled:opacity-40 ${
                    showAttachMenu
                      ? "border-cyan-300/30 bg-cyan-500/10 text-cyan-200"
                      : "border-[var(--agent-border)] text-neutral-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </PopoverTrigger>
              <AttachMenu
                zh={zh}
                onPickFromCanvas={() => {
                  startAgentNodePick();
                  setShowAttachMenu(false);
                }}
              />
            </Popover>
            <div className="relative shrink-0">
              {showSkillMenu ? (
                <SkillQuickPicker
                  anchorRef={skillButtonRef}
                  zh={zh}
                  skills={quickChips}
                  onPick={applyQuickChip}
                  onOpenAll={() => {
                    setShowSkillMenu(false);
                    setShowSkillLibrary(true);
                  }}
                  onClose={() => setShowSkillMenu(false)}
                />
              ) : null}
              <button
                ref={skillButtonRef}
                type="button"
                onClick={() => {
                  setShowAttachMenu(false);
                  setShowSkillMenu((value) => !value);
                }}
                disabled={running}
                title={zh ? "选择 Skill" : "Choose a Skill"}
                aria-label={zh ? "选择 Skill" : "Choose a Skill"}
                aria-expanded={showSkillMenu}
                className={`flex h-8 w-8 items-center justify-center rounded-full border transition disabled:opacity-40 ${
                  showSkillMenu
                    ? "border-cyan-300/30 bg-cyan-500/10 text-cyan-200"
                    : "border-[var(--agent-border)] text-neutral-400 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Wrench className="h-4 w-4" />
              </button>
            </div>
            <ExecutionModeToggle
              mode={executionMode}
              onChange={changeExecutionMode}
              disabled={running}
              zh={zh}
            />
            {/* 深度思考开关:仅思考类模型(deepseek / qwen3.7 / *-thinking…)显示。
                开=模型输出 reasoning 流(思考块实时可见);关=直接回答,更快。 */}
            {thinkingSupported ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setDeepThinking(!thinkingOn)}
                    disabled={running}
                    title={thinkingOn
                      ? (zh ? "深度思考已开启：点击关闭" : "Deep thinking is on; click to disable")
                      : (zh ? "深度思考已关闭：点击开启" : "Deep thinking is off; click to enable")}
                    aria-label={thinkingOn
                      ? (zh ? "深度思考已开启，点击关闭" : "Deep thinking on, click to disable")
                      : (zh ? "深度思考已关闭，点击开启" : "Deep thinking off, click to enable")}
                    aria-pressed={thinkingOn}
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition disabled:opacity-40 ${
                      thinkingOn
                        ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                        : "border-[var(--agent-border)] text-neutral-500 hover:bg-white/5 hover:text-neutral-300"
                    }`}
                  >
                    <BrainCircuit className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  sideOffset={8}
                  className="border border-white/10 bg-[#17191e] px-2.5 py-1.5 text-[10px] text-neutral-200 shadow-xl"
                >
                  {thinkingOn
                    ? (zh ? "深度思考 · 已开启" : "Deep thinking · On")
                    : (zh ? "深度思考 · 已关闭" : "Deep thinking · Off")}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <div className="ml-auto flex min-w-[140px] basis-[140px] flex-1 items-center justify-end gap-1.5">
              {/* Standalone model selector, pinned right. Always visible. */}
              {(
                <div className="relative min-w-0 max-w-[148px] flex-1">
                  {showModelMenu ? (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setShowModelMenu(false)} />
                      <div
                        className="prompt-editor-scroll absolute bottom-full right-0 z-40 mb-2 max-h-[280px] w-[220px] overflow-y-auto rounded-xl border border-[var(--agent-border)] bg-[var(--agent-surface)] p-1.5 shadow-2xl backdrop-blur-xl"
                        onWheel={(e) => e.stopPropagation()}
                      >
                        <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">{zh ? "模型" : "Model"}</div>
                        <button
                          type="button"
                          onClick={() => { setOverrideModel(null); setShowModelMenu(false); }}
                          className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[11px] text-neutral-300 transition hover:bg-white/5"
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            {selectedAgent?.model ? (
                              <ModelBrandIcon model={selectedAgent.model} vendor={modelConfig(selectedAgent.model)?.vendor} providerName={modelConfig(selectedAgent.model)?.name} iconKey={modelConfig(selectedAgent.model)?.icon_key} iconUrl={modelConfig(selectedAgent.model)?.icon_url} size={14} />
                            ) : (
                              <Cpu className="h-3.5 w-3.5 text-neutral-500" />
                            )}
                            <span className="min-w-0 truncate">
                              {zh ? "跟随智能体默认" : "Agent default"}{selectedAgent?.model ? ` · ${modelDisplayName(selectedAgent.model)}` : ""}
                            </span>
                          </span>
                          {!overrideModel ? <Check className="h-3.5 w-3.5 shrink-0 text-cyan-300" /> : null}
                        </button>
                        {allModels.map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => { setOverrideModel(m); setShowModelMenu(false); }}
                            className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[11px] text-neutral-300 transition hover:bg-white/5"
                          >
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              <ModelBrandIcon model={m} vendor={modelConfig(m)?.vendor} providerName={modelConfig(m)?.name} iconKey={modelConfig(m)?.icon_key} iconUrl={modelConfig(m)?.icon_url} size={14} />
                              <span className="truncate">{modelDisplayName(m)}</span>
                            </span>
                            {overrideModel === m ? <Check className="h-3.5 w-3.5 shrink-0 text-cyan-300" /> : null}
                          </button>
                        ))}
                        {allModels.length === 0 ? (
                          <div className="px-2 py-1.5 text-[10px] text-neutral-600">{zh ? "暂无可选文本模型（去后台配置）" : "No text models configured"}</div>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setShowModelMenu((v) => !v)}
                    className="flex w-full min-w-0 items-center gap-1 rounded-full border border-[var(--agent-border)] px-2 py-1 text-[10px] text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
                    title={currentModel
                      ? `${zh ? "本次模型" : "Model"}: ${modelDisplayName(currentModel)}`
                      : (zh ? "选择本次模型" : "Model for this message")}
                  >
                    {currentModel ? (
                      <ModelBrandIcon model={currentModel} vendor={modelConfig(currentModel)?.vendor} providerName={modelConfig(currentModel)?.name} iconKey={modelConfig(currentModel)?.icon_key} iconUrl={modelConfig(currentModel)?.icon_url} size={13} />
                    ) : (
                      <Cpu className="h-3 w-3 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{currentModel ? modelDisplayName(currentModel) : (zh ? "选择模型" : "Model")}</span>
                    {overrideModel ? <span className="shrink-0 text-cyan-300">●</span> : null}
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                  </button>
                </div>
              )}
              {speechSupported ? (
                <button
                  type="button"
                  onClick={toggleMic}
                  title={zh ? "语音输入" : "Voice input"}
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition ${listening ? "bg-rose-500/20 text-rose-300" : "text-neutral-400 hover:bg-white/5 hover:text-white"}`}
                >
                  <Mic className="h-4 w-4" />
                </button>
              ) : null}
              {running ? (
                <button onClick={stop} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-500/20 text-rose-300 transition hover:bg-rose-500/30" title={zh ? "停止" : "Stop"}>
                  <Square className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  ref={sendButtonRef}
                  onClick={submitWithMotion}
                  disabled={!message.trim() || !selectedId}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-black transition hover:bg-neutral-200 disabled:bg-white/15 disabled:text-neutral-500"
                  title={zh ? "发送" : "Send"}
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
          {/* 上下文窗口计量表(右下角):最近一轮 usage / 模型上下文上限。
              网关不回 usage 时不显示;模型没声明上限时只显示已用量。 */}
          {ctxUsage ? (
            <ContextWindowMeter usage={ctxUsage} limit={getModelTemplate(currentModel)?.contextWindow} zh={zh} />
          ) : null}
        </div>
      </div>
        </div>
      </div>
      </AssistantRuntimeProvider>
      <SkillLibraryDialog
        open={showSkillLibrary}
        zh={zh}
        skills={skills.filter((skill) => skill.enabled)}
        onClose={() => setShowSkillLibrary(false)}
        onPick={applyQuickChip}
        onSkillsChanged={() => void refreshSkills()}
      />
    </div>
  );
}

/** token 数字格式化:602700 → "602.7k",1000000 → "1.0M"。 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 上下文用量(assistant-ui ContextDisplay 式):SVG 环形 donut + 悬浮详情卡。
 *  阈值配色对齐 aui:<65% 绿(emerald)/ 65–85% 琥珀(amber)/ >85% 红(red)。
 *  usage 取最近一轮 LLM 调用(prompt 已含全部历史,即当前上下文规模)。 */
function ContextWindowMeter({
  usage, limit, zh,
}: {
  usage: { prompt: number; completion: number; total: number };
  limit?: number;
  zh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const used = usage.total;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const ringColor = pct == null ? "#22d3ee" : pct > 85 ? "#ef4444" : pct >= 65 ? "#f59e0b" : "#10b981";
  const R = 7;
  const C = 2 * Math.PI * R;
  const frac = pct == null ? 1 : Math.max(0.02, pct / 100);
  const rows: Array<[string, string]> = [
    [zh ? "使用比例" : "Usage", pct == null ? (zh ? "未知(模型未声明上限)" : "unknown") : `${pct}%`],
    [zh ? "输入 tokens" : "Input", formatTokens(usage.prompt)],
    [zh ? "输出 tokens" : "Output", formatTokens(usage.completion)],
    [zh ? "总计" : "Total", formatTokens(used)],
    ...(limit ? ([
      [zh ? "剩余" : "Remaining", formatTokens(Math.max(0, limit - used))],
      [zh ? "上下文上限" : "Window", formatTokens(limit)],
    ] as Array<[string, string]>) : []),
  ];
  return (
    <div
      className="relative mt-1.5 flex cursor-default items-center gap-2 border-t border-white/[0.06] pt-1.5"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      aria-label={zh ? "上下文用量" : "Context usage"}
    >
      {/* donut ring:进度环从 12 点方向顺时针。 */}
      <svg width="15" height="15" viewBox="0 0 18 18" className="shrink-0 -rotate-90">
        <circle cx="9" cy="9" r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2.6" />
        <circle
          cx="9" cy="9" r={R} fill="none"
          stroke={ringColor} strokeWidth="2.6" strokeLinecap="round"
          strokeDasharray={`${C * frac} ${C}`}
          style={{ opacity: pct == null ? 0.4 : 1, transition: "stroke-dasharray 0.5s, stroke 0.3s" }}
        />
      </svg>
      <span className="shrink-0 text-[10px] text-neutral-500">{zh ? "上下文窗口" : "Context"}</span>
      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-neutral-400">
        {formatTokens(used)}{limit ? ` / ${formatTokens(limit)} (${pct}%)` : ""}
      </span>
      {open ? (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-[216px] rounded-xl border border-white/12 bg-[#17191e] p-3 shadow-2xl">
          <div className="pb-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
            {zh ? "上下文用量 · 最近一轮" : "Context usage · last turn"}
          </div>
          <div className="space-y-1">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-[10.5px]">
                <span className="text-neutral-500">{k}</span>
                <span className="tabular-nums text-neutral-200">{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Composer "+" attach menu, anchored directly to its trigger button. */
function AttachMenu({
  zh, onPickFromCanvas,
}: {
  zh: boolean;
  onPickFromCanvas: () => void;
}) {
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={12}
      role="menu"
      aria-label={zh ? "画布素材" : "Canvas assets"}
      className="prompt-editor-scroll z-[130] max-h-[320px] w-[300px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border-[var(--agent-border)] bg-[var(--agent-surface)] p-1.5 text-neutral-200 shadow-2xl backdrop-blur-xl"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
        {zh ? "画布" : "Canvas"}
      </div>
      <button
        type="button"
        role="menuitem"
        onClick={onPickFromCanvas}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] text-neutral-300 transition hover:bg-white/5"
      >
        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
        <span className="truncate">{zh ? "从画布添加（点选节点）" : "Add from canvas (pick a node)"}</span>
      </button>
    </PopoverContent>
  );
}

/** Compact execution-mode picker: icon-only in the toolbar, labels in the popup. */
function ExecutionModeToggle({
  mode,
  onChange,
  disabled,
  zh,
}: {
  mode: "manual" | "auto";
  onChange: (mode: "manual" | "auto") => void;
  disabled?: boolean;
  zh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const manual = mode === "manual";
  const currentLabel = manual
    ? (zh ? "手动确认" : "Manual confirmation")
    : (zh ? "自动生成" : "Automatic generation");

  const selectMode = (next: "manual" | "auto") => {
    onChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              title={currentLabel}
              aria-label={currentLabel}
              aria-haspopup="menu"
              aria-expanded={open}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-40 ${
                open
                  ? "border-cyan-300/30 bg-cyan-500/10 text-cyan-200"
                  : "border-[var(--agent-border)] text-neutral-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              {manual ? <Hand className="h-4 w-4" /> : <Zap className="h-4 w-4 text-cyan-300" />}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open ? (
          <TooltipContent
            side="top"
            sideOffset={8}
            className="border border-white/10 bg-[#17191e] px-2.5 py-1.5 text-[10px] text-neutral-200 shadow-xl"
          >
            {currentLabel}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        role="menu"
        aria-label={zh ? "执行方式" : "Execution mode"}
        className="z-[130] w-[228px] rounded-xl border-[var(--agent-border)] bg-[var(--agent-surface)] p-1.5 text-neutral-200 shadow-2xl backdrop-blur-xl"
      >
        <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
          {zh ? "执行方式" : "Execution mode"}
        </div>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={manual}
          onClick={() => selectMode("manual")}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-white/5"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.035] text-neutral-300">
            <Hand className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium text-neutral-200">
              {zh ? "手动确认" : "Manual confirmation"}
            </span>
            <span className="mt-0.5 block text-[9px] text-neutral-500">
              {zh ? "生成前逐项确认" : "Confirm each generation"}
            </span>
          </span>
          {manual ? <Check className="h-3.5 w-3.5 shrink-0 text-cyan-300" /> : null}
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={!manual}
          onClick={() => selectMode("auto")}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-white/5"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.035] text-cyan-300">
            <Zap className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium text-neutral-200">
              {zh ? "自动生成" : "Automatic generation"}
            </span>
            <span className="mt-0.5 block text-[9px] text-neutral-500">
              {zh ? "自动规划并执行" : "Plan and run automatically"}
            </span>
          </span>
          {!manual ? <Check className="h-3.5 w-3.5 shrink-0 text-cyan-300" /> : null}
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** Always-visible conversation history sidebar (collapses to width 0). */
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
            : "border-[var(--agent-border)] bg-black/30 text-neutral-200 hover:border-white/18 hover:bg-white/[0.04]"
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
          className="prompt-editor-scroll absolute left-0 right-0 top-[calc(100%+8px)] z-[60] max-h-[280px] overflow-y-auto rounded-xl border border-[var(--agent-border)] bg-[#171a20]/98 p-1.5 shadow-2xl shadow-black/45 backdrop-blur-xl"
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

function QuestionnaireCard({
  questions,
  page,
  zh,
  disabled,
  onPageChange,
  onSelect,
  onContinue,
  onIgnore,
}: {
  questions: Extract<RunStep, { kind: "ask_user" }>[];
  page: number;
  zh: boolean;
  disabled: boolean;
  onPageChange: (page: number) => void;
  onSelect: (questionId: string, answer: string) => void;
  onContinue: (questionId: string, answer: string) => void;
  onIgnore: (questionId: string) => void;
}) {
  const safePage = Math.max(0, Math.min(page, questions.length - 1));
  const question = questions[safePage];
  if (!question) return null;

  const selectedAnswer = question.selectedAnswer?.trim() ?? "";
  const customAnswer = selectedAnswer && !question.options.includes(selectedAnswer)
    ? selectedAnswer
    : "";

  return (
    <div className="rounded-xl border border-cyan-400/25 bg-cyan-500/[0.06] p-3 shadow-[0_12px_36px_rgba(0,0,0,0.2)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2 text-[12px] font-medium text-neutral-100">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" />
          <span className="leading-relaxed">{question.question}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-400">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(0, safePage - 1))}
            disabled={disabled || safePage === 0}
            aria-label={zh ? "上一题" : "Previous question"}
            className="grid h-6 w-6 place-items-center rounded-md transition hover:bg-white/10 disabled:opacity-25"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-9 text-center tabular-nums">{safePage + 1} / {questions.length}</span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(questions.length - 1, safePage + 1))}
            disabled={disabled || safePage >= questions.length - 1 || !selectedAnswer}
            aria-label={zh ? "下一题" : "Next question"}
            className="grid h-6 w-6 place-items-center rounded-md transition hover:bg-white/10 disabled:opacity-25"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {question.options.map((option, index) => {
          const selected = option === selectedAnswer;
          return (
            <button
              key={`${question.id}-${option}`}
              type="button"
              onClick={() => onSelect(question.id, option)}
              disabled={disabled}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[12px] transition disabled:opacity-50 ${
                selected
                  ? "border-cyan-300/50 bg-cyan-400/15 text-white"
                  : "border-[var(--agent-border)] bg-white/[0.03] text-neutral-300 hover:border-cyan-400/35 hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${
                selected ? "border-cyan-300/70 bg-cyan-300 text-neutral-950" : "border-white/15 text-neutral-400"
              }`}>
                {selected ? <Check className="h-2.5 w-2.5" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">{option}</span>
            </button>
          );
        })}
      </div>

      {question.allowCustom ? (
        <input
          type="text"
          value={customAnswer}
          onChange={(event) => onSelect(question.id, event.target.value)}
          disabled={disabled}
          placeholder={zh ? "其他，请直接输入" : "Other, type your answer"}
          className="mt-2 w-full rounded-lg border border-[var(--agent-border)] bg-black/20 px-2.5 py-2 text-[12px] text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-cyan-400/40 disabled:opacity-50"
        />
      ) : null}

      {selectedAnswer ? (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-cyan-200/80">
          <Check className="h-3 w-3" />
          <span className="truncate">{zh ? "已选择" : "Selected"}：{selectedAnswer}</span>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onIgnore(question.id)}
          disabled={disabled}
          className="rounded-lg px-3 py-1.5 text-[11px] text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200 disabled:opacity-40"
        >
          {zh ? "忽略" : "Skip"}
        </button>
        <button
          type="button"
          onClick={() => onContinue(question.id, selectedAnswer)}
          disabled={disabled || !selectedAnswer}
          className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-300 px-3 py-1.5 text-[11px] font-medium text-neutral-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {safePage < questions.length - 1
            ? (zh ? "下一题" : "Next")
            : (zh ? "继续" : "Continue")}
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function CanvasOperationIcon({ entity }: { entity: CanvasOperationEntity }) {
  const Icon = entity === "text" ? MessageSquarePlus
    : entity === "image" ? ImageIcon
    : entity === "video" ? Film
    : entity === "audio" ? Music2
    : entity === "connection" ? GitBranch
    : entity === "task" ? Play
    : Sparkles;
  return <Icon className="h-3.5 w-3.5" />;
}

function CanvasOperationsCard({ steps, zh }: { steps: CanvasRunStep[]; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const operations = steps.map((step) => presentCanvasOperation(step.patch, zh));
  const operationSummary = operations
    .slice(0, 2)
    .map((operation) => `${operation.action}${operation.detail}`)
    .join(zh ? "、" : ", ");
  const summarySuffix = operations.length > 2 ? (zh ? "等" : " and more") : "";

  return (
    <div className={`self-start overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.055] shadow-[0_8px_22px_rgba(0,0,0,0.14)] transition-[width,background-color] ${expanded ? "w-[280px] max-w-full" : "w-fit max-w-[260px]"}`}>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-white/[0.035]"
        aria-expanded={expanded}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-300">
          <Sparkles className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium text-neutral-200">
            {zh ? `已完成 ${operations.length} 项画布操作` : `${operations.length} canvas changes completed`}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-neutral-400" title={`${operationSummary}${summarySuffix}`}>
            {operationSummary}{summarySuffix}
          </span>
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-neutral-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded ? (
        <div className="prompt-editor-scroll max-h-[220px] overflow-y-auto border-t border-white/[0.055] px-2 py-1.5">
          {operations.map((operation, index) => (
            <div key={`${steps[index]?.id ?? "canvas"}-${index}`} className="rounded-lg px-2 py-1.5 transition hover:bg-white/[0.03]">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-neutral-400">
                  <CanvasOperationIcon entity={operation.entity} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-[9px]">
                    <span className="font-medium text-emerald-300/85">{operation.action}</span>
                    <span className="text-neutral-600">·</span>
                    <span className="text-neutral-500">{operation.detail}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-neutral-300" title={operation.title}>
                    {operation.title}
                  </span>
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
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
  modelDisplayName,
}: {
  step: Exclude<NonQuestionRunStep, { kind: "canvas" }>;
  tick: number;
  zh: boolean;
  onConfirmRun: (stepId: string) => void;
  onSkipRun: (stepId: string) => void;
  onPickModel: (stepId: string, model: string) => void;
  modelDisplayName: (modelID: string) => string;
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
  if (step.kind === "pending_run") {
    return (
      <PendingRunCard
        step={step}
        zh={zh}
        onConfirm={() => onConfirmRun(step.id)}
        onSkip={() => onSkipRun(step.id)}
        onPickModel={(model) => onPickModel(step.id, model)}
        modelDisplayName={modelDisplayName}
      />
    );
  }
  return (
    <div className="rounded border border-rose-400/20 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-200">
      {step.message}
    </div>
  );
}

export function PendingRunCard({
  step,
  zh,
  onConfirm,
  onSkip,
  onPickModel,
  modelDisplayName,
}: {
  step: Extract<RunStep, { kind: "pending_run" }>;
  zh: boolean;
  onConfirm: () => void;
  onSkip: () => void;
  onPickModel: (model: string) => void;
  modelDisplayName: (modelID: string) => string;
}) {
  // 完整服务类型映射(旧版只认 video/audio,图像会被误标成「音频生成」)。
  const Icon = step.serviceType === "video" ? Film
    : step.serviceType === "audio" ? Music2
    : step.serviceType === "image" ? ImageIcon
    : Sparkles;
  const typeLabel = step.serviceType === "video" ? (zh ? "视频生成" : "Video generation")
    : step.serviceType === "audio" ? (zh ? "音频生成" : "Audio generation")
    : step.serviceType === "image" ? (zh ? "图像生成" : "Image generation")
    : (zh ? "文本生成" : "Text generation");
  const cardRef = useMountFadeIn<HTMLDivElement>({ opacity: 0, y: 8, scale: 0.97 }, { duration: 0.3 });

  if (step.status === "skipped") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--agent-border)] bg-white/[0.02] px-3 py-2 text-[11px] text-neutral-500">
        <Icon className="h-3.5 w-3.5" />
        {zh ? `已跳过 · ${typeLabel}` : `Skipped · ${typeLabel}`}
      </div>
    );
  }
  if (step.status === "confirmed") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-500/[0.06] px-3 py-2 text-[11px] text-emerald-200">
        <Icon className="h-3.5 w-3.5" />
        {zh ? `已确认，按队列生成 · ${typeLabel} · ${modelDisplayName(step.chosenModel ?? "")}` : `Approved for queued generation · ${typeLabel} · ${modelDisplayName(step.chosenModel ?? "")}`}
      </div>
    );
  }

  const currentModel = step.chosenModel ?? step.availableModels[0] ?? "";
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
          className="flex-1 rounded border border-[var(--agent-border)] bg-black/40 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-amber-400/40"
          title={zh ? "可以选择任意已配置的模型" : "Pick any configured model"}
        >
          {step.availableModels.map((m, idx) => (
            <option key={`${m}-${idx}`} value={m}>{modelDisplayName(m)}</option>
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
          {zh ? "允许本轮同模型批量运行" : "Allow this model for this turn"}
        </button>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-neutral-400">{zh
        ? '仅授权本轮任务中该模型的生成，包含后续新增的同批节点；更换模型或新任务仍需确认。豆包图片最多 10 张同时生成，其余排队。'
        : 'Approves this model for this turn, including later nodes. A new model or turn asks again. Seedream images queue beyond 10 active outputs.'}</p>
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
    read_nodes: "Read nodes",
    get_subgraph: "Read subgraph",
    get_canvas_delta: "Read canvas changes",
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
    read_nodes: "批量读取节点",
    get_subgraph: "读取关联子图",
    get_canvas_delta: "读取画布变化",
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
    <div ref={menuRef} className="prompt-editor-scroll absolute bottom-[110px] left-3 right-3 z-50 max-h-[280px] overflow-y-auto rounded-lg border border-[var(--agent-border)] bg-[#1a1d23]/98 p-1.5 shadow-2xl backdrop-blur-xl">
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
      className="prompt-editor-scroll absolute right-4 top-[58px] z-50 max-h-[360px] w-[300px] overflow-y-auto rounded-lg border border-[var(--agent-border)] bg-[#1a1d23]/98 p-1.5 shadow-2xl backdrop-blur-xl"
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
