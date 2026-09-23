import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Lock,
  MapPin,
  Package,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  type AutomationAsset,
  type AutomationAssetType,
  type AutomationWorkflow,
  buildStoryboardDrafts,
  ensureScriptCharacterCoverage,
  extractAssetsFromScript,
  hasCompletedScriptExtraction,
  loadAutomationWorkflow,
  parseExtractedAssetsResponse,
  parseStoryboardResponse,
  reconcileStoryboardAssetReferences,
  saveAutomationWorkflow,
} from "../automation-workflow";
import {
  automationTaskNodeId,
  extractAssetsWithSystemPrompt,
  generateStoryboardImage,
  listAutomationImageModels,
  listAutomationTextModels,
  resumeQueuedTextGeneration,
  splitScriptToStoryboardsWithSystemPrompt,
  storyboardTaskFingerprintSource,
  type AutomationImageModelOption,
  type AutomationTextModelOption,
} from "../api/automation";
import { uploadFile } from "../api/projects";
import {
  batchTasksByNodeIds,
  listRecentAutomationTasks,
  type TaskItem,
} from "../api/tasks";
import { defaultStoryboardSkillId, storyboardSkillOptions } from "../storyboard-skills";
import { extractScriptDocumentText } from "../document-text";
import { useStore } from "../store";
import logoUrl from "../../imports/logo.png";
import { MediaThumb } from "./MediaThumb";
import { ModelBrandIcon } from "./ModelBrandIcon";

type Stage = "script" | "assets" | "lock" | "storyboard";

type AutomationTaskKind = "assetExtraction" | "storyboardSplit";

type AutomationTaskStatus = "idle" | "running" | "success" | "error";

type AutomationTaskState = {
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  title: string;
  detail: string;
  taskId?: string;
  nodeId?: string;
  projectId?: string;
  skillName?: string;
  receivedChars?: number;
  draftContent?: string;
  startedAt?: number;
  completedAt?: number;
};

const assetTypes: Array<{
  key: AutomationAssetType;
  label: string;
  icon: typeof UserRound;
  accept: string;
}> = [
  { key: "character", label: "人物", icon: UserRound, accept: "image/*" },
  { key: "scene", label: "场景", icon: MapPin, accept: "image/*" },
  { key: "prop", label: "道具", icon: Package, accept: "image/*" },
  { key: "audio", label: "音频", icon: AudioLines, accept: "audio/*" },
];

const stageItems: Array<{ key: Stage; index: string; title: string; subtitle: string }> = [
  { key: "script", index: "01", title: "导入剧本", subtitle: "上传或粘贴剧本正文" },
  { key: "assets", index: "02", title: "整理素材", subtitle: "自动提取并补充资产" },
  { key: "lock", index: "03", title: "锁定资产", subtitle: "绑定声音并确认连续性" },
  { key: "storyboard", index: "04", title: "分镜与线稿", subtitle: "创建镜头生产任务" },
];

const progressItems: Array<{
  key: Stage | "image" | "canvas";
  index: string;
  title: string;
  subtitle: string;
}> = [
  ...stageItems,
  { key: "image", index: "05", title: "生成分镜图", subtitle: "选择模型生成画面" },
  { key: "canvas", index: "06", title: "进入画布", subtitle: "编排并继续生产" },
];

const typeLabel = (type: AutomationAssetType) =>
  assetTypes.find((item) => item.key === type)?.label ?? type;

const stageRank = (stage: Stage) => stageItems.findIndex((item) => item.key === stage);

const isStageKey = (key: Stage | "image" | "canvas"): key is Stage =>
  key !== "image" && key !== "canvas";

const idleExtractionTask = (): AutomationTaskState => ({
  kind: "assetExtraction",
  status: "idle",
  title: "剧本资产提取",
  detail: "暂无资产提取任务",
});

const idleStoryboardTask = (): AutomationTaskState => ({
  kind: "storyboardSplit",
  status: "idle",
  title: "分镜任务",
  detail: "暂无分镜任务",
});

const automationTaskStorageKey = (projectId?: string) =>
  `ccy-automation-tasks:${projectId ?? "default"}`;

const assetTaskObservationTimeoutMessage = "真实文字模型仍在提取中，请稍后重试。";
const storyboardTaskObservationTimeoutMessage = "真实文字模型仍在拆分分镜中，请稍后重试。";

function loadAutomationTasks(projectId?: string): {
  extractionTask: AutomationTaskState;
  storyboardTask: AutomationTaskState;
} {
  try {
    const raw = localStorage.getItem(automationTaskStorageKey(projectId));
    if (!raw) return { extractionTask: idleExtractionTask(), storyboardTask: idleStoryboardTask() };
    const parsed = JSON.parse(raw) as Partial<{
      extractionTask: AutomationTaskState;
      storyboardTask: AutomationTaskState;
    }>;
    return {
      extractionTask: parsed.extractionTask ?? idleExtractionTask(),
      storyboardTask: parsed.storyboardTask ?? idleStoryboardTask(),
    };
  } catch {
    return { extractionTask: idleExtractionTask(), storyboardTask: idleStoryboardTask() };
  }
}

function saveAutomationTasks(
  projectId: string | undefined,
  extractionTask: AutomationTaskState,
  storyboardTask: AutomationTaskState,
) {
  localStorage.setItem(
    automationTaskStorageKey(projectId),
    JSON.stringify({ extractionTask, storyboardTask }),
  );
}

const backendTaskIsActive = (status: string) =>
  ["queued", "pending", "running", "retrying", "persisting"]
    .includes(status.trim().toLowerCase());

const backendTaskIsSuccess = (status: string) =>
  status.trim().toLowerCase() === "success";

function taskStartedAt(task: TaskItem) {
  const value = Date.parse(task.created_at);
  return Number.isFinite(value) ? value : Date.now();
}

function automationTaskStateFromServer(task: TaskItem): AutomationTaskState | null {
  const isExtraction = task.node_id.startsWith("automation-extract-");
  const isStoryboard = task.node_id.startsWith("automation-storyboard-split-");
  if (!isExtraction && !isStoryboard) return null;
  const status: AutomationTaskStatus = backendTaskIsActive(task.status)
    ? "running"
    : backendTaskIsSuccess(task.status)
      ? "success"
      : "error";
  const startedAt = taskStartedAt(task);
  const title = isExtraction ? "剧本资产提取" : "分镜任务";
  const detail = status === "running"
    ? `正在使用「${task.model || "文字模型"}」后台处理`
    : status === "success"
      ? `「${task.model || "文字模型"}」已完成，结果已保存在后台`
      : task.error_msg || `「${task.model || "文字模型"}」任务失败`;
  return {
    kind: isExtraction ? "assetExtraction" : "storyboardSplit",
    status,
    title,
    detail,
    taskId: task.id,
    nodeId: task.node_id,
    projectId: task.project_id,
    startedAt,
    completedAt: status === "running"
      ? undefined
      : startedAt + Math.max(0, task.duration_ms),
  };
}

function emptyWorkflow(projectId: string): AutomationWorkflow {
  return {
    version: 1,
    projectId,
    scriptName: "",
    scriptText: "",
    storyboardSkillId: defaultStoryboardSkillId,
    extractedScriptText: undefined,
    extractionCompletedAt: undefined,
    assets: [],
    storyboards: [],
    updatedAt: Date.now(),
  };
}

function loadWorkflowForProject(projectId: string): AutomationWorkflow {
  const saved = loadAutomationWorkflow(projectId);
  if (!saved) return emptyWorkflow(projectId);
  if (!hasCompletedScriptExtraction(saved)) return saved;
  const covered = ensureScriptCharacterCoverage(saved.scriptText, saved.assets);
  const corrected = covered.removedNames.length > 0 || covered.reclassifiedAudioNames.length > 0;
  return {
    ...saved,
    assets: covered.assets,
    storyboards: reconcileStoryboardAssetReferences(saved.storyboards, covered.assets),
    updatedAt: covered.addedNames.length > 0 || corrected ? Date.now() : saved.updatedAt,
  };
}

function assetCorrectionNotice(
  result: ReturnType<typeof ensureScriptCharacterCoverage>,
) {
  const corrections = [
    result.removedNames.length > 0
      ? `已移除误判人物“${result.removedNames.join("、")}”`
      : "",
    result.reclassifiedAudioNames.length > 0
      ? `已将“${result.reclassifiedAudioNames.join("、")}”归入音频`
      : "",
    result.addedNames.length > 0
      ? `已根据剧本证据补齐人物“${result.addedNames.join("、")}”`
      : "",
  ].filter(Boolean);
  return corrections.length > 0 ? `${corrections.join("；")}。` : null;
}

type AutomationModelOption = AutomationTextModelOption | AutomationImageModelOption;

function AutomationModelPicker({
  options,
  value,
  onChange,
  disabled,
  loading = false,
  placeholder,
  testId,
}: {
  options: AutomationModelOption[];
  value: string;
  onChange: (model: AutomationModelOption) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((model) => model.id === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div ref={rootRef} className="relative min-w-[260px]">
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
        }}
        disabled={disabled}
        className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-[#191a1f] px-3 py-2.5 text-left text-[11.5px] text-neutral-300 outline-none transition hover:border-white/15 focus:border-[#ff6a33]/35 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {selected ? (
          <ModelBrandIcon
            model={selected.model}
            vendor={selected.vendor}
            providerName={selected.providerName}
            size={16}
          />
        ) : (
          <Bot className={`h-4 w-4 shrink-0 text-neutral-500 ${loading ? "animate-pulse" : ""}`} />
        )}
        <span className="min-w-0 flex-1 truncate">
          {selected?.model ?? (loading ? "正在读取模型…" : placeholder)}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-neutral-600 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 z-[80] mt-2 max-h-64 w-full min-w-[280px] overflow-y-auto rounded-xl border border-white/10 bg-[#18191e] p-1.5 shadow-[0_18px_60px_rgba(0,0,0,0.55)]"
        >
          {options.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={model.id === value}
              onClick={() => {
                onChange(model);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11.5px] text-neutral-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <ModelBrandIcon
                model={model.model}
                vendor={model.vendor}
                providerName={model.providerName}
                size={16}
              />
              <span className="min-w-0 flex-1 truncate">{model.model}</span>
              {model.id === value ? <Check className="h-3.5 w-3.5 shrink-0 text-[#ff7a4d]" /> : null}
            </button>
          ))}
          {options.length === 0 ? (
            <div className="px-2.5 py-2 text-[11px] text-neutral-600">{placeholder}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AutomationWorkspace() {
  const activeBackendProjectId = useStore((state) => state.activeBackendProjectId);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const projectId = activeBackendProjectId ?? activeProjectId;
  return <AutomationWorkspaceProject key={projectId} projectId={projectId} />;
}

function AutomationWorkspaceProject({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const activeBackendProjectId = useStore((state) => state.activeBackendProjectId);
  const backendProjects = useStore((state) => state.backendProjects);
  const localProjects = useStore((state) => state.projects);
  const saveAsset = useStore((state) => state.saveAsset);
  const projectName =
    backendProjects.find((project) => project.id === projectId)?.name
    ?? localProjects.find((project) => project.id === projectId)?.name
    ?? "未命名项目";

  const [workflow, setWorkflow] = useState<AutomationWorkflow>(() =>
    loadWorkflowForProject(projectId),
  );
  const [stage, setStage] = useState<Stage>(() => {
    const saved = loadAutomationWorkflow(projectId);
    if (saved && hasCompletedScriptExtraction(saved)) return "assets";
    return "script";
  });
  const [assetFilter, setAssetFilter] = useState<AutomationAssetType>("character");
  const [extracting, setExtracting] = useState(false);
  const [readingScriptFile, setReadingScriptFile] = useState(false);
  const [splittingStoryboards, setSplittingStoryboards] = useState(false);
  const [generatingStoryboardId, setGeneratingStoryboardId] = useState<string | null>(null);
  const [textModels, setTextModels] = useState<AutomationTextModelOption[]>([]);
  const [imageModels, setImageModels] = useState<AutomationImageModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [uploadingType, setUploadingType] = useState<AutomationAssetType | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newAssetName, setNewAssetName] = useState("");
  const [addingAsset, setAddingAsset] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);
  const [showStoryboardSkillPicker, setShowStoryboardSkillPicker] = useState(false);
  const [pendingStoryboardSkillId, setPendingStoryboardSkillId] = useState(defaultStoryboardSkillId);
  const [showTaskList, setShowTaskList] = useState(false);
  const [recentServerTasks, setRecentServerTasks] = useState<TaskItem[]>([]);
  const [extractionTask, setExtractionTask] = useState<AutomationTaskState>(() =>
    loadAutomationTasks(projectId).extractionTask,
  );
  const [storyboardTask, setStoryboardTask] = useState<AutomationTaskState>(() =>
    loadAutomationTasks(projectId).storyboardTask,
  );
  const scriptInputRef = useRef<HTMLInputElement>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadTypeRef = useRef<AutomationAssetType>("character");
  const pendingUploadAssetIdRef = useRef<string | null>(null);
  const pendingUploadVariantIdRef = useRef<string | null>(null);
  const resumedTaskIdsRef = useRef<Set<string>>(new Set());
  const taskStateRef = useRef({ extractionTask, storyboardTask });
  taskStateRef.current = { extractionTask, storyboardTask };
  const activeResumeRef = useRef<{
    assetExtraction?: { token: symbol; controller: AbortController };
    storyboardSplit?: { token: symbol; controller: AbortController };
  }>({});
  const expectedExtractionNodeId = useMemo(() => {
    if (!workflow.scriptText.trim()) return null;
    return automationTaskNodeId(
      "extract",
      projectId,
      workflow.scriptText.trim(),
    );
  }, [projectId, workflow.scriptText]);
  const expectedStoryboardNodeId = useMemo(() => {
    if (!workflow.scriptText.trim()) return null;
    const skill =
      storyboardSkillOptions.find((item) => item.id === workflow.storyboardSkillId)
      ?? storyboardSkillOptions[0];
    return automationTaskNodeId(
      "storyboard-split",
      projectId,
      storyboardTaskFingerprintSource({
        script: workflow.scriptText,
        assets: workflow.assets,
        storyboardSkillName: skill?.name,
      }),
    );
  }, [
    projectId,
    workflow.assets,
    workflow.scriptText,
    workflow.storyboardSkillId,
  ]);
  const recoveryIdentityRef = useRef({
    extractionNodeId: expectedExtractionNodeId,
    storyboardNodeId: expectedStoryboardNodeId,
    workflow,
  });
  recoveryIdentityRef.current = {
    extractionNodeId: expectedExtractionNodeId,
    storyboardNodeId: expectedStoryboardNodeId,
    workflow,
  };

  useEffect(() => {
    saveAutomationWorkflow({ ...workflow, updatedAt: Date.now() });
  }, [workflow]);

  useEffect(() => {
    if (!hasCompletedScriptExtraction(workflow)) return;
    const corrected = ensureScriptCharacterCoverage(workflow.scriptText, workflow.assets);
    const correctionNotice = assetCorrectionNotice(corrected);
    if (!correctionNotice) return;
    setWorkflow((current) => ({
      ...current,
      assets: corrected.assets,
      storyboards: reconcileStoryboardAssetReferences(current.storyboards, corrected.assets),
      updatedAt: Date.now(),
    }));
    setNotice(correctionNotice);
  }, [workflow.assets, workflow.extractionCompletedAt, workflow.scriptText]);

  useEffect(() => {
    saveAutomationTasks(projectId, extractionTask, storyboardTask);
  }, [projectId, extractionTask, storyboardTask]);

  useEffect(() => {
    const nodeIds = [expectedExtractionNodeId, expectedStoryboardNodeId]
      .filter((nodeId): nodeId is string => Boolean(nodeId));
    if (nodeIds.length === 0) return;
    let cancelled = false;
    const extractionNodeId = expectedExtractionNodeId;
    const storyboardNodeId = expectedStoryboardNodeId;
    void batchTasksByNodeIds(nodeIds)
      .then((tasks) => {
        if (cancelled) return;
        const currentIdentity = recoveryIdentityRef.current;
        if (
          currentIdentity.extractionNodeId !== extractionNodeId
          || currentIdentity.storyboardNodeId !== storyboardNodeId
        ) return;
        const currentWorkflow = currentIdentity.workflow;
        const extraction = tasks.find((task) => task.node_id === extractionNodeId);
        const storyboard = tasks.find((task) => task.node_id === storyboardNodeId);
        if (
          extraction
          && (
            !activeBackendProjectId
            || !extraction.project_id
            || extraction.project_id === activeBackendProjectId
          )
        ) {
          const currentTask = taskStateRef.current.extractionTask;
          const preserveCurrent = Boolean(
            currentTask.taskId
            && currentTask.nodeId === extractionNodeId
            && currentTask.taskId !== extraction.id
            && (currentTask.startedAt ?? currentTask.completedAt ?? 0) > taskStartedAt(extraction),
          );
          if (currentTask.taskId && currentTask.taskId !== extraction.id && !preserveCurrent) {
            const activeResume = activeResumeRef.current.assetExtraction;
            activeResume?.controller.abort();
            activeResumeRef.current.assetExtraction = undefined;
            if (activeResume) setExtracting(false);
          }
          setExtractionTask((current) => {
            if (
              current.taskId
              && current.nodeId === extractionNodeId
              && current.taskId !== extraction.id
              && (current.startedAt ?? current.completedAt ?? 0) > taskStartedAt(extraction)
            ) return current;
            if (backendTaskIsSuccess(extraction.status)) {
              if (currentWorkflow.lastExtractionTaskId === extraction.id) {
                return {
                  kind: "assetExtraction",
                  status: "success",
                  title: "剧本资产提取",
                  detail: `已提取 ${currentWorkflow.assets.filter((asset) => asset.source === "extracted").length} 个生产资产`,
                  taskId: extraction.id,
                  nodeId: extractionNodeId ?? undefined,
                  projectId,
                  startedAt: taskStartedAt(extraction),
                  completedAt: taskStartedAt(extraction) + Math.max(0, extraction.duration_ms),
                };
              }
              // Reuse the normal durable-task resume path to fetch and apply
              // the completed text result that arrived while the user was away.
              return {
                kind: "assetExtraction",
                status: "running",
                title: "剧本资产提取",
                detail: "已找回后台任务，正在恢复提取结果",
                taskId: extraction.id,
                nodeId: extractionNodeId ?? undefined,
                projectId,
                startedAt: taskStartedAt(extraction),
              };
            }
            if (backendTaskIsActive(extraction.status)) {
              return {
                kind: "assetExtraction",
                status: "running",
                title: "剧本资产提取",
                detail: "后台提取任务仍在进行，已重新连接",
                taskId: extraction.id,
                nodeId: extractionNodeId ?? undefined,
                projectId,
                startedAt: taskStartedAt(extraction),
              };
            }
            return {
              kind: "assetExtraction",
              status: "error",
              title: "剧本资产提取",
              detail: extraction.error_msg || "后台提取任务失败",
              taskId: extraction.id,
              nodeId: extractionNodeId ?? undefined,
              projectId,
              startedAt: taskStartedAt(extraction),
              completedAt: taskStartedAt(extraction) + Math.max(0, extraction.duration_ms),
            };
          });
        }
        if (
          storyboard
          && (
            !activeBackendProjectId
            || !storyboard.project_id
            || storyboard.project_id === activeBackendProjectId
          )
        ) {
          const currentTask = taskStateRef.current.storyboardTask;
          const preserveCurrent = Boolean(
            currentTask.taskId
            && currentTask.nodeId === storyboardNodeId
            && currentTask.taskId !== storyboard.id
            && (currentTask.startedAt ?? currentTask.completedAt ?? 0) > taskStartedAt(storyboard),
          );
          if (currentTask.taskId && currentTask.taskId !== storyboard.id && !preserveCurrent) {
            const activeResume = activeResumeRef.current.storyboardSplit;
            activeResume?.controller.abort();
            activeResumeRef.current.storyboardSplit = undefined;
            if (activeResume) setSplittingStoryboards(false);
          }
          setStoryboardTask((current) => {
            if (
              current.taskId
              && current.nodeId === storyboardNodeId
              && current.taskId !== storyboard.id
              && (current.startedAt ?? current.completedAt ?? 0) > taskStartedAt(storyboard)
            ) return current;
            const title = currentWorkflow.storyboards.length > 0 ? "重新分镜" : "生成分镜";
            if (backendTaskIsSuccess(storyboard.status)) {
              if (currentWorkflow.lastStoryboardTaskId === storyboard.id) {
                return {
                  kind: "storyboardSplit",
                  status: "success",
                  title,
                  detail: `已生成 ${currentWorkflow.storyboards.length} 个分镜草案`,
                  taskId: storyboard.id,
                  nodeId: storyboardNodeId ?? undefined,
                  projectId,
                  startedAt: taskStartedAt(storyboard),
                  completedAt: taskStartedAt(storyboard) + Math.max(0, storyboard.duration_ms),
                };
              }
              return {
                kind: "storyboardSplit",
                status: "running",
                title,
                detail: "已找回后台任务，正在恢复分镜结果",
                taskId: storyboard.id,
                nodeId: storyboardNodeId ?? undefined,
                projectId,
                startedAt: taskStartedAt(storyboard),
              };
            }
            if (backendTaskIsActive(storyboard.status)) {
              return {
                kind: "storyboardSplit",
                status: "running",
                title,
                detail: "后台分镜任务仍在进行，已重新连接",
                taskId: storyboard.id,
                nodeId: storyboardNodeId ?? undefined,
                projectId,
                startedAt: taskStartedAt(storyboard),
              };
            }
            return {
              kind: "storyboardSplit",
              status: "error",
              title,
              detail: storyboard.error_msg || "后台分镜任务失败",
              taskId: storyboard.id,
              nodeId: storyboardNodeId ?? undefined,
              projectId,
              startedAt: taskStartedAt(storyboard),
              completedAt: taskStartedAt(storyboard) + Math.max(0, storyboard.duration_ms),
            };
          });
        }
      })
      .catch(() => {
        // Local project-scoped persistence remains available when task lookup
        // is temporarily unavailable; the normal poller will retry active IDs.
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeBackendProjectId,
    expectedExtractionNodeId,
    expectedStoryboardNodeId,
    projectId,
  ]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listRecentAutomationTasks(50)
        .then((tasks) => {
          if (!cancelled) setRecentServerTasks(tasks);
        })
        .catch(() => {
          // Keep the last durable snapshot through a temporary network error.
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId]);

  useEffect(() => {
    if (extractionTask.status !== "running" || extractionTask.taskId || extractionTask.draftContent || extracting) return;
    setExtractionTask({
      kind: "assetExtraction",
      status: "error",
      title: "剧本资产提取",
      detail: "上次提取任务没有可恢复的任务编号，已停止占用页面。",
      completedAt: Date.now(),
    });
  }, [extracting, extractionTask.draftContent, extractionTask.status, extractionTask.taskId]);

  useEffect(() => {
    if (storyboardTask.status !== "running" || storyboardTask.taskId || storyboardTask.draftContent || splittingStoryboards) return;
    setStoryboardTask({
      kind: "storyboardSplit",
      status: "error",
      title: storyboardTask.title || "分镜任务",
      detail: "上次分镜任务没有可恢复的任务编号，已停止占用页面。",
      skillName: storyboardTask.skillName,
      completedAt: Date.now(),
    });
  }, [splittingStoryboards, storyboardTask.draftContent, storyboardTask.skillName, storyboardTask.status, storyboardTask.taskId, storyboardTask.title]);

  useEffect(() => {
    if (extracting || extractionTask.status !== "running" || extractionTask.taskId) return;
    if (!extractionTask.draftContent) return;
    setExtractionTask((current) => ({
      ...current,
      status: "error",
      detail: `页面刷新已中断流式接收，已保留 ${current.receivedChars ?? current.draftContent?.length ?? 0} 字草稿，请重新提取。`,
      completedAt: Date.now(),
    }));
  }, [extracting, extractionTask.draftContent, extractionTask.status, extractionTask.taskId]);

  useEffect(() => {
    if (splittingStoryboards || storyboardTask.status !== "running" || storyboardTask.taskId) return;
    if (!storyboardTask.draftContent) return;
    setStoryboardTask((current) => ({
      ...current,
      status: "error",
      detail: `页面刷新已中断流式接收，已保留 ${current.receivedChars ?? current.draftContent?.length ?? 0} 字草稿，请重新分镜。`,
      completedAt: Date.now(),
    }));
  }, [splittingStoryboards, storyboardTask.draftContent, storyboardTask.status, storyboardTask.taskId]);

  useEffect(() => {
    if (extracting || extractionTask.status !== "running" || !extractionTask.taskId) return;
    if (
      !expectedExtractionNodeId
      || extractionTask.nodeId !== expectedExtractionNodeId
      || (
        extractionTask.projectId
        && extractionTask.projectId !== projectId
      )
    ) {
      setExtractionTask(idleExtractionTask());
      return;
    }
    if (resumedTaskIdsRef.current.has(extractionTask.taskId)) return;
    resumedTaskIdsRef.current.add(extractionTask.taskId);
    const resumeToken = Symbol(extractionTask.taskId);
    const resumeController = new AbortController();
    activeResumeRef.current.assetExtraction = {
      token: resumeToken,
      controller: resumeController,
    };
    setExtracting(true);
    setNotice(null);
    const taskId = extractionTask.taskId;
    void resumeQueuedTextGeneration({
      taskId,
      expectedNodeId: expectedExtractionNodeId,
      signal: resumeController.signal,
      emptyResultMessage: "真实文字模型已完成，但没有返回可解析的提取结果。",
      failedMessage: "真实文字模型提取失败，请更换模型或稍后重试。",
      timeoutMessage: assetTaskObservationTimeoutMessage,
    })
      .then((response) => {
        if (
          activeResumeRef.current.assetExtraction?.token !== resumeToken
          || taskStateRef.current.extractionTask.taskId !== taskId
          || recoveryIdentityRef.current.extractionNodeId !== expectedExtractionNodeId
        ) return;
        const extracted = parseExtractedAssetsResponse(response.content);
        const outcome = completeAssetExtraction(extracted, taskId);
        setExtractionTask({
          kind: "assetExtraction",
          status: outcome.completed ? "success" : "error",
          title: "剧本资产提取",
          detail: outcome.completed
            ? `已提取 ${outcome.assetCount} 个生产资产${outcome.addedNames.length ? `，并补齐：${outcome.addedNames.join("、")}` : ""}`
            : "没有提取到可用资产",
          taskId,
          nodeId: expectedExtractionNodeId,
          projectId,
          completedAt: Date.now(),
        });
      })
      .catch((error) => {
        if (
          activeResumeRef.current.assetExtraction?.token !== resumeToken
          || taskStateRef.current.extractionTask.taskId !== taskId
          || recoveryIdentityRef.current.extractionNodeId !== expectedExtractionNodeId
        ) return;
        const message = error instanceof Error ? error.message : "剧本资产提取失败";
        if (message === assetTaskObservationTimeoutMessage) {
          resumedTaskIdsRef.current.delete(taskId);
          setNotice("后台提取任务仍在运行，页面会继续自动查询；你可以切换页面或稍后回来。");
          setExtractionTask((current) => ({
            ...current,
            status: "running",
            detail: "后台任务仍在运行，正在重新连接查询",
            taskId,
            nodeId: expectedExtractionNodeId,
            projectId,
          }));
          return;
        }
        setNotice(message);
        setExtractionTask({
          kind: "assetExtraction",
          status: "error",
          title: "剧本资产提取",
          detail: message,
          taskId,
          nodeId: expectedExtractionNodeId,
          projectId,
          completedAt: Date.now(),
        });
      })
      .finally(() => {
        if (activeResumeRef.current.assetExtraction?.token !== resumeToken) return;
        activeResumeRef.current.assetExtraction = undefined;
        setExtracting(false);
      });
  }, [
    activeBackendProjectId,
    expectedExtractionNodeId,
    extracting,
    extractionTask.nodeId,
    extractionTask.projectId,
    extractionTask.status,
    extractionTask.taskId,
    projectId,
  ]);

  useEffect(() => {
    if (splittingStoryboards || storyboardTask.status !== "running" || !storyboardTask.taskId) return;
    if (
      !expectedStoryboardNodeId
      || storyboardTask.nodeId !== expectedStoryboardNodeId
      || (
        storyboardTask.projectId
        && storyboardTask.projectId !== projectId
      )
    ) {
      setStoryboardTask(idleStoryboardTask());
      return;
    }
    if (resumedTaskIdsRef.current.has(storyboardTask.taskId)) return;
    resumedTaskIdsRef.current.add(storyboardTask.taskId);
    const resumeToken = Symbol(storyboardTask.taskId);
    const resumeController = new AbortController();
    activeResumeRef.current.storyboardSplit = {
      token: resumeToken,
      controller: resumeController,
    };
    setSplittingStoryboards(true);
    setNotice(null);
    const taskId = storyboardTask.taskId;
    void resumeQueuedTextGeneration({
      taskId,
      expectedNodeId: expectedStoryboardNodeId,
      signal: resumeController.signal,
      emptyResultMessage: "真实文字模型已完成，但没有返回可解析的分镜结果。",
      failedMessage: "真实文字模型拆分分镜失败，请更换模型或稍后重试。",
      timeoutMessage: storyboardTaskObservationTimeoutMessage,
    })
      .then((response) => {
        if (
          activeResumeRef.current.storyboardSplit?.token !== resumeToken
          || taskStateRef.current.storyboardTask.taskId !== taskId
          || recoveryIdentityRef.current.storyboardNodeId !== expectedStoryboardNodeId
        ) return;
        const currentAssets = recoveryIdentityRef.current.workflow.assets;
        const storyboards = parseStoryboardResponse(response.content, currentAssets);
        updateWorkflow({ storyboards, lastStoryboardTaskId: taskId });
        setStoryboardTask({
          kind: "storyboardSplit",
          status: "success",
          title: storyboardTask.title,
          detail: storyboards.length ? `已生成 ${storyboards.length} 个分镜草案` : "剧本内容不足，暂时无法拆分分镜。",
          taskId,
          nodeId: expectedStoryboardNodeId,
          projectId,
          skillName: storyboardTask.skillName,
          completedAt: Date.now(),
        });
      })
      .catch((error) => {
        if (
          activeResumeRef.current.storyboardSplit?.token !== resumeToken
          || taskStateRef.current.storyboardTask.taskId !== taskId
          || recoveryIdentityRef.current.storyboardNodeId !== expectedStoryboardNodeId
        ) return;
        const message = error instanceof Error ? error.message : "分镜拆分失败，请稍后重试。";
        if (message === storyboardTaskObservationTimeoutMessage) {
          resumedTaskIdsRef.current.delete(taskId);
          setNotice("后台分镜任务仍在运行，页面会继续自动查询；你可以切换页面或稍后回来。");
          setStoryboardTask((current) => ({
            ...current,
            status: "running",
            detail: "后台任务仍在运行，正在重新连接查询",
            taskId,
            nodeId: expectedStoryboardNodeId,
            projectId,
          }));
          return;
        }
        setNotice(message);
        setStoryboardTask({
          kind: "storyboardSplit",
          status: "error",
          title: storyboardTask.title,
          detail: message,
          taskId,
          nodeId: expectedStoryboardNodeId,
          projectId,
          skillName: storyboardTask.skillName,
          completedAt: Date.now(),
        });
      })
      .finally(() => {
        if (activeResumeRef.current.storyboardSplit?.token !== resumeToken) return;
        activeResumeRef.current.storyboardSplit = undefined;
        setSplittingStoryboards(false);
      });
  }, [
    activeBackendProjectId,
    expectedStoryboardNodeId,
    splittingStoryboards,
    storyboardTask.nodeId,
    storyboardTask.projectId,
    storyboardTask.skillName,
    storyboardTask.status,
    storyboardTask.taskId,
    storyboardTask.title,
    projectId,
  ]);

  useEffect(() => {
    let cancelled = false;
    void listAutomationTextModels()
      .then((models) => {
        if (cancelled) return;
        setTextModels(models);
        if (!workflow.textModel && models[0]) {
          updateWorkflow({
            textModel: models[0].model,
            textProviderId: models[0].providerId,
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        // The unauthenticated dev-only preview route has no app model access.
        // Give visual QA a clearly marked synthetic option; production routes
        // never receive this fallback.
        if (import.meta.env.DEV && window.location.pathname.startsWith("/__preview/")) {
          const previewModel: AutomationTextModelOption = {
            id: "__preview__:preview-text-model",
            providerId: "__preview__",
            providerName: "视觉预览",
            vendor: "Preview",
            model: "preview-text-model",
          };
          setTextModels([previewModel]);
          updateWorkflow({ textModel: previewModel.model, textProviderId: previewModel.providerId });
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => { cancelled = true; };
    // Load once for the active project. Workflow updates must not refetch the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void listAutomationImageModels()
      .then((models) => {
        if (!cancelled) setImageModels(models);
      })
      .catch(() => {
        if (!cancelled) setImageModels([]);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  const counts = useMemo(() => {
    const next: Record<AutomationAssetType, number> = {
      character: 0,
      scene: 0,
      prop: 0,
      audio: 0,
    };
    for (const asset of workflow.assets) next[asset.type] += 1;
    return next;
  }, [workflow.assets]);

  const visibleAssets = workflow.assets.filter((asset) => asset.type === assetFilter);
  const selectedAsset = workflow.assets.find((asset) => asset.id === selectedAssetId) ?? null;
  const selectedStoryboard = workflow.storyboards.find((draft) => draft.id === selectedStoryboardId) ?? null;
  const resolveStoryboardSkill = (skillId?: string) =>
    storyboardSkillOptions.find((skill) => skill.id === (skillId ?? defaultStoryboardSkillId))
    ?? storyboardSkillOptions[0];
  const selectedStoryboardSkill =
    resolveStoryboardSkill(workflow.storyboardSkillId);
  const pendingStoryboardSkill = resolveStoryboardSkill(pendingStoryboardSkillId);
  const characters = workflow.assets.filter((asset) => asset.type === "character");
  const audios = workflow.assets.filter((asset) => asset.type === "audio");
  const allLocked = workflow.assets.length > 0 && workflow.assets.every((asset) => asset.locked);
  const extractionComplete = hasCompletedScriptExtraction(workflow);
  const assetById = useMemo(
    () => new Map(workflow.assets.map((asset) => [asset.id, asset])),
    [workflow.assets],
  );
  const everyCharacterBound =
    characters.length === 0 || characters.every((character) => Boolean(character.boundAudioId));
  const localAutomationTasks = [extractionTask, storyboardTask]
    .filter((task) => task.status !== "idle");
  const localTaskIds = new Set(
    localAutomationTasks.map((task) => task.taskId).filter((id): id is string => Boolean(id)),
  );
  const recentAutomationTasks = recentServerTasks
    // The tray belongs to the open project. Keep legacy rows without project
    // metadata visible for backward compatibility, but do not mix newly tagged
    // tasks from other projects into this workspace.
    .filter((task) => {
      if (task.project_id) return task.project_id === activeBackendProjectId;
      if (activeBackendProjectId) return true;
      return task.node_id.startsWith(`automation-extract-${projectId}-`)
        || task.node_id.startsWith(`automation-storyboard-split-${projectId}-`);
    })
    .map(automationTaskStateFromServer)
    .filter((task): task is AutomationTaskState => Boolean(task))
    .filter((task) => !task.taskId || !localTaskIds.has(task.taskId));
  const automationTasks = [...localAutomationTasks, ...recentAutomationTasks]
    .sort((a, b) =>
      (b.startedAt ?? b.completedAt ?? 0) - (a.startedAt ?? a.completedAt ?? 0),
    )
    .slice(0, 12);
  const runningTaskCount = automationTasks.filter((task) => task.status === "running").length;
  const taskStatusLabel = runningTaskCount > 0
    ? `${runningTaskCount} 个进行中`
    : automationTasks.length > 0
      ? "查看任务"
      : "暂无任务";
  const automationWriteLocked =
    readingScriptFile
    || extracting
    || splittingStoryboards
    || extractionTask.status === "running"
    || storyboardTask.status === "running";
  const taskSubmissionPending =
    (extractionTask.status === "running" && !extractionTask.taskId && !extractionTask.draftContent)
    || (storyboardTask.status === "running" && !storyboardTask.taskId && !storyboardTask.draftContent);

  useEffect(() => {
    if (!taskSubmissionPending) return;
    const protectTaskHandshake = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectTaskHandshake);
    return () => window.removeEventListener("beforeunload", protectTaskHandshake);
  }, [taskSubmissionPending]);

  const progress =
    stage === "script" ? 18
      : stage === "assets" ? 46
        : stage === "lock" ? 72
          : 100;

  const updateWorkflow = (patch: Partial<AutomationWorkflow>) => {
    setWorkflow((current) => ({ ...current, ...patch, updatedAt: Date.now() }));
  };

  const completeAssetExtraction = (extracted: AutomationAsset[], taskId?: string) => {
    const uploaded = workflow.assets.filter((asset) => asset.source === "uploaded");
    const uploadedKeys = new Set(uploaded.map((asset) => `${asset.type}:${asset.name}`));
    if (extracted.length === 0) {
      updateWorkflow({
        assets: uploaded,
        storyboards: [],
        extractedScriptText: undefined,
        extractionCompletedAt: undefined,
        lastExtractionTaskId: taskId,
        lastStoryboardTaskId: undefined,
      });
      setStage("script");
      setNotice("没有从剧本中提取到人物、场景或道具，请检查剧本正文是否完整，或更换文字模型后重试。");
      return { completed: false, assetCount: 0, addedNames: [] as string[] };
    }
    const covered = ensureScriptCharacterCoverage(workflow.scriptText, [...uploaded, ...extracted]);
    const finalAssets = covered.assets.filter((asset) =>
      asset.source === "uploaded" || !uploadedKeys.has(`${asset.type}:${asset.name}`),
    );
    const extractedWithCoverage = finalAssets.filter((asset) => asset.source === "extracted");
    updateWorkflow({
      assets: finalAssets,
      storyboards: [],
      extractedScriptText: workflow.scriptText.trim(),
      extractionCompletedAt: Date.now(),
      lastExtractionTaskId: taskId,
      lastStoryboardTaskId: undefined,
    });
    setStage("assets");
    setAssetFilter("character");
    setNotice(assetCorrectionNotice(covered));
    return {
      completed: true,
      assetCount: extractedWithCoverage.length,
      addedNames: covered.addedNames,
    };
  };

  const runExtraction = async () => {
    if (automationWriteLocked) return;
    if (!workflow.scriptText.trim()) {
      setNotice("请先上传剧本或粘贴剧本正文。");
      return;
    }
    if (!workflow.textModel || !workflow.textProviderId) {
      setNotice("请先选择用于提取素材的文字模型。");
      return;
    }
    const extractionNodeId = automationTaskNodeId(
      "extract",
      projectId,
      workflow.scriptText.trim(),
    );
    setExtracting(true);
    setNotice(null);
    setExtractionTask({
      kind: "assetExtraction",
      status: "running",
      title: "剧本资产提取",
      detail: `正在使用「${workflow.textModel}」提取人物、场景、道具和音频资产`,
      nodeId: extractionNodeId,
      projectId,
      startedAt: Date.now(),
    });
    let queuedTaskId: string | undefined;
    try {
      let extracted: AutomationAsset[];
      if (workflow.textProviderId === "__preview__") {
        extracted = extractAssetsFromScript(workflow.scriptText);
      } else {
        const response = await extractAssetsWithSystemPrompt({
          script: workflow.scriptText,
          model: workflow.textModel,
          providerId: workflow.textProviderId,
          taskScope: projectId,
          projectId: activeBackendProjectId ?? undefined,
          onQueued: (taskId) => {
            queuedTaskId = taskId;
            const nextTask: AutomationTaskState = {
              kind: "assetExtraction",
              status: "running",
              title: "剧本资产提取",
              detail: "后台提取任务已创建，可以切换页面或稍后回来查看",
              taskId,
              nodeId: extractionNodeId,
              projectId,
              startedAt: Date.now(),
            };
            saveAutomationTasks(projectId, nextTask, storyboardTask);
            setExtractionTask(nextTask);
          },
        });
        const modelContent = response.content;
        try {
          extracted = parseExtractedAssetsResponse(modelContent);
        } catch (error) {
          throw new Error("真实文字模型已调用，但没有按系统提取提示词返回可用素材，请更换模型或稍后重试。");
        }
      }
      const outcome = completeAssetExtraction(extracted, queuedTaskId);
      setExtractionTask({
        kind: "assetExtraction",
        status: outcome.completed ? "success" : "error",
        title: "剧本资产提取",
        detail: outcome.completed
          ? `已提取 ${outcome.assetCount} 个生产资产${outcome.addedNames.length ? `，并补齐：${outcome.addedNames.join("、")}` : ""}`
          : "没有提取到可用资产",
        taskId: queuedTaskId,
        nodeId: extractionNodeId,
        projectId,
        completedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "剧本资产提取失败";
      if (queuedTaskId && message === assetTaskObservationTimeoutMessage) {
        const nextTask: AutomationTaskState = {
          kind: "assetExtraction",
          status: "running",
          title: "剧本资产提取",
          detail: "后台任务仍在运行，页面会继续自动查询",
          taskId: queuedTaskId,
          nodeId: extractionNodeId,
          projectId,
          startedAt: Date.now(),
        };
        saveAutomationTasks(projectId, nextTask, storyboardTask);
        setExtractionTask(nextTask);
        setNotice("后台提取任务仍在运行，你可以切换页面或稍后回来。");
        return;
      }
      const uploaded = workflow.assets.filter((asset) => asset.source === "uploaded");
      updateWorkflow({
        assets: uploaded,
        storyboards: [],
        extractedScriptText: undefined,
        extractionCompletedAt: undefined,
      });
      setStage("script");
      if (error instanceof Error && error.message.includes("系统中未找到")) {
        setNotice(error.message);
      } else {
        setNotice("没有从剧本中提取到人物、场景或道具，请检查剧本正文是否完整，或更换文字模型后重试。");
      }
      setExtractionTask({
        kind: "assetExtraction",
        status: "error",
        title: "剧本资产提取",
        detail: message,
        taskId: queuedTaskId,
        nodeId: extractionNodeId,
        projectId,
        completedAt: Date.now(),
      });
    } finally {
      setExtracting(false);
    }
  };

  const onScriptFile = async (file?: File) => {
    if (!file || automationWriteLocked) return;
    setReadingScriptFile(true);
    setNotice("正在读取剧本正文…");
    updateWorkflow({
      scriptName: file.name,
      scriptText: "",
      extractedScriptText: undefined,
      extractionCompletedAt: undefined,
      lastExtractionTaskId: undefined,
      lastStoryboardTaskId: undefined,
      assets: [],
      storyboards: [],
    });
    try {
      const text = await extractScriptDocumentText(file);
      updateWorkflow({
        scriptName: file.name,
        scriptText: text,
        extractedScriptText: undefined,
        extractionCompletedAt: undefined,
        lastExtractionTaskId: undefined,
        lastStoryboardTaskId: undefined,
        assets: [],
        storyboards: [],
      });
      setNotice(`已读取剧本正文，共 ${text.length.toLocaleString("zh-CN")} 个字符。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "剧本文件读取失败，请重试。");
    } finally {
      setReadingScriptFile(false);
    }
  };

  const chooseAssetFile = (type: AutomationAssetType, assetId?: string, variantId?: string) => {
    pendingUploadTypeRef.current = type;
    pendingUploadAssetIdRef.current = assetId ?? null;
    pendingUploadVariantIdRef.current = variantId ?? null;
    if (assetInputRef.current) {
      assetInputRef.current.accept = assetTypes.find((item) => item.key === type)?.accept ?? "*/*";
      assetInputRef.current.click();
    }
  };

  const onAssetFile = async (file?: File) => {
    if (!file) return;
    const type = pendingUploadTypeRef.current;
    const targetAssetId = pendingUploadAssetIdRef.current;
    const targetVariantId = pendingUploadVariantIdRef.current;
    setUploadingType(type);
    setNotice(null);
    try {
      const uploaded = await uploadFile(file, file.name);
      if (targetAssetId) {
        const target = workflow.assets.find((asset) => asset.id === targetAssetId);
        if (!target) throw new Error("没有找到要绑定的素材任务，请刷新后重试。");
        if (targetVariantId) {
          const patched: AutomationAsset = {
            ...target,
            variants: (target.variants ?? []).map((variant) =>
              variant.id === targetVariantId
                ? { ...variant, url: uploaded.url, fileName: file.name }
                : variant,
            ),
          };
          updateWorkflow({
            assets: workflow.assets.map((asset) => asset.id === targetAssetId ? patched : asset),
            storyboards: [],
          });
          saveAsset({
            name: `${target.name}-${patched.variants?.find((variant) => variant.id === targetVariantId)?.name ?? file.name}`,
            category: type === "prop" ? "object" : type === "audio" ? "sound" : type,
            thumbnail: type === "audio" ? "" : uploaded.url,
            url: uploaded.url,
            kind: type === "audio" ? "audio" : "image",
            folderId: "",
          });
          setAssetFilter(type);
          return;
        }
        const patched: AutomationAsset = {
          ...target,
          source: "uploaded",
          url: uploaded.url,
          fileName: file.name,
        };
        updateWorkflow({
          assets: workflow.assets.map((asset) => asset.id === targetAssetId ? patched : asset),
          storyboards: [],
        });
        saveAsset({
          name: patched.name,
          category: type === "prop" ? "object" : type === "audio" ? "sound" : type,
          thumbnail: type === "audio" ? "" : uploaded.url,
          url: uploaded.url,
          kind: type === "audio" ? "audio" : "image",
          folderId: "",
        });
        setAssetFilter(type);
        return;
      }
      const created: AutomationAsset = {
        id: `auto-upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        name: file.name.replace(/\.[^.]+$/, ""),
        description: `手动上传的${typeLabel(type)}素材`,
        source: "uploaded",
        url: uploaded.url,
        fileName: file.name,
        locked: false,
      };
      updateWorkflow({ assets: [...workflow.assets, created], storyboards: [] });
      saveAsset({
        name: created.name,
        category: type === "prop" ? "object" : type === "audio" ? "sound" : type,
        thumbnail: type === "audio" ? "" : uploaded.url,
        url: uploaded.url,
        kind: type === "audio" ? "audio" : "image",
        folderId: "",
      });
      setAssetFilter(type);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "素材上传失败，请稍后重试。");
    } finally {
      setUploadingType(null);
      pendingUploadAssetIdRef.current = null;
      pendingUploadVariantIdRef.current = null;
      if (assetInputRef.current) assetInputRef.current.value = "";
    }
  };

  const addManualAsset = () => {
    const name = newAssetName.trim();
    if (!name) return;
    const created: AutomationAsset = {
      id: `auto-manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: assetFilter,
      name,
      description: `手动新增的${typeLabel(assetFilter)}资产`,
      source: "uploaded",
      locked: false,
    };
    updateWorkflow({ assets: [...workflow.assets, created], storyboards: [] });
    setNewAssetName("");
    setAddingAsset(false);
  };

  const patchAsset = (assetId: string, patch: Partial<AutomationAsset>) => {
    updateWorkflow({
      assets: workflow.assets.map((asset) => asset.id === assetId ? { ...asset, ...patch } : asset),
      storyboards: [],
    });
  };

  const removeAsset = (assetId: string) => {
    updateWorkflow({
      assets: workflow.assets
        .filter((asset) => asset.id !== assetId)
        .map((asset) => asset.boundAudioId === assetId ? { ...asset, boundAudioId: undefined } : asset),
      storyboards: [],
    });
  };

  const goToLockStage = () => {
    if (!extractionComplete) {
      setNotice("请先完成剧本资产提取，再整理和确认素材。");
      setStage("script");
      return;
    }
    if (workflow.assets.length === 0) {
      setNotice("至少需要一个素材才能进入资产锁定。");
      return;
    }
    setNotice(null);
    setStage("lock");
  };

  const lockAllAssets = () => {
    if (automationWriteLocked) return;
    if (!extractionComplete || workflow.assets.length === 0) {
      setNotice("请先完成剧本资产提取并确认素材，再锁定资产。");
      setStage(extractionComplete ? "assets" : "script");
      return;
    }
    if (characters.length > 0 && audios.length === 0) {
      setNotice("请先上传至少一条音频，并为人物绑定声音。");
      setAssetFilter("audio");
      setStage("assets");
      return;
    }
    if (!everyCharacterBound) {
      setNotice("还有人物没有绑定音频，请完成绑定后再锁定。");
      return;
    }
    updateWorkflow({ assets: workflow.assets.map((asset) => ({ ...asset, locked: true })) });
    setNotice(null);
    setStage("storyboard");
  };

  const generateStoryboardsFallback = () => {
    if (!allLocked) {
      setNotice("素材发生过变化，请重新确认并锁定全部资产。");
      setStage("lock");
      return;
    }
    const storyboards = buildStoryboardDrafts(workflow.scriptText, workflow.assets);
    updateWorkflow({ storyboards });
    setNotice(storyboards.length ? null : "剧本内容不足，暂时无法拆分分镜。");
  };

  const generateStoryboards = async (storyboardSkillId = workflow.storyboardSkillId ?? defaultStoryboardSkillId) => {
    if (automationWriteLocked) return;
    if (!allLocked) {
      setNotice("素材发生过变化，请重新确认并锁定全部资产。");
      setStage("lock");
      return;
    }
    if (!workflow.textModel || !workflow.textProviderId) {
      setNotice("请先选择用于拆分分镜的文字模型。");
      setStage("script");
      return;
    }
    setSplittingStoryboards(true);
    setNotice(null);
    let queuedTaskId: string | undefined;
    const storyboardSkill = resolveStoryboardSkill(storyboardSkillId);
    const storyboardNodeId = automationTaskNodeId(
      "storyboard-split",
      projectId,
      storyboardTaskFingerprintSource({
        script: workflow.scriptText,
        assets: workflow.assets,
        storyboardSkillName: storyboardSkill?.name,
      }),
    );
    try {
      let storyboards;
      updateWorkflow({ storyboardSkillId });
      setShowStoryboardSkillPicker(false);
      setStoryboardTask({
        kind: "storyboardSplit",
        status: "running",
        title: workflow.storyboards.length > 0 ? "重新分镜" : "生成分镜",
        detail: `正在使用「${storyboardSkill?.name ?? "分镜技能"}」调用文字模型`,
        nodeId: storyboardNodeId,
        projectId,
        skillName: storyboardSkill?.name,
        startedAt: Date.now(),
      });
      if (workflow.textProviderId === "__preview__") {
        storyboards = buildStoryboardDrafts(workflow.scriptText, workflow.assets);
      } else {
        const response = await splitScriptToStoryboardsWithSystemPrompt({
          script: workflow.scriptText,
          assets: workflow.assets,
          model: workflow.textModel,
          providerId: workflow.textProviderId,
          taskScope: projectId,
          projectId: activeBackendProjectId ?? undefined,
          storyboardSkillName: storyboardSkill?.name,
          storyboardSkillPrompt: storyboardSkill?.prompt,
          onQueued: (taskId) => {
            queuedTaskId = taskId;
            const nextTask: AutomationTaskState = {
              kind: "storyboardSplit",
              status: "running",
              title: workflow.storyboards.length > 0 ? "重新分镜" : "生成分镜",
              detail: "后台分镜任务已创建，可以切换页面或稍后回来查看",
              taskId,
              nodeId: storyboardNodeId,
              projectId,
              skillName: storyboardSkill?.name,
              startedAt: Date.now(),
            };
            saveAutomationTasks(projectId, extractionTask, nextTask);
            setStoryboardTask(nextTask);
          },
        });
        const modelContent = response.content;
        storyboards = parseStoryboardResponse(modelContent, workflow.assets);
      }
      updateWorkflow({
        storyboardSkillId,
        storyboards,
        lastStoryboardTaskId: queuedTaskId,
      });
      setShowStoryboardSkillPicker(false);
      setNotice(storyboards.length ? null : "剧本内容不足，暂时无法拆分分镜。");
      setStoryboardTask({
        kind: "storyboardSplit",
        status: "success",
        title: workflow.storyboards.length > 0 ? "重新分镜" : "生成分镜",
        detail: storyboards.length ? `已生成 ${storyboards.length} 个分镜草案` : "剧本内容不足，暂时无法拆分分镜。",
        taskId: queuedTaskId,
        nodeId: storyboardNodeId,
        projectId,
        skillName: storyboardSkill?.name,
        completedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "分镜拆分失败，请稍后重试。";
      if (queuedTaskId && message === storyboardTaskObservationTimeoutMessage) {
        const nextTask: AutomationTaskState = {
          kind: "storyboardSplit",
          status: "running",
          title: workflow.storyboards.length > 0 ? "重新分镜" : "生成分镜",
          detail: "后台任务仍在运行，页面会继续自动查询",
          taskId: queuedTaskId,
          nodeId: storyboardNodeId,
          projectId,
          skillName: resolveStoryboardSkill(storyboardSkillId)?.name,
          startedAt: Date.now(),
        };
        saveAutomationTasks(projectId, extractionTask, nextTask);
        setStoryboardTask(nextTask);
        setNotice("后台分镜任务仍在运行，你可以切换页面或稍后回来。");
        return;
      }
      setNotice(message);
      setStoryboardTask({
        kind: "storyboardSplit",
        status: "error",
        title: workflow.storyboards.length > 0 ? "重新分镜" : "生成分镜",
        detail: message,
        taskId: queuedTaskId,
        nodeId: storyboardNodeId,
        projectId,
        skillName: resolveStoryboardSkill(storyboardSkillId)?.name,
        completedAt: Date.now(),
      });
    } finally {
      setSplittingStoryboards(false);
    }
  };

  const patchStoryboard = (storyboardId: string, patch: Partial<(typeof workflow.storyboards)[number]>) => {
    if (automationWriteLocked) return;
    updateWorkflow({
      storyboards: workflow.storyboards.map((draft) =>
        draft.id === storyboardId ? { ...draft, ...patch } : draft,
      ),
    });
  };

  const generateSelectedStoryboardImage = async () => {
    if (!selectedStoryboard || generatingStoryboardId || automationWriteLocked) return;
    const model = selectedStoryboard.imageModel ?? imageModels[0]?.model;
    const providerId = selectedStoryboard.imageProviderId ?? imageModels[0]?.providerId;
    if (!model || !providerId) {
      setNotice("请先配置可用的图片模型。");
      return;
    }
    setGeneratingStoryboardId(selectedStoryboard.id);
    setNotice(null);
    try {
      const referenceImages = selectedStoryboard.assetIds
        .map((assetId) => assetById.get(assetId)?.url)
        .filter((url): url is string => Boolean(url));
      const response = await generateStoryboardImage({
        prompt: selectedStoryboard.prompt ?? selectedStoryboard.description,
        model,
        providerId,
        projectId: activeBackendProjectId ?? undefined,
        referenceImages,
      });
      patchStoryboard(selectedStoryboard.id, {
        imageUrl: response.content,
        imageModel: model,
        imageProviderId: providerId,
        status: "generated",
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "分镜图生成失败，请稍后重试。");
    } finally {
      setGeneratingStoryboardId(null);
    }
  };

  const createCanvasTasksLegacy = () => {
    const drafts = workflow.storyboards.length
      ? workflow.storyboards
      : buildStoryboardDrafts(workflow.scriptText, workflow.assets);
    if (!drafts.length) {
      setNotice("请先生成分镜草案。");
      return;
    }
    const state = useStore.getState();
    drafts.forEach((draft, index) => {
      const related = workflow.assets
        .filter((asset) => draft.assetIds.includes(asset.id))
        .map((asset) => asset.name)
        .join("、");
      state.addNode({
        id: `automation-storyboard-${Date.now()}-${index}`,
        type: "imageNode",
        position: { x: 180 + (index % 3) * 390, y: 160 + Math.floor(index / 3) * 430 },
        data: {
          label: draft.title,
          prompt: `电影分镜黑白线稿，${draft.shot}，画面清晰，构图明确。${draft.description}${related ? `。锁定资产：${related}` : ""}`,
          status: "idle",
          sourceKind: "automation-storyboard",
          generationParams: { aspectRatio: "16:9" },
        },
      } as never);
    });
    updateWorkflow({ storyboards: drafts.map((draft) => ({ ...draft, status: "queued" })) });
    navigate("/app");
  };

  const createCanvasTasks = () => {
    const drafts = workflow.storyboards.length
      ? workflow.storyboards
      : buildStoryboardDrafts(workflow.scriptText, workflow.assets);
    if (!drafts.length) {
      setNotice("请先生成分镜草案。");
      return;
    }
    const state = useStore.getState();
    drafts.forEach((draft, index) => {
      const related = workflow.assets
        .filter((asset) => draft.assetIds.includes(asset.id))
        .map((asset) => asset.name)
        .join("、");
      state.addNode({
        id: `automation-storyboard-${Date.now()}-${index}`,
        type: "imageNode",
        position: { x: 180 + (index % 3) * 390, y: 160 + Math.floor(index / 3) * 430 },
        data: {
          label: draft.title,
          prompt: `${draft.prompt ?? `电影分镜黑白线稿，${draft.shot}，画面清晰，构图明确。${draft.description}`}${related ? `。锁定资产：${related}` : ""}`,
          status: "idle",
          sourceKind: "automation-storyboard",
          generationParams: { aspectRatio: "16:9" },
        },
      } as never);
    });
    updateWorkflow({ storyboards: drafts.map((draft) => ({ ...draft, status: "queued" })) });
    navigate("/app");
  };

  const openProgressItem = (key: Stage | "image" | "canvas") => {
    if (taskSubmissionPending) return;
    if (isStageKey(key)) {
      setStage(key);
      return;
    }
    if (key === "image") {
      setStage("storyboard");
      const firstStoryboard = workflow.storyboards[0];
      if (!firstStoryboard) {
        setNotice("请先完成分镜拆分，再进入分镜图生成。");
        return;
      }
      setNotice(null);
      setSelectedStoryboardId(firstStoryboard.id);
      return;
    }
    navigate("/app");
  };

  return (
    <div className="min-h-screen bg-[#111215] text-neutral-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(rgba(255,255,255,0.045)_1px,transparent_1px)] [background-size:24px_24px]" />
      <input
        ref={scriptInputRef}
        type="file"
        accept=".txt,.md,.fountain,.pdf,.doc,.docx"
        className="hidden"
        disabled={automationWriteLocked}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void onScriptFile(file);
        }}
      />
      <input
        ref={assetInputRef}
        type="file"
        className="hidden"
        disabled={automationWriteLocked}
        onChange={(event) => void onAssetFile(event.target.files?.[0])}
      />

      <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-white/[0.06] bg-[#141519]/95 px-6 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => navigate("/home")}
            disabled={taskSubmissionPending}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.035] text-neutral-400 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-40"
            aria-label="返回项目"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2.5">
            <img src={logoUrl} alt="CCY Canvas" className="h-7 w-7 rounded object-contain" />
            <div>
              <div className="text-[13px] font-semibold text-neutral-100">CCY Canvas</div>
              <div className="max-w-[240px] truncate text-[10.5px] text-neutral-500">{projectName}</div>
            </div>
          </div>
        </div>
        <div className="relative flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowTaskList((current) => !current)}
            className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] transition sm:flex ${
              runningTaskCount > 0
                ? "border-[#ff6a33]/35 bg-[#ff5b24]/[0.09] text-[#ff956f]"
                : "border-white/10 bg-white/[0.035] text-neutral-400 hover:bg-white/[0.07] hover:text-neutral-200"
            }`}
          >
            {runningTaskCount > 0 ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            任务列表 · {taskStatusLabel}
          </button>
          <div className="hidden items-center gap-2 rounded-full border border-[#ff6a33]/20 bg-[#ff5b24]/[0.07] px-3 py-1.5 text-[11px] text-[#ff956f] sm:flex">
            <Bot className="h-3.5 w-3.5" />
            全自动创作
          </div>
          {showTaskList ? (
            <div className="absolute right-0 top-11 z-50 w-[340px] rounded-[18px] border border-white/[0.09] bg-[#17181d] p-3 shadow-[0_24px_90px_rgba(0,0,0,0.45)]">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-[12px] font-semibold text-neutral-200">任务列表</span>
                <button
                  type="button"
                  onClick={() => setShowTaskList(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-500 transition hover:bg-white/[0.06] hover:text-white"
                  aria-label="关闭任务列表"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
                {automationTasks.length > 0 ? automationTasks.map((task, index) => (
                  <div key={task.taskId ?? `${task.kind}-${index}`} className="rounded-[14px] border border-white/[0.07] bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        {task.status === "running" ? (
                          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[#ff875f]" />
                        ) : task.status === "success" ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        ) : (
                          <X className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                        )}
                        <span className="truncate text-[11.5px] font-medium text-neutral-200">{task.title}</span>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9.5px] ${
                        task.status === "running"
                          ? "bg-[#ff5b24]/10 text-[#ff956f]"
                          : task.status === "success"
                            ? "bg-emerald-500/10 text-emerald-300/75"
                            : "bg-rose-500/10 text-rose-300/80"
                      }`}>
                        {task.status === "running" ? "进行中" : task.status === "success" ? "已完成" : "失败"}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[10.5px] leading-5 text-neutral-500">{task.detail}</p>
                    {task.receivedChars ? (
                      <p className="mt-1 text-[9.5px] text-[#ff956f]/75">已接收：{task.receivedChars} 字</p>
                    ) : null}
                    {task.taskId ? <p className="mt-1 truncate text-[9.5px] text-neutral-700">任务编号：{task.taskId}</p> : null}
                  </div>
                )) : (
                  <div className="rounded-[14px] border border-dashed border-white/[0.08] p-5 text-center text-[11px] text-neutral-600">
                    暂无后台任务
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </header>

      <div className="relative z-10 px-4 pt-5 lg:px-6">
        <div className="rounded-[22px] border border-white/[0.07] bg-[#17181c]/95 px-5 py-4 shadow-[0_18px_70px_rgba(0,0,0,0.2)]">
          <div className="mb-4 flex items-center justify-between gap-4 text-[11px] text-neutral-500">
            <span>制作进度</span>
            <span className="tabular-nums text-neutral-400">{progress}%</span>
          </div>
          <div className="mb-4 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-[#ff6633] transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
          <nav className="grid gap-2 md:grid-cols-3 xl:grid-cols-6" aria-label="自动创作步骤">
            {progressItems.map((item) => {
              const stageKey = isStageKey(item.key) ? item.key : null;
              const active = stageKey !== null && stage === stageKey;
              const visited = stageKey !== null && stageRank(stageKey) < stageRank(stage);
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => openProgressItem(item.key)}
                  disabled={taskSubmissionPending}
                  className={`flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    active
                      ? "bg-white/[0.07] text-white"
                      : "text-neutral-400 hover:bg-white/[0.035] hover:text-neutral-200"
                  } disabled:cursor-wait disabled:opacity-45`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                    active
                      ? "border-[#ff6a33]/45 bg-[#ff5b24]/15 text-[#ff8b62]"
                      : visited
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        : "border-white/10 bg-white/[0.025] text-neutral-500"
                  }`}>
                    {visited ? <Check className="h-3.5 w-3.5" /> : item.index}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium">{item.title}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-neutral-600">{item.subtitle}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="relative z-10 w-full px-4 py-5 lg:px-6">
        <aside className="hidden">
          <div className="sticky top-21 rounded-[22px] border border-white/[0.07] bg-[#17181c]/95 p-4">
            <div className="mb-5 px-2 pt-1">
              <div className="flex items-center justify-between text-[11px] text-neutral-500">
                <span>制作进度</span>
                <span className="tabular-nums text-neutral-400">{progress}%</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-[#ff6633] transition-all duration-500" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <nav className="space-y-1.5" aria-label="自动创作步骤">
              {stageItems.map((item) => {
                const active = stage === item.key;
                const visited = stageRank(item.key) < stageRank(stage);
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setStage(item.key)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                      active
                        ? "bg-white/[0.07] text-white"
                        : "text-neutral-400 hover:bg-white/[0.035] hover:text-neutral-200"
                    }`}
                  >
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                      active
                        ? "border-[#ff6a33]/45 bg-[#ff5b24]/15 text-[#ff8b62]"
                        : visited
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          : "border-white/10 bg-white/[0.025] text-neutral-500"
                    }`}>
                      {visited ? <Check className="h-3.5 w-3.5" /> : item.index}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium">{item.title}</span>
                      <span className="mt-0.5 block truncate text-[10.5px] text-neutral-600">{item.subtitle}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>
        </aside>

        <main className="min-w-0 w-full rounded-[24px] border border-white/[0.07] bg-[#17181c]/95 shadow-[0_26px_90px_rgba(0,0,0,0.28)]">
          {notice ? (
            <div className="mx-5 mt-5 flex items-start justify-between gap-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-[12px] leading-5 text-amber-100/80">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-amber-200/50 hover:text-amber-100">×</button>
            </div>
          ) : null}

          {stage === "script" ? (
            <section className="p-5 sm:p-8" data-testid="automation-script-stage">
              <div className="mb-7">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#ff8055]">
                  <FileText className="h-3.5 w-3.5" />
                  Script intake
                </div>
                <h1 className="text-[25px] font-semibold tracking-tight text-white">从剧本开始创作</h1>
                <p className="mt-2 max-w-2xl text-[12.5px] leading-6 text-neutral-500">
                  上传剧本或直接粘贴正文。系统会识别人物、场景、道具和声音线索，整理成可锁定的生产资产。
                </p>
              </div>

              <div className="mb-5 rounded-[18px] border border-white/[0.08] bg-[#121317] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-300">
                      <Bot className="h-4 w-4 text-[#ff865d]" />
                      选择文字模型
                    </div>
                    <p className="mt-1.5 text-[10.5px] text-neutral-600">
                      将调用系统“剧本资产提取”提示词，识别人物、场景和道具。
                    </p>
                  </div>
                  <AutomationModelPicker
                    value={workflow.textModel && workflow.textProviderId ? `${workflow.textProviderId}:${workflow.textModel}` : ""}
                    options={textModels}
                    onChange={(selected) => {
                      updateWorkflow({
                        textModel: selected.model,
                        textProviderId: selected.providerId,
                        extractedScriptText: undefined,
                        extractionCompletedAt: undefined,
                        assets: [],
                        storyboards: [],
                      });
                    }}
                    disabled={automationWriteLocked || modelsLoading || textModels.length === 0}
                    loading={modelsLoading}
                    placeholder="暂无可用文字模型"
                    testId="automation-text-model"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  if (!automationWriteLocked) scriptInputRef.current?.click();
                }}
                disabled={automationWriteLocked}
                className="group flex min-h-[168px] w-full flex-col items-center justify-center rounded-[18px] border border-dashed border-white/15 bg-white/[0.02] px-6 text-center transition hover:border-[#ff6a33]/45 hover:bg-[#ff5b24]/[0.025] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-white/15 disabled:hover:bg-white/[0.02]"
              >
                <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.045] text-neutral-400 transition group-hover:border-[#ff6a33]/25 group-hover:text-[#ff845a]">
                  {readingScriptFile
                    ? <LoaderCircle className="h-5 w-5 animate-spin" />
                    : <Upload className="h-5 w-5" />}
                </span>
                <span className="text-[13px] font-medium text-neutral-200">
                  {readingScriptFile ? "正在读取剧本正文…" : (workflow.scriptName || "点击上传剧本文件")}
                </span>
                <span className="mt-1.5 text-[10.5px] text-neutral-600">TXT · Markdown · Fountain · PDF · Word</span>
              </button>

              <div className="my-5 flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-neutral-700">
                <div className="h-px flex-1 bg-white/[0.06]" />
                或粘贴正文
                <div className="h-px flex-1 bg-white/[0.06]" />
              </div>

              <textarea
                value={workflow.scriptText}
                onChange={(event) => {
                  setNotice(null);
                  updateWorkflow({
                    scriptText: event.target.value,
                    extractedScriptText: undefined,
                    extractionCompletedAt: undefined,
                    assets: [],
                    storyboards: [],
                  });
                }}
                disabled={automationWriteLocked}
                placeholder={"示例：\n场景一：雨夜车站\n人物：林默、苏晴\n林默：我们只剩五分钟。\n音效：远处列车驶来……"}
                className="min-h-[250px] w-full resize-y rounded-[18px] border border-white/[0.08] bg-[#111216] px-5 py-4 font-mono text-[12.5px] leading-6 text-neutral-300 outline-none transition placeholder:text-neutral-700 focus:border-[#ff6a33]/35 disabled:cursor-not-allowed disabled:opacity-60"
              />

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => void runExtraction()}
                  disabled={automationWriteLocked || !workflow.scriptText.trim() || !workflow.textModel}
                  data-testid="extract-script-assets"
                  className="flex items-center gap-2 rounded-full bg-[#f0f0f0] px-5 py-2.5 text-[12.5px] font-semibold text-[#141518] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {extracting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {extracting ? "正在调用模型提取" : "提取所需素材"}
                  {!extracting ? <ArrowRight className="h-3.5 w-3.5" /> : null}
                </button>
              </div>
            </section>
          ) : null}

          {stage === "assets" ? (
            <section className="p-5 sm:p-8" data-testid="automation-assets-stage">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#ff8055]">
                    <Sparkles className="h-3.5 w-3.5" />
                    Asset breakdown
                  </div>
                  <h1 className="text-[25px] font-semibold tracking-tight text-white">确认生产素材</h1>
                  <p className="mt-2 text-[12.5px] text-neutral-500">检查自动提取结果，也可以为每个分类补充自己的素材。</p>
                </div>
                <button
                  type="button"
                  onClick={() => void runExtraction()}
                  className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3.5 py-2 text-[11.5px] text-neutral-400 transition hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {extracting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  {extracting ? "正在重新提取" : "重新提取"}
                </button>
              </div>

              <div className="mt-7 flex gap-1 overflow-x-auto rounded-xl border border-white/[0.07] bg-[#121317] p-1.5">
                {assetTypes.map((item) => {
                  const Icon = item.icon;
                  const active = assetFilter === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setAssetFilter(item.key)}
                      className={`flex min-w-[112px] flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[12px] transition ${
                        active ? "bg-white/[0.09] text-white" : "text-neutral-500 hover:text-neutral-300"
                      }`}
                    >
                      <Icon className={`h-3.5 w-3.5 ${active ? "text-[#ff865e]" : ""}`} />
                      {item.label}
                      <span className="rounded-full bg-black/25 px-1.5 py-0.5 text-[9.5px] tabular-nums text-neutral-500">
                        {counts[item.key]}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 grid min-h-[310px] grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
                {visibleAssets.map((asset) => {
                  const Icon = assetTypes.find((item) => item.key === asset.type)?.icon ?? Package;
                  const uploadingThisAsset = uploadingType === asset.type && pendingUploadAssetIdRef.current === asset.id;
                  return (
                    <article key={asset.id} className="group relative min-h-[184px] overflow-hidden rounded-[16px] border border-white/[0.08] bg-[#131418] transition hover:border-[#ff6a33]/35 hover:bg-[#18191e]">
                      <button
                        type="button"
                        onClick={() => {
                          if (asset.type === "character") {
                            setSelectedAssetId(asset.id);
                            return;
                          }
                          chooseAssetFile(asset.type, asset.id);
                        }}
                        disabled={(asset.type !== "character" && automationWriteLocked) || uploadingType !== null}
                        className="absolute inset-0 flex flex-col justify-end text-left disabled:cursor-not-allowed"
                        aria-label={asset.type === "character" ? `打开${asset.name}角色详情` : `上传${asset.name}素材`}
                      >
                        {asset.url && asset.type !== "audio" ? (
                          <MediaThumb src={asset.url} alt={asset.name} className="absolute inset-0 h-full w-full object-cover" />
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center bg-white/[0.018] text-neutral-600 transition group-hover:text-[#ff8b63]">
                            {uploadingThisAsset ? <LoaderCircle className="h-6 w-6 animate-spin" /> : <Icon className="h-6 w-6" />}
                          </span>
                        )}
                        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3.5 pb-3 pt-10">
                          <span className="block truncate text-[11px] font-medium text-neutral-200" title={asset.name}>{asset.name}</span>
                        </span>
                      </button>
                      {asset.locked ? <Lock className="pointer-events-none absolute left-3 top-3 z-10 h-3.5 w-3.5 text-emerald-400" /> : null}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (automationWriteLocked) return;
                          removeAsset(asset.id);
                        }}
                        disabled={automationWriteLocked}
                        className="absolute right-2.5 top-2.5 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/55 text-neutral-500 opacity-0 backdrop-blur transition hover:text-rose-300 group-hover:opacity-100"
                        aria-label={`删除${asset.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </article>
                  );
                })}

                <button
                  type="button"
                  onClick={() => chooseAssetFile(assetFilter)}
                  disabled={automationWriteLocked || uploadingType !== null}
                  className="flex min-h-[184px] flex-col items-center justify-center rounded-[16px] border border-dashed border-white/12 bg-white/[0.018] text-neutral-500 transition hover:border-[#ff6a33]/35 hover:bg-[#ff5b24]/[0.02] hover:text-[#ff8b63] disabled:opacity-40"
                >
                  {uploadingType === assetFilter ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                  <span className="mt-2 text-[11.5px]">上传{typeLabel(assetFilter)}素材</span>
                </button>
              </div>

              <div className="mt-4 flex min-h-10 items-center">
                {addingAsset ? (
                  <div className="flex w-full max-w-md items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] p-1 pl-4">
                    <input
                      autoFocus
                      value={newAssetName}
                      onChange={(event) => setNewAssetName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") addManualAsset();
                        if (event.key === "Escape") setAddingAsset(false);
                      }}
                      placeholder={`输入${typeLabel(assetFilter)}名称`}
                      disabled={automationWriteLocked}
                      className="min-w-0 flex-1 bg-transparent text-[12px] text-neutral-200 outline-none placeholder:text-neutral-600"
                    />
                    <button type="button" onClick={addManualAsset} disabled={automationWriteLocked} className="rounded-full bg-white px-3 py-1.5 text-[11px] font-medium text-black disabled:opacity-40">添加</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingAsset(true)}
                    disabled={automationWriteLocked}
                    className="flex items-center gap-1.5 text-[11.5px] text-neutral-500 transition hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    新增文字素材
                  </button>
                )}
              </div>

              <div className="mt-7 flex items-center justify-between border-t border-white/[0.06] pt-5">
                <button type="button" onClick={() => setStage("script")} className="flex items-center gap-2 text-[11.5px] text-neutral-500 hover:text-neutral-200">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回剧本
                </button>
                <button
                  type="button"
                  onClick={goToLockStage}
                  className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-[12px] font-semibold text-[#131418] transition hover:bg-neutral-200"
                >
                  确认素材
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </section>
          ) : null}

          {stage === "lock" ? (
            <section className="p-5 sm:p-8" data-testid="automation-lock-stage">
              <div>
                <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#ff8055]">
                  <Lock className="h-3.5 w-3.5" />
                  Continuity lock
                </div>
                <h1 className="text-[25px] font-semibold tracking-tight text-white">绑定声音并锁定资产</h1>
                <p className="mt-2 max-w-2xl text-[12.5px] leading-6 text-neutral-500">
                  锁定后，后续每个分镜都会引用同一套人物、场景和道具设定，减少跨镜头漂移。
                </p>
              </div>

              <div className="mt-7 grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
                <div className="rounded-[18px] border border-white/[0.07] bg-[#121317] p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-300">
                      <Volume2 className="h-4 w-4 text-[#ff875f]" />
                      人物声音绑定
                    </div>
                    <span className="text-[10px] text-neutral-600">{characters.filter((item) => item.boundAudioId).length} / {characters.length}</span>
                  </div>
                  <div className="space-y-2.5">
                    {characters.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-[11.5px] text-neutral-600">剧本中没有人物资产</div>
                    ) : characters.map((character) => (
                      <div key={character.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3.5 py-3">
                        <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-white/[0.05] text-neutral-500">
                          {character.url ? <MediaThumb src={character.url} alt={character.name} className="h-full w-full object-cover" /> : <UserRound className="h-4 w-4" />}
                        </span>
                        <div className="min-w-[100px] flex-1">
                          <div className="text-[12px] text-neutral-200">{character.name}</div>
                          <div className="mt-0.5 text-[9.5px] text-neutral-600">人物资产</div>
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 text-neutral-700" />
                        <select
                          value={character.boundAudioId ?? ""}
                          onChange={(event) => patchAsset(character.id, { boundAudioId: event.target.value || undefined, locked: false })}
                          disabled={automationWriteLocked}
                          className="min-w-[180px] rounded-xl border border-white/10 bg-[#191a1f] px-3 py-2 text-[11px] text-neutral-300 outline-none focus:border-[#ff6a33]/35 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="">选择绑定音频</option>
                          {audios.map((audio) => <option key={audio.id} value={audio.id}>{audio.name}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                  {characters.length > 0 && audios.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => { setAssetFilter("audio"); setStage("assets"); }}
                      className="mt-3 flex items-center gap-1.5 text-[11px] text-[#ff8a61] hover:text-[#ffa080]"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      上传人物配音
                    </button>
                  ) : null}
                </div>

                <div className="rounded-[18px] border border-white/[0.07] bg-[#121317] p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-300">
                      <Package className="h-4 w-4 text-[#ff875f]" />
                      资产检查
                    </div>
                    <span className="text-[10px] text-neutral-600">{workflow.assets.length} 项</span>
                  </div>
                  <div className="space-y-2">
                    {assetTypes.map((item) => {
                      const Icon = item.icon;
                      return (
                        <div key={item.key} className="flex items-center justify-between rounded-xl bg-white/[0.025] px-3 py-2.5">
                          <span className="flex items-center gap-2 text-[11px] text-neutral-400">
                            <Icon className="h-3.5 w-3.5 text-neutral-600" />
                            {item.label}
                          </span>
                          <span className="text-[11px] tabular-nums text-neutral-500">{counts[item.key]}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className={`mt-4 rounded-xl border px-3.5 py-3 text-[10.5px] leading-5 ${
                    everyCharacterBound
                      ? "border-emerald-500/15 bg-emerald-500/[0.045] text-emerald-300/70"
                      : "border-amber-400/15 bg-amber-400/[0.045] text-amber-200/70"
                  }`}>
                    {everyCharacterBound ? "声音绑定检查已通过，可以锁定资产。" : "请为每个人物选择对应音频。"}
                  </div>
                </div>
              </div>

              <div className="mt-7 flex items-center justify-between border-t border-white/[0.06] pt-5">
                <button type="button" onClick={() => setStage("assets")} className="flex items-center gap-2 text-[11.5px] text-neutral-500 hover:text-neutral-200">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  修改素材
                </button>
                <button
                  type="button"
                  onClick={lockAllAssets}
                  disabled={automationWriteLocked}
                  className="flex items-center gap-2 rounded-full bg-[#ff6330] px-5 py-2.5 text-[12px] font-semibold text-white shadow-[0_10px_32px_rgba(255,87,35,0.18)] transition hover:bg-[#ff7143] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Lock className="h-3.5 w-3.5" />
                  锁定全部资产
                </button>
              </div>
            </section>
          ) : null}

          {stage === "storyboard" ? (
            <section className="p-5 sm:p-8" data-testid="automation-storyboard-stage">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[#ff8055]">
                    <Film className="h-3.5 w-3.5" />
                    Storyboard production
                  </div>
                  <h1 className="text-[25px] font-semibold tracking-tight text-white">分镜图与线稿任务</h1>
                  <p className="mt-2 max-w-2xl text-[12.5px] leading-6 text-neutral-500">
                    分镜会自动引用已锁定资产，保证人物、场景和关键道具在镜头间保持一致。
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {workflow.storyboards.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setPendingStoryboardSkillId(workflow.storyboardSkillId ?? defaultStoryboardSkillId);
                        setShowStoryboardSkillPicker((current) => !current);
                      }}
                      disabled={automationWriteLocked}
                      className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3.5 py-1.5 text-[10.5px] font-medium text-neutral-300 transition hover:border-[#ff6a33]/35 hover:bg-[#ff5b24]/[0.06] hover:text-[#ff9a73] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {splittingStoryboards ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      重新分镜
                    </button>
                  ) : null}
                  <div className="flex items-center gap-2 rounded-full border border-emerald-500/15 bg-emerald-500/[0.05] px-3 py-1.5 text-[10.5px] text-emerald-300/70">
                    <Lock className="h-3 w-3" />
                    {workflow.assets.length} 项资产已锁定
                  </div>
                </div>
              </div>

              {workflow.storyboards.length === 0 ? (
                <div className="mt-8 flex min-h-[360px] flex-col items-center justify-center rounded-[20px] border border-dashed border-white/10 bg-[#121317] px-6 text-center">
                  <span className="flex h-14 w-14 items-center justify-center rounded-[20px] border border-[#ff6a33]/20 bg-[#ff5b24]/[0.07] text-[#ff865d]">
                    <Film className="h-6 w-6" />
                  </span>
                  <h2 className="mt-5 text-[16px] font-semibold text-neutral-200">准备拆分镜头</h2>
                  <p className="mt-2 max-w-md text-[11.5px] leading-5 text-neutral-600">系统将根据剧本段落和锁定素材生成镜头描述、景别、时长以及黑白线稿提示词。</p>
                  <div className="mt-6 w-full max-w-xl rounded-[18px] border border-white/[0.08] bg-black/20 p-4 text-left">
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-neutral-300">
                      <Bot className="h-3.5 w-3.5 text-[#ff875f]" />
                      选择分镜技能
                    </div>
                    <select
                      value={workflow.storyboardSkillId ?? defaultStoryboardSkillId}
                      onChange={(event) => updateWorkflow({ storyboardSkillId: event.target.value, storyboards: [] })}
                      disabled={automationWriteLocked}
                      className="w-full rounded-xl border border-white/10 bg-[#191a1f] px-3 py-2.5 text-[11.5px] text-neutral-300 outline-none focus:border-[#ff6a33]/35 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {storyboardSkillOptions.map((skill) => (
                        <option key={skill.id} value={skill.id}>{skill.name}</option>
                      ))}
                    </select>
                    <p className="mt-2 text-[10.5px] leading-5 text-neutral-600">
                      {selectedStoryboardSkill?.description}
                    </p>
                    {selectedStoryboardSkill ? (
                      <p className="mt-1 text-[9.5px] leading-5 text-neutral-700">
                        来源：{selectedStoryboardSkill.source} · 评分：{selectedStoryboardSkill.score ?? "未评分"}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => void generateStoryboards()}
                    disabled={automationWriteLocked}
                    data-testid="generate-storyboards"
                    className="mt-6 flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-[12px] font-semibold text-[#141518] transition hover:bg-neutral-200"
                  >
                    {splittingStoryboards ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    {splittingStoryboards ? "正在调用文字模型拆分镜头" : "生成分镜草案"}
                  </button>
                </div>
              ) : (
                <>
                  <div className="mt-7 grid grid-cols-[repeat(auto-fill,minmax(245px,1fr))] gap-3">
                    {workflow.storyboards.map((draft, index) => (
                      <article
                       key={draft.id}
                        onClick={() => setSelectedStoryboardId(draft.id)}
                        className="cursor-pointer overflow-hidden rounded-[17px] border border-white/[0.08] bg-[#121317] transition hover:border-[#ff6a33]/35 hover:bg-[#17181d]"
                      >
                        <div className="flex h-36 items-center justify-center border-b border-white/[0.055] bg-white/[0.018]">
                          {draft.imageUrl ? (
                            <MediaThumb src={draft.imageUrl} alt={draft.title} className="h-full w-full object-cover" />
                          ) : (
                            <div className="text-center">
                              <ImageIcon className="mx-auto h-6 w-6 text-neutral-700" />
                              <div className="mt-2 text-[9.5px] uppercase tracking-[0.2em] text-neutral-700">
                                点击查看提示词 {String(index + 1).padStart(2, "0")}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="p-4">
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="truncate text-[12.5px] font-medium text-neutral-200">{draft.title}</h3>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] ${
                              draft.status === "queued"
                                ? "bg-emerald-500/10 text-emerald-300/70"
                                : "bg-[#ff5b24]/10 text-[#ff8b64]"
                            }`}>
                              {draft.status === "queued" ? "已加入画布" : "草案"}
                            </span>
                          </div>
                          <p className="mt-2 line-clamp-3 min-h-[54px] text-[10.5px] leading-[18px] text-neutral-600">{draft.description}</p>
                          <div className="mt-3 flex items-center gap-2 text-[9.5px] text-neutral-500">
                            <span className="rounded-md bg-white/[0.04] px-2 py-1">{draft.shot}</span>
                            <span className="rounded-md bg-white/[0.04] px-2 py-1">{draft.duration}</span>
                            <span className="ml-auto">{draft.assetIds.length} 个资产</span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>

                  <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5">
                    <button
                      type="button"
                      onClick={() => {
                        updateWorkflow({ assets: workflow.assets.map((asset) => ({ ...asset, locked: false })), storyboards: [] });
                        setStage("assets");
                      }}
                      disabled={automationWriteLocked}
                      className="flex items-center gap-2 text-[11.5px] text-neutral-500 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      解锁并修改素材
                    </button>
                    <button
                      type="button"
                      onClick={createCanvasTasks}
                      disabled={automationWriteLocked}
                      data-testid="create-lineart-tasks"
                      className="flex items-center gap-2 rounded-full bg-[#ff6330] px-5 py-2.5 text-[12px] font-semibold text-white transition hover:bg-[#ff7143]"
                    >
                      创建线稿任务并进入画布
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </>
              )}
            </section>
          ) : null}
        </main>
        {showStoryboardSkillPicker && workflow.storyboards.length > 0 ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
            <section className="w-full max-w-xl overflow-hidden rounded-[24px] border border-white/[0.09] bg-[#15161b] shadow-[0_30px_120px_rgba(0,0,0,0.55)]">
              <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-6 py-5">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.18em] text-[#ff8055]">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Regenerate storyboard
                  </div>
                  <h2 className="text-xl font-semibold text-white">重新分镜</h2>
                  <p className="mt-2 max-w-md text-[12px] leading-5 text-neutral-500">
                    选择分镜技能后，系统会重新调用文字模型，并用新分镜覆盖当前草案。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowStoryboardSkillPicker(false)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.035] text-neutral-500 transition hover:bg-white/[0.08] hover:text-white"
                  aria-label="关闭重新分镜弹窗"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-6">
                <div className="rounded-[18px] border border-[#ff6a33]/18 bg-[#101116] p-4">
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-neutral-300">
                    <Bot className="h-3.5 w-3.5 text-[#ff875f]" />
                    选择分镜技能
                  </div>
                  <select
                    value={pendingStoryboardSkillId}
                    onChange={(event) => setPendingStoryboardSkillId(event.target.value)}
                    disabled={automationWriteLocked}
                    className="w-full rounded-xl border border-white/10 bg-[#191a1f] px-3 py-2.5 text-[11.5px] text-neutral-300 outline-none focus:border-[#ff6a33]/35 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {storyboardSkillOptions.map((skill) => (
                      <option key={skill.id} value={skill.id}>{skill.name}</option>
                    ))}
                  </select>
                  <p className="mt-2 text-[10.5px] leading-5 text-neutral-600">
                    {pendingStoryboardSkill?.description}
                  </p>
                  {pendingStoryboardSkill ? (
                    <p className="mt-1 text-[9.5px] leading-5 text-neutral-700">
                      来源：{pendingStoryboardSkill.source} · 评分：{pendingStoryboardSkill.score ?? "未评分"}
                    </p>
                  ) : null}
                </div>

                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowStoryboardSkillPicker(false)}
                    className="rounded-full border border-white/10 px-4 py-2 text-[11.5px] text-neutral-400 transition hover:bg-white/[0.05] hover:text-neutral-200"
                  >
                    关闭
                  </button>
                  <button
                    type="button"
                    onClick={() => void generateStoryboards(pendingStoryboardSkillId)}
                    disabled={automationWriteLocked}
                    className="flex items-center gap-2 rounded-full bg-[#ff6330] px-4 py-2 text-[11.5px] font-semibold text-white transition hover:bg-[#ff7143] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {splittingStoryboards ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {splittingStoryboards ? "正在重新分镜" : "确认重新分镜"}
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : null}
        {selectedStoryboard ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
            <section className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-[24px] border border-white/[0.09] bg-[#15161b] shadow-[0_30px_120px_rgba(0,0,0,0.55)]">
              <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-6 py-5">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.18em] text-[#ff8055]">
                    <Film className="h-3.5 w-3.5" />
                    Shot prompt & assets
                  </div>
                  <h2 className="text-xl font-semibold text-white">{selectedStoryboard.title}</h2>
                  <p className="mt-2 max-w-2xl text-[12px] leading-5 text-neutral-500">{selectedStoryboard.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedStoryboardId(null)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.035] text-neutral-500 transition hover:bg-white/[0.08] hover:text-white"
                  aria-label="关闭分镜详情"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="grid max-h-[calc(88vh-105px)] gap-5 overflow-y-auto p-6 lg:grid-cols-[1fr,320px]">
                <div className="space-y-4">
                  <div className="overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#101116]">
                    <div className="flex min-h-[260px] items-center justify-center bg-white/[0.018]">
                      {selectedStoryboard.imageUrl ? (
                        <MediaThumb src={selectedStoryboard.imageUrl} alt={selectedStoryboard.title} className="h-full min-h-[260px] w-full object-cover" />
                      ) : (
                        <div className="text-center text-neutral-600">
                          {generatingStoryboardId === selectedStoryboard.id ? <LoaderCircle className="mx-auto h-7 w-7 animate-spin text-[#ff8055]" /> : <ImageIcon className="mx-auto h-7 w-7" />}
                          <div className="mt-2 text-[11px]">{generatingStoryboardId === selectedStoryboard.id ? "正在生成分镜图" : "尚未生成分镜图"}</div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[18px] border border-white/[0.08] bg-[#101116] p-4">
                    <div className="mb-2 text-[11px] font-semibold text-neutral-300">图片生成提示词</div>
                    <textarea
                      value={selectedStoryboard.prompt ?? ""}
                      onChange={(event) => patchStoryboard(selectedStoryboard.id, { prompt: event.target.value })}
                      disabled={automationWriteLocked}
                      className="min-h-[150px] w-full resize-y rounded-xl border border-white/[0.08] bg-black/20 px-3 py-3 text-[12px] leading-5 text-neutral-300 outline-none focus:border-[#ff6a33]/35 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    {selectedStoryboard.negativePrompt ? (
                      <p className="mt-3 text-[10.5px] leading-5 text-neutral-600">负面约束：{selectedStoryboard.negativePrompt}</p>
                    ) : null}
                  </div>
                </div>

                <aside className="space-y-4">
                  <div className="rounded-[18px] border border-white/[0.08] bg-[#101116] p-4">
                    <div className="text-[11px] font-semibold text-neutral-300">镜头信息</div>
                    <div className="mt-3 space-y-2 text-[11px] text-neutral-500">
                      <div>景别：{selectedStoryboard.shot}</div>
                      <div>时长：{selectedStoryboard.duration}</div>
                      {selectedStoryboard.camera ? <div>镜头：{selectedStoryboard.camera}</div> : null}
                      {selectedStoryboard.action ? <div>动作：{selectedStoryboard.action}</div> : null}
                      {selectedStoryboard.continuity ? <div>连续性：{selectedStoryboard.continuity}</div> : null}
                    </div>
                  </div>

                  <div className="rounded-[18px] border border-white/[0.08] bg-[#101116] p-4">
                    <div className="mb-3 text-[11px] font-semibold text-neutral-300">资产引用</div>
                    <div className="space-y-2">
                      {selectedStoryboard.assetIds.length > 0 ? selectedStoryboard.assetIds.map((assetId) => {
                        const asset = assetById.get(assetId);
                        if (!asset) return null;
                        return (
                          <div key={assetId} className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] p-2">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.04] text-neutral-600">
                              {asset.url ? <MediaThumb src={asset.url} alt={asset.name} className="h-full w-full object-cover" /> : <Package className="h-4 w-4" />}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-[11px] text-neutral-200">{asset.name}</div>
                              <div className="text-[9.5px] text-neutral-600">{typeLabel(asset.type)}</div>
                            </div>
                          </div>
                        );
                      }) : (
                        <div className="rounded-xl border border-dashed border-white/[0.08] p-4 text-center text-[11px] text-neutral-600">这个镜头暂未绑定资产</div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[18px] border border-white/[0.08] bg-[#101116] p-4">
                    <div className="mb-2 text-[11px] font-semibold text-neutral-300">选择图片模型</div>
                    <AutomationModelPicker
                      value={selectedStoryboard.imageModel && selectedStoryboard.imageProviderId ? `${selectedStoryboard.imageProviderId}:${selectedStoryboard.imageModel}` : ""}
                      options={imageModels}
                      onChange={(model) => {
                        patchStoryboard(selectedStoryboard.id, {
                          imageModel: model.model,
                          imageProviderId: model.providerId,
                        });
                      }}
                      disabled={automationWriteLocked}
                      placeholder="默认图片模型"
                    />
                    <button
                      type="button"
                      onClick={() => void generateSelectedStoryboardImage()}
                      disabled={automationWriteLocked || generatingStoryboardId !== null || imageModels.length === 0}
                      className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-[#ff6330] px-4 py-2.5 text-[12px] font-semibold text-white transition hover:bg-[#ff7143] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {generatingStoryboardId === selectedStoryboard.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      {generatingStoryboardId === selectedStoryboard.id ? "正在生成图片" : "生成分镜图"}
                    </button>
                  </div>
                </aside>
              </div>
            </section>
          </div>
        ) : null}
        {selectedAsset ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
            <section className="max-h-[88vh] w-full max-w-4xl overflow-hidden rounded-[24px] border border-white/[0.09] bg-[#15161b] shadow-[0_30px_120px_rgba(0,0,0,0.55)]">
              <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-6 py-5">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.18em] text-[#ff8055]">
                    <UserRound className="h-3.5 w-3.5" />
                    Character asset pack
                  </div>
                  <h2 className="text-xl font-semibold text-white">{selectedAsset.name}</h2>
                  <p className="mt-2 max-w-2xl text-[12px] leading-5 text-neutral-500">
                    {selectedAsset.description || "从剧本中提取的人物资产，请补充基础人设和其他形态素材。"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedAssetId(null)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.035] text-neutral-500 transition hover:bg-white/[0.08] hover:text-white"
                  aria-label="关闭角色素材详情"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="max-h-[calc(88vh-105px)] overflow-y-auto p-6">
                <div className="grid gap-4 md:grid-cols-[260px,1fr]">
                  <button
                    type="button"
                    onClick={() => chooseAssetFile(selectedAsset.type, selectedAsset.id)}
                    disabled={automationWriteLocked || uploadingType !== null}
                    className="group relative min-h-[280px] overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#101116] text-left transition hover:border-[#ff6a33]/35 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {selectedAsset.url && selectedAsset.type !== "audio" ? (
                      <MediaThumb src={selectedAsset.url} alt={selectedAsset.name} className="absolute inset-0 h-full w-full object-cover" />
                    ) : (
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-neutral-600 transition group-hover:text-[#ff8b63]">
                        {uploadingType === selectedAsset.type && pendingUploadAssetIdRef.current === selectedAsset.id && !pendingUploadVariantIdRef.current
                          ? <LoaderCircle className="h-6 w-6 animate-spin" />
                          : <Upload className="h-6 w-6" />}
                        <span className="text-[11px]">上传基础人设</span>
                      </span>
                    )}
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pb-4 pt-14">
                      <span className="block text-[11px] font-semibold text-neutral-200">基础人设</span>
                      <span className="mt-1 block truncate text-[10px] text-neutral-500">{selectedAsset.name}</span>
                    </span>
                  </button>

                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-[13px] font-semibold text-neutral-200">提取出的其他形态</h3>
                        <p className="mt-1 text-[11px] text-neutral-600">例如鸾凤状态、九尾妖狐状态、战斗形态等。</p>
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/[0.035] px-2.5 py-1 text-[10px] text-neutral-500">
                        {selectedAsset.variants?.length ?? 0} 个形态
                      </span>
                    </div>

                    {selectedAsset.variants && selectedAsset.variants.length > 0 ? (
                      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                        {selectedAsset.variants.map((variant) => {
                          const uploadingVariant = uploadingType === selectedAsset.type
                            && pendingUploadAssetIdRef.current === selectedAsset.id
                            && pendingUploadVariantIdRef.current === variant.id;
                          return (
                            <button
                              key={variant.id}
                              type="button"
                              onClick={() => chooseAssetFile(selectedAsset.type, selectedAsset.id, variant.id)}
                              disabled={automationWriteLocked || uploadingType !== null}
                              className="group relative min-h-[170px] overflow-hidden rounded-[16px] border border-white/[0.08] bg-[#101116] text-left transition hover:border-[#ff6a33]/35 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {variant.url ? (
                                <MediaThumb src={variant.url} alt={variant.name} className="absolute inset-0 h-full w-full object-cover" />
                              ) : (
                                <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/[0.015] text-neutral-600 transition group-hover:text-[#ff8b63]">
                                  {uploadingVariant ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                                  <span className="text-[10.5px]">上传形态素材</span>
                                </span>
                              )}
                              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3.5 pb-3 pt-10">
                                <span className="block truncate text-[11px] font-medium text-neutral-200" title={variant.name}>{variant.name}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mt-4 flex min-h-[170px] items-center justify-center rounded-[16px] border border-dashed border-white/[0.08] bg-white/[0.018] px-5 text-center text-[11.5px] leading-5 text-neutral-600">
                        当前剧本提取结果里还没有其他形态。重新提取后，如果剧本中有“鸾凤状态 / 九尾妖狐状态”等描述，会出现在这里。
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
