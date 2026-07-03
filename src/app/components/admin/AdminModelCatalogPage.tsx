import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { gsap } from "gsap";
import {
  Bold,
  Bot,
  BrainCircuit,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clapperboard,
  Eye,
  FileCode2,
  File,
  FileText,
  FolderOpen,
  Italic,
  List,
  ListOrdered,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Redo2,
  RotateCcw,
  Search,
  Sparkles,
  Strikethrough,
  ThumbsUp,
  Trash2,
  Undo2,
  Volume2,
  Wand2,
  X,
  Zap,
} from "lucide-react";

import { toAdminErrorSummary } from "../../api/errors";
import type { AdapterRuntime, GatewayProtocol, ModelParameterSchema, ProviderConfig, ProviderConfigPayload, ServiceType, VendorTemplate } from "../../api/providerConfigs";
import {
  createProviderConfig,
  deleteProviderConfig,
  getEndpointPreview,
  listProviderConfigs,
  previewProviderConfigTSImport,
  resetChannelHealth,
  supportsCustomSubmitQueryEndpoints,
  testChannelConnectivity,
  toggleProviderConfigStatus,
  updateProviderConfig,
  VENDOR_TEMPLATES,
} from "../../api/providerConfigs";
import {
  adminCreateAgent,
  adminCreateSkill,
  adminGetAgentMemorySettings,
  adminGetAgentUseMode,
  adminListAgents,
  adminListSkills,
  adminSeedCreatorSuiteAgents,
  adminUpdateAgentMemorySettings,
  adminUpdateAgent,
  adminUpdateAgentUseMode,
  adminUpdateSkill,
  type Agent,
  type AgentMemorySettings,
  type AgentUpsert,
  type AgentUseMode,
  type Skill,
  type SkillUpsert,
} from "../../api/skills";
import { normalizeModelList } from "../../model-config";
import { getSkillCommandName, getSkillTemplateBody, isPromptTemplateSkill } from "../settings/skill-agent-presenters";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ModelBrandIcon } from "../ModelBrandIcon";
import { AdminShell } from "./AdminShell";
import { ChannelHealthBadge } from "./ChannelHealthBadge";

const ProviderCodeEditorModal = lazy(() => import("./ProviderCodeEditorModal"));

const SERVICE_LABELS: Record<ServiceType, string> = {
  text: "文本生成",
  image: "图片生成",
  video: "视频生成",
  audio: "音频生成",
};

const SERVICE_BADGE_STYLES: Record<ServiceType, string> = {
  text: "border-blue-400/20 bg-blue-500/12 text-blue-300",
  image: "border-violet-400/20 bg-violet-500/12 text-violet-300",
  video: "border-pink-400/20 bg-pink-500/12 text-pink-300",
  audio: "border-amber-400/20 bg-amber-500/12 text-amber-300",
};

const STATUS_LABEL: Record<ProviderConfig["status"], string> = {
  enabled: "启用",
  disabled: "禁用",
};

const FIELD_INPUT =
  "w-full rounded-md border border-white/[0.08] bg-white/[0.045] px-3 py-2.5 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-500 focus:border-white/[0.18] focus:bg-white/[0.065] focus:ring-2 focus:ring-white/[0.04]";
const FIELD_SELECT = `${FIELD_INPUT} appearance-none [color-scheme:dark]`;
const SETTINGS_INPUT =
  "w-full rounded-md border border-white/[0.08] bg-white/[0.045] px-3 py-2.5 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-500 focus:border-white/[0.18] focus:bg-white/[0.065] focus:ring-2 focus:ring-white/[0.04]";
const SETTINGS_SELECT = `${SETTINGS_INPUT} appearance-none [color-scheme:dark]`;
const SETTINGS_BADGE = "rounded-full border border-white/[0.08] bg-white/[0.045] px-2.5 py-1 text-xs text-neutral-300";
const SETTINGS_PANEL_BUTTON =
  "border-white/[0.08] bg-white/[0.045] text-neutral-200 hover:border-white/[0.16] hover:bg-white/[0.075] hover:text-white";
const SETTINGS_PRIMARY_BUTTON =
  "border border-white/[0.10] bg-white/[0.075] text-white hover:border-white/[0.18] hover:bg-white/[0.12]";
const EDITOR_INPUT =
  "w-full rounded-lg border border-[#303030] bg-[#1d1d1b] px-3 py-2.5 text-sm text-[#e8e2d8] outline-none transition placeholder:text-[#736f68] focus:border-[#4a4237] focus:bg-[#22201d] focus:ring-2 focus:ring-[#d7a85c]/10";
const EDITOR_SCROLLBAR =
  "[scrollbar-width:thin] [scrollbar-color:rgba(165,156,145,0.42)_rgba(255,255,255,0.045)]";
const EDITOR_TOOL_BUTTON =
  "grid h-8 w-8 place-items-center rounded-md text-[#a8a19a] transition hover:bg-[#2a2926] hover:text-[#f2eadf] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d7a85c]/25";
const EDITOR_TEXTAREA =
  `resize-none border-0 border-r border-[#2d2b28] bg-[#121211] px-5 py-4 font-mono text-[13px] leading-7 text-[#e7e0d6] caret-[#d7a85c] outline-none placeholder:text-[#746f67] selection:bg-[#8c6b35]/40 ${EDITOR_SCROLLBAR}`;
const EDITOR_PREVIEW =
  `overflow-y-auto bg-[#171716] px-5 py-4 ${EDITOR_SCROLLBAR}`;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

type SettingsPanelKey = "model-service" | "agent-config" | "prompt-manage" | "skill-management" | "memory-config";

const SETTINGS_PAGE_META: Record<SettingsPanelKey, { title: string; description: string }> = {
  "model-service": {
    title: "模型服务",
    description: "管理 AI 服务供应商、模型列表、TS 适配器和默认路由。失败只报警，不会自动切换或锁定渠道。",
  },
  "agent-config": {
    title: "Agent配置",
    description: "管理创作智能体套件的模型路由、系统提示词、可调用技能与运行策略。",
  },
  "prompt-manage": {
    title: "提示词管理",
    description: "维护可复用提示词模板，统一沉淀画布工作流里的常用生成指令和结构化输入。",
  },
  "skill-management": {
    title: "Skills技能管理",
    description: "管理可启用的 Skills 能力，支持为 Agent 和用户侧工作流提供统一的工具描述。",
  },
  "memory-config": {
    title: "Agent记忆配置",
    description: "配置 Agent 记忆、摘要、检索和保留策略，让长期上下文在项目里可控地复用。",
  },
};

type VendorModelDefinition = {
  name: string;
  modelName: string;
  type: ServiceType;
  creditCost?: number;
  think?: boolean;
  mode?: Array<string | string[]>;
  audio?: "optional" | false | true;
  durationResolutionMap?: Array<{ duration: number[]; resolution: string[] }>;
  /** true = 可被调用但不出现在前端模型选择列表（如超分等内部功能专用模型）。 */
  hidden?: boolean;
};

type ModelEditorDraft = {
  name: string;
  modelName: string;
  type: ServiceType;
  think: boolean;
  imageModes: string[];
  videoModes: string[];
  mixedMode: string[];
  mixedModeCount: Record<string, number>;
  audio: "optional" | false | true;
  durationResolutionMap: Array<{ duration: string; resolution: string }>;
  creditCost: string;
  isDefault: boolean;
  hidden: boolean;
};

type ModelEditorState = {
  config: ProviderConfig;
  originalModelName?: string;
  draft: ModelEditorDraft;
};

type ModelTestResult = {
  configName: string;
  modelName: string;
  type: ServiceType;
  status: "loading" | "success" | "failed";
  ok: boolean;
  httpStatus: number;
  latencyMs: number;
  errorMsg?: string;
};

const MODEL_TYPE_OPTIONS: Array<{ value: ServiceType; label: string }> = [
  { value: "text", label: "文本模型" },
  { value: "image", label: "图片模型" },
  { value: "video", label: "视频模型" },
  { value: "audio", label: "音频模型" },
];

const IMAGE_MODE_OPTIONS = [
  { value: "text", label: "文生图" },
  { value: "singleImage", label: "单图" },
  { value: "multiReference", label: "多参考" },
];

const VIDEO_MODE_OPTIONS = [
  { value: "singleImage", label: "单图" },
  { value: "startEndRequired", label: "首尾帧" },
  { value: "endFrameOptional", label: "尾帧可选" },
  { value: "startFrameOptional", label: "首帧可选" },
  { value: "text", label: "文生视频" },
  { value: "multiReference", label: "多参考" },
];

const REFERENCE_MODE_OPTIONS = [
  { value: "videoReference", label: "视频参考" },
  { value: "imageReference", label: "图片参考" },
  { value: "audioReference", label: "音频参考" },
];

const MODE_LABELS: Record<string, string> = {
  text: "文生",
  singleImage: "单图",
  multiReference: "多参考",
  startEndRequired: "首尾帧",
  endFrameOptional: "尾帧可选",
  startFrameOptional: "首帧可选",
  videoReference: "视频参考",
  imageReference: "图片参考",
  audioReference: "音频参考",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function modelTypeFromValue(value: unknown, fallback: ServiceType): ServiceType {
  const type = cleanString(value).toLowerCase();
  if (type === "tts") return "audio";
  return type === "text" || type === "image" || type === "video" || type === "audio" ? type : fallback;
}

function normalizeModeList(value: unknown): Array<string | string[]> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (Array.isArray(item)) return item.map((inner) => cleanString(inner)).filter(Boolean);
      return cleanString(item);
    })
    .filter((item): item is string | string[] => (Array.isArray(item) ? item.length > 0 : Boolean(item)));
}

function normalizeDurationResolutionMap(value: unknown): VendorModelDefinition["durationResolutionMap"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!isRecord(row)) return null;
      const duration = Array.isArray(row.duration)
        ? row.duration.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
        : [];
      const resolution = Array.isArray(row.resolution)
        ? row.resolution.map((item) => cleanString(item)).filter(Boolean)
        : [];
      return duration.length || resolution.length ? { duration, resolution } : null;
    })
    .filter((item): item is { duration: number[]; resolution: string[] } => Boolean(item));
}

function normalizeCreditCost(value: unknown): number | undefined {
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? Math.round(cost) : undefined;
}

function getSchemaModelEntry(schema: ModelParameterSchema | undefined, modelName: string): ModelParameterSchema | undefined {
  const models = schema?.models;
  if (!models) return undefined;
  if (models[modelName]) return models[modelName];
  const lowerModel = modelName.toLowerCase().trim();
  const key = Object.keys(models).find((item) => item.toLowerCase().trim() === lowerModel);
  return key ? models[key] : undefined;
}

function getModelCreditCost(config: ProviderConfig, modelName: string, model?: VendorModelDefinition) {
  return model?.creditCost
    ?? normalizeCreditCost(getSchemaModelEntry(config.parameter_schema, modelName)?.credit_cost)
    ?? normalizeCreditCost(config.credit_cost)
    ?? normalizeCreditCost(config.parameter_schema?.credit_cost)
    ?? 1;
}

function normalizeVendorModel(raw: unknown, fallbackType: ServiceType, fallbackName = ""): VendorModelDefinition | null {
  if (typeof raw === "string") {
    const modelName = raw.trim();
    return modelName ? { name: modelName, modelName, type: fallbackType } : null;
  }
  if (!isRecord(raw)) return null;
  const modelName = cleanString(raw.modelName) || cleanString(raw.model_name) || cleanString(raw.model) || cleanString(raw.id) || cleanString(raw.name);
  if (!modelName) return null;
  const type = modelTypeFromValue(raw.type, fallbackType);
  const mode = normalizeModeList(raw.mode);
  return {
    name: cleanString(raw.name) || fallbackName || modelName,
    modelName,
    type,
    creditCost: normalizeCreditCost(raw.creditCost ?? raw.credit_cost),
    think: Boolean(raw.think),
    mode: mode.length ? mode : undefined,
    audio: raw.audio === true || raw.audio === false || raw.audio === "optional" ? raw.audio : undefined,
    durationResolutionMap: normalizeDurationResolutionMap(raw.durationResolutionMap ?? raw.duration_resolution_map),
    hidden: raw.hidden === true ? true : undefined,
  };
}

function getVendorModels(config: ProviderConfig): VendorModelDefinition[] {
  const schema = config.parameter_schema ?? {};
  const rawModels = Array.isArray(schema.vendor_models)
    ? schema.vendor_models
    : Array.isArray(schema.vendor_all_models)
      ? schema.vendor_all_models
      : [];
  const seen = new Set<string>();
  const models: VendorModelDefinition[] = [];
  rawModels.forEach((raw) => {
    const model = normalizeVendorModel(raw, config.service_type);
    if (model && !seen.has(model.modelName)) {
      seen.add(model.modelName);
      models.push({
        ...model,
        creditCost: model.creditCost ?? normalizeCreditCost(getSchemaModelEntry(schema, model.modelName)?.credit_cost),
      });
    }
  });
  config.model_list.forEach((modelName) => {
    if (!seen.has(modelName)) {
      seen.add(modelName);
      models.push({
        name: modelName,
        modelName,
        type: config.service_type,
        creditCost: normalizeCreditCost(getSchemaModelEntry(schema, modelName)?.credit_cost),
      });
    }
  });
  return models;
}

function createModelDraft(config: ProviderConfig, model?: VendorModelDefinition): ModelEditorDraft {
  const source: VendorModelDefinition = model ?? {
    name: "",
    modelName: "",
    type: config.service_type,
    mode: config.service_type === "image" ? ["text"] : config.service_type === "video" ? ["text"] : [],
    audio: "optional",
  };
  const mode = source.mode ?? [];
  const flatModes: string[] = [];
  const mixedMode: string[] = [];
  const mixedModeCount: Record<string, number> = {};
  mode.forEach((item) => {
    if (Array.isArray(item)) {
      item.forEach((ref) => {
        const match = String(ref).match(/^(videoReference|imageReference|audioReference):(\d+)$/);
        if (match) {
          mixedMode.push(match[1]);
          mixedModeCount[match[1]] = Number(match[2]) || 1;
        }
      });
    } else {
      flatModes.push(item);
    }
  });
  const type = source.type;
  return {
    name: source.name,
    modelName: source.modelName,
    type,
    think: Boolean(source.think),
    imageModes: type === "image" ? flatModes : [],
    videoModes: type === "video" ? (mixedMode.length ? [...flatModes, "multiReference"] : flatModes) : [],
    mixedMode,
    mixedModeCount,
    audio: source.audio ?? "optional",
    durationResolutionMap: source.durationResolutionMap?.length
      ? source.durationResolutionMap.map((row) => ({
          duration: row.duration.join(", "),
          resolution: row.resolution.join(", "),
        }))
      : [{ duration: "", resolution: "" }],
    creditCost: source.creditCost === undefined ? "" : String(source.creditCost),
    isDefault: Boolean(source.modelName && source.modelName === config.default_model),
    hidden: Boolean(source.hidden),
  };
}

function creditCostFromDraft(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? Math.round(cost) : undefined;
}

function buildModelFromDraft(draft: ModelEditorDraft): VendorModelDefinition | null {
  const name = draft.name.trim();
  const modelName = draft.modelName.trim();
  if (!name || !modelName) return null;
  const creditCost = creditCostFromDraft(draft.creditCost);
  const hidden = draft.hidden ? true : undefined;
  if (draft.type === "text") {
    return { name, modelName, type: "text", creditCost, think: draft.think, hidden };
  }
  if (draft.type === "image") {
    return { name, modelName, type: "image", creditCost, mode: draft.imageModes.length ? draft.imageModes : ["text"], hidden };
  }
  if (draft.type === "video") {
    const mode = draft.videoModes.filter((item) => item !== "multiReference");
    const mixed = draft.mixedMode.map((item) => `${item}:${draft.mixedModeCount[item] || 1}`);
    const durationResolutionMap = draft.durationResolutionMap
      .map((row) => ({
        duration: row.duration.split(/[,，\s]+/).map(Number).filter((item) => Number.isFinite(item) && item > 0),
        resolution: row.resolution.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
      }))
      .filter((row) => row.duration.length || row.resolution.length);
    return {
      name,
      modelName,
      type: "video",
      creditCost,
      mode: mixed.length ? [...mode, mixed] : mode.length ? mode : ["text"],
      audio: draft.audio,
      durationResolutionMap: durationResolutionMap.length ? durationResolutionMap : [{ duration: [5], resolution: ["720p"] }],
      hidden,
    };
  }
  return { name, modelName, type: "audio", creditCost, hidden };
}

function modelTags(model: VendorModelDefinition, config: ProviderConfig) {
  const tags = [SERVICE_LABELS[model.type] ?? SERVICE_LABELS[config.service_type]];
  tags.push(`积分 ${getModelCreditCost(config, model.modelName, model)}/次`);
  if (config.default_model === model.modelName) tags.push("默认模型");
  if (model.hidden) tags.push("不在选择列表");
  if (model.type === "text" && model.think) tags.push("深度思考");
  (model.mode ?? []).forEach((mode) => {
    if (Array.isArray(mode)) {
      mode.forEach((item) => {
        const match = item.match(/^(videoReference|imageReference|audioReference):(\d+)$/);
        tags.push(match ? `${MODE_LABELS[match[1]] ?? match[1]} ×${match[2]}` : item);
      });
    } else {
      tags.push(MODE_LABELS[mode] ?? mode);
    }
  });
  if (!model.mode?.length && model.type === "image") tags.push("图片 ×9");
  if (!model.mode?.length && model.type === "video") tags.push("视频 ×3");
  if (model.type === "audio") tags.push("音频 ×3");
  return tags;
}

function syncModelCreditCostsIntoSchema(schema: ModelParameterSchema, models: VendorModelDefinition[]): ModelParameterSchema {
  const nextModels: Record<string, ModelParameterSchema> = { ...(schema.models ?? {}) };
  const activeModelNames = new Set(models.map((model) => model.modelName));
  Object.keys(nextModels).forEach((modelName) => {
    if (!activeModelNames.has(modelName)) delete nextModels[modelName];
  });
  models.forEach((model) => {
    const existing = nextModels[model.modelName] ?? {};
    if (model.creditCost === undefined) {
      const { credit_cost: _creditCost, ...rest } = existing;
      if (Object.keys(rest).length > 0) {
        nextModels[model.modelName] = rest;
      } else {
        delete nextModels[model.modelName];
      }
      return;
    }
    nextModels[model.modelName] = {
      ...existing,
      credit_cost: model.creditCost,
    };
  });
  if (Object.keys(nextModels).length === 0) {
    const { models: _models, ...rest } = schema;
    return rest;
  }
  return {
    ...schema,
    models: nextModels,
  };
}

type AgentEditorDraft = {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  deployKey: string;
  parentDeployKey: string;
  modelName: string;
  providerId: string;
  temperature: number;
  maxOutputTokens: number;
  runtime: string;
  skillIds: string[];
  canvasTools: boolean;
  enabled: boolean;
  strategy: AgentUpsert["strategy"];
};

type MemoryConfigForm = AgentMemorySettings;

const DEFAULT_MEMORY_CONFIG: MemoryConfigForm = {
  messagesPerSummary: 3,
  shortTermLimit: 5,
  summaryMaxLength: 500,
  summaryLimit: 10,
  ragLimit: 3,
  deepRetrieveSummaryLimit: 5,
  modelOnnxFile: "all-MiniLM-L6-v2/onnx/model_fp16.onnx",
  modelDtype: "fp16",
};

type AgentPresetKey = "script" | "production" | "general" | "tts";

type AgentPresetDefinition = {
  key: AgentPresetKey;
  deployKey: string;
  name: string;
  description: string;
  modelHint: string;
  icon: "script" | "production" | "general" | "tts";
  aliases: string[];
  disabled?: boolean;
  strategy: AgentUpsert["strategy"];
  canvasTools: boolean;
  systemPrompt: string;
};

const AGENT_PRESETS: AgentPresetDefinition[] = [
  {
    key: "script",
    deployKey: "scriptAgent",
    name: "剧本Agent",
    description: "用于读取原文生成故事骨架、改编策略，建议使用具备强大文本理解和生成能力的模型。",
    modelHint: "Doubao-Seed-1.8",
    icon: "script",
    aliases: ["script", "story", "剧本", "故事", "文生故事"],
    strategy: "reactive",
    canvasTools: true,
    systemPrompt:
      "你是 CCY Canvas 的剧本 Agent，负责理解用户原文、故事结构和画布上下文，输出清晰的故事骨架、改编策略和可执行分镜方向。忠于用户素材，不臆造关键事实。",
  },
  {
    key: "production",
    deployKey: "productionAgent",
    name: "生产Agent",
    description: "对工作流进行调度和管理，建议使用具备较强逻辑推理和任务管理能力的模型。",
    modelHint: "Doubao-Seed-2.0-Pro",
    icon: "production",
    aliases: ["production", "producer", "生产", "调度", "执行"],
    strategy: "scripted",
    canvasTools: true,
    systemPrompt:
      "你是 CCY Canvas 的生产 Agent，负责把用户目标拆解成可执行任务，调度节点、技能和模型服务，追踪失败原因并给出下一步。优先保证画布状态和用户意图一致。",
  },
  {
    key: "general",
    deployKey: "universalAi",
    name: "通用AI",
    description: "用于小说事件提取、资产提示词生成、台词提取等边缘功能，建议使用具备较强文本处理能力的模型。",
    modelHint: "DeepSeek-V3-2",
    icon: "general",
    aliases: ["general", "通用", "assistant", "ai", "助手"],
    strategy: "reactive",
    canvasTools: true,
    systemPrompt:
      "你是 CCY Canvas 的通用 AI 助手，负责理解用户请求、补充创作建议、整理结构化内容，并在需要时调用可用技能协助完成任务。",
  },
  {
    key: "tts",
    deployKey: "ttsDubbing",
    name: "TTS配音",
    description: "根据剧本内容生成角色配音，支持多种声音风格和情绪。",
    modelHint: "未开放",
    icon: "tts",
    aliases: ["tts", "配音", "语音", "audio"],
    disabled: true,
    strategy: "reactive",
    canvasTools: false,
    systemPrompt:
      "你是 CCY Canvas 的 TTS 配音 Agent，负责根据剧本、角色和情绪生成配音请求。当前项目尚未接入音频模型时保持未开放。",
  },
];

const PROMPT_TOOLBAR = [
  { key: "bold", label: "加粗", icon: <Bold className="h-4 w-4" /> },
  { key: "italic", label: "斜体", icon: <Italic className="h-4 w-4" /> },
  { key: "strike", label: "删除线", icon: <Strikethrough className="h-4 w-4" /> },
  { key: "ul", label: "无序列表", icon: <List className="h-4 w-4" /> },
  { key: "ol", label: "有序列表", icon: <ListOrdered className="h-4 w-4" /> },
  { key: "undo", label: "撤销", icon: <Undo2 className="h-4 w-4" /> },
  { key: "redo", label: "重做", icon: <Redo2 className="h-4 w-4" /> },
] as const;

function createAgentDraft(agent: Agent | null, fallbackModel: string, preset?: AgentPresetDefinition): AgentEditorDraft {
  if (agent) {
    return {
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.system_prompt,
      model: agent.model || fallbackModel,
      deployKey: agent.deploy_key || preset?.deployKey || "",
      parentDeployKey: agent.parent_deploy_key || "",
      modelName: agent.model_name || "",
      providerId: agent.provider_id || "",
      temperature: agent.temperature ?? 1,
      maxOutputTokens: agent.max_output_tokens ?? 0,
      runtime: agent.runtime || "generic",
      skillIds: agent.skill_ids,
      canvasTools: agent.canvas_tools,
      enabled: agent.enabled,
      strategy: agent.strategy,
    };
  }
  return {
    name: preset?.name || "新智能体",
    description: preset?.description || "参考当前画布、上下文和可调用技能完成任务。",
    systemPrompt:
      preset?.systemPrompt ||
      "你是 CCY Canvas 中的创作型智能体。优先理解当前画布节点、用户输入和绑定技能，再给出可执行的下一步。",
    model: fallbackModel,
    deployKey: preset?.deployKey || "",
    parentDeployKey: "",
    modelName: "",
    providerId: "",
    temperature: 1,
    maxOutputTokens: 0,
    runtime: preset?.deployKey || "generic",
    skillIds: [],
    canvasTools: preset?.canvasTools ?? true,
    enabled: true,
    strategy: preset?.strategy ?? "reactive",
  };
}

function findPresetAgent(agents: Agent[], preset: AgentPresetDefinition) {
  const byDeployKey = agents.find((agent) => agent.deploy_key === preset.deployKey);
  if (byDeployKey) return byDeployKey;
  const aliases = [preset.name, ...preset.aliases].map((item) => item.toLowerCase());
  return agents.find((agent) => {
    const haystack = `${agent.name} ${agent.description} ${agent.system_prompt}`.toLowerCase();
    return aliases.some((alias) => haystack.includes(alias));
  }) ?? null;
}

function skillToMarkdown(skill: Skill) {
  const spec = skill.spec ?? {};
  const promptBody = isPromptTemplateSkill(skill) ? getSkillTemplateBody(skill) : "";
  const specContent =
    typeof spec.content_md === "string"
      ? spec.content_md
      : typeof spec.user_template === "string"
        ? spec.user_template
        : typeof spec.system_prompt === "string"
          ? spec.system_prompt
          : "";
  if (promptBody || specContent) return promptBody || specContent;
  const command = getSkillCommandName(skill);
  return [
    `# ${skill.name}`,
    "",
    skill.description || "暂无技能说明。",
    "",
    "## 元信息",
    "",
    `- 命令：${command}`,
    `- 类型：${skill.kind}`,
    `- 分类：${skill.category || "未分类"}`,
    `- 状态：${skill.enabled ? "已启用" : "未启用"}`,
    "",
    "## Spec",
    "",
    "```json",
    JSON.stringify(skill.spec ?? {}, null, 2),
    "```",
  ].join("\n");
}

function skillFilePath(skill: Skill) {
  const category = (skill.category || (isPromptTemplateSkill(skill) ? "prompt_skills" : "agent_skills"))
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "_");
  const safeName = skill.name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "_") || skill.id;
  return `${category}/${safeName}.md`;
}

type SkillTreeEntry = {
  skill: Skill;
  path: string;
  content: string;
};

type SkillTreeNode = {
  label: string;
  path: string;
  children: SkillTreeNode[];
  entry?: SkillTreeEntry;
};

function buildSkillTree(entries: SkillTreeEntry[]) {
  const roots: SkillTreeNode[] = [];
  const nodeByPath = new Map<string, SkillTreeNode>();

  const ensureNode = (label: string, nodePath: string, siblings: SkillTreeNode[]) => {
    const existing = nodeByPath.get(nodePath);
    if (existing) return existing;
    const next: SkillTreeNode = { label, path: nodePath, children: [] };
    nodeByPath.set(nodePath, next);
    siblings.push(next);
    siblings.sort((a, b) => a.label.localeCompare(b.label));
    return next;
  };

  entries.forEach((entry) => {
    const parts = entry.path.split("/").filter(Boolean);
    let siblings = roots;
    let currentPath = "";
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const node = ensureNode(part, currentPath, siblings);
      if (index === parts.length - 1) node.entry = entry;
      siblings = node.children;
    });
  });

  return roots;
}

function collectSkillFolderPaths(paths: string[]) {
  const folderPaths = new Set<string>();
  paths.forEach((filePath) => {
    const parts = filePath.split("/").filter(Boolean);
    let currentPath = "";
    parts.slice(0, -1).forEach((part) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      folderPaths.add(currentPath);
    });
  });
  return Array.from(folderPaths);
}

function applyPromptToolbar(content: string, selectionStart: number, selectionEnd: number, action: (typeof PROMPT_TOOLBAR)[number]["key"]) {
  const selected = content.slice(selectionStart, selectionEnd) || "文本";
  const before = content.slice(0, selectionStart);
  const after = content.slice(selectionEnd);
  if (action === "bold") return `${before}**${selected}**${after}`;
  if (action === "italic") return `${before}_${selected}_${after}`;
  if (action === "strike") return `${before}~~${selected}~~${after}`;
  if (action === "ul") return `${before}${selected.split(/\r?\n/).map((line) => `- ${line || "列表项"}`).join("\n")}${after}`;
  if (action === "ol") return `${before}${selected.split(/\r?\n/).map((line, index) => `${index + 1}. ${line || "列表项"}`).join("\n")}${after}`;
  return content;
}

function markdownLineToText(line: string) {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/~~/g, "")
    .replace(/_/g, "");
}

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  let inCode = false;
  return (
    <div className="space-y-3 text-[14px] leading-7 text-[#d8d1c7]">
      {lines.map((line, index) => {
        if (line.trim().startsWith("```")) {
          inCode = !inCode;
          return <div key={index} className="rounded-md bg-[#111110] px-3 py-1 font-mono text-xs text-[#928b82]">```</div>;
        }
        if (inCode) {
          return <pre key={index} className={`overflow-x-auto rounded-md bg-[#111110] px-3 py-2 font-mono text-xs text-[#d8d1c7] ${EDITOR_SCROLLBAR}`}>{line}</pre>;
        }
        if (!line.trim()) return <div key={index} className="h-2" />;
        if (/^###\s+/.test(line)) return <h3 key={index} className="text-lg font-semibold tracking-[-0.01em] text-[#f2eadf]">{markdownLineToText(line)}</h3>;
        if (/^##\s+/.test(line)) return <h2 key={index} className="border-b border-[#2c2925] pb-2 text-xl font-semibold tracking-[-0.02em] text-[#f5eee4]">{markdownLineToText(line)}</h2>;
        if (/^#\s+/.test(line)) return <h1 key={index} className="border-b border-[#2c2925] pb-2 text-2xl font-semibold tracking-[-0.025em] text-[#f6efe5]">{markdownLineToText(line)}</h1>;
        if (/^\s*[-*]\s+/.test(line)) return <p key={index} className="pl-3 text-[#d8d1c7]">• {markdownLineToText(line)}</p>;
        if (/^\s*\d+\.\s+/.test(line)) return <p key={index} className="pl-3 text-[#d8d1c7]">{markdownLineToText(line)}</p>;
        if (/^\|.*\|$/.test(line)) return <pre key={index} className={`overflow-x-auto rounded-md bg-[#111110] px-3 py-2 font-mono text-xs text-[#d8d1c7] ${EDITOR_SCROLLBAR}`}>{line}</pre>;
        return <p key={index} className="text-[#d8d1c7]">{markdownLineToText(line)}</p>;
      })}
    </div>
  );
}

function ProviderCodeEditorFallback() {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/72 px-5 backdrop-blur-sm">
      <div className="grid h-[78vh] w-full max-w-[1344px] place-items-center rounded-lg bg-white text-sm text-neutral-500 shadow-[0_28px_90px_rgba(0,0,0,0.35)]">
        正在加载代码编辑器...
      </div>
    </div>
  );
}

function serviceCapabilities(serviceType: ServiceType) {
  return [serviceType];
}

type ConfigModalProps = {
  config: ProviderConfig | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

function ConfigModal({ config, open, onClose, onSaved }: ConfigModalProps) {
  const isEdit = Boolean(config);
  const [serviceType, setServiceType] = useState<ServiceType>("image");
  const [vendor, setVendor] = useState("");
  const [apiSpec, setApiSpec] = useState("openai");
  const [protocol, setProtocol] = useState<GatewayProtocol>("openai_compatible");
  const [adapterRuntime, setAdapterRuntime] = useState<AdapterRuntime>("go");
  const [adapterCode, setAdapterCode] = useState("");
  const [iconKey, setIconKey] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [submitEndpoint, setSubmitEndpoint] = useState("");
  const [queryEndpoint, setQueryEndpoint] = useState("");
  const [modelListText, setModelListText] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [priority, setPriority] = useState(0);
  const [isDefault, setIsDefault] = useState(false);
  const [creditCost, setCreditCost] = useState(1);
  const [parameterSchemaText, setParameterSchemaText] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [previewingTS, setPreviewingTS] = useState(false);
  const [error, setError] = useState("");
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);

  const templates = VENDOR_TEMPLATES[serviceType] ?? [];
  const showCustomEndpoints = supportsCustomSubmitQueryEndpoints(apiSpec);
  const endpointPreview = getEndpointPreview(serviceType, apiSpec, submitEndpoint, queryEndpoint, baseUrl);

  useEffect(() => {
    if (!open) return;
    if (config) {
      setServiceType(config.service_type);
      setVendor(config.vendor);
      setApiSpec(config.api_spec || "openai");
      setProtocol(config.protocol || "openai_compatible");
      setAdapterRuntime(config.adapter_runtime || "go");
      setAdapterCode(config.adapter_code || "");
      setIconKey(config.icon_key || "");
      setIconUrl(config.icon_url || "");
      setName(config.name);
      setBaseUrl(config.base_url);
      setApiKey("");
      setSubmitEndpoint(config.submit_endpoint || "");
      setQueryEndpoint(config.query_endpoint || "");
      setModelListText((config.model_list ?? []).join("\n"));
      setDefaultModel(config.default_model || "");
      setPriority(config.priority || 0);
      setIsDefault(Boolean(config.is_default));
      setCreditCost(config.credit_cost ?? config.parameter_schema?.credit_cost ?? 1);
      setParameterSchemaText(JSON.stringify(config.parameter_schema ?? {}, null, 2));
    } else {
      setServiceType("image");
      setVendor("");
      setApiSpec("openai");
      setProtocol("openai_compatible");
      setAdapterRuntime("go");
      setAdapterCode("");
      setIconKey("");
      setIconUrl("");
      setName("");
      setBaseUrl("");
      setApiKey("");
      setSubmitEndpoint("");
      setQueryEndpoint("");
      setModelListText("");
      setDefaultModel("");
      setPriority(0);
      setIsDefault(false);
      setCreditCost(1);
      setParameterSchemaText("{}");
    }
    setError("");
    setCodeEditorOpen(false);
  }, [config, open]);

  const applyTemplate = (tpl: VendorTemplate) => {
    setVendor(tpl.vendor);
    setName(tpl.label);
    setBaseUrl(tpl.baseURL);
    setApiSpec(tpl.apiSpec);
    setProtocol(tpl.protocol || "openai_compatible");
    setAdapterRuntime("go");
    setAdapterCode("");
    // 模板可声明品牌图标（如可灵走阿里渠道但用 kling 图标）；未声明则清空。
    setIconKey(tpl.iconKey ?? "");
    setIconUrl("");
    setModelListText(tpl.models.join("\n"));
    setDefaultModel(tpl.models[0] ?? "");
    setSubmitEndpoint(tpl.submitEndpoint ?? "");
    setQueryEndpoint(tpl.queryEndpoint ?? "");
    setParameterSchemaText(JSON.stringify(tpl.parameterSchema ?? {}, null, 2));
  };

  const handlePreviewTSImport = async () => {
    if (!adapterCode.trim()) {
      setError("Please paste TS adapter code first.");
      return;
    }
    setPreviewingTS(true);
    setError("");
    try {
      const preview = await previewProviderConfigTSImport(adapterCode, serviceType);
      setAdapterRuntime("ts");
      setServiceType(preview.service_type);
      setVendor(preview.vendor || "Custom");
      setName(preview.name || preview.vendor || "TS Provider");
      setApiSpec(preview.api_spec || "custom");
      setProtocol(preview.protocol || "openai_compatible");
      setBaseUrl(preview.base_url || "");
      setSubmitEndpoint(preview.submit_endpoint || "");
      setQueryEndpoint(preview.query_endpoint || "");
      setModelListText((preview.model_list ?? []).join("\n"));
      setDefaultModel(preview.default_model || preview.model_list?.[0] || "");
      setParameterSchemaText(JSON.stringify(preview.parameter_schema ?? {}, null, 2));
      setIconKey(preview.icon?.key || "");
      setIconUrl(preview.icon?.url || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse TS adapter.");
    } finally {
      setPreviewingTS(false);
    }
  };

  const handleSave = async () => {
    const modelList = normalizeModelList(modelListText);
    if (!name.trim() || (adapterRuntime !== "ts" && !baseUrl.trim())) {
      setError("名称和 Base URL 不能为空");
      return;
    }
    if (modelList.length === 0) {
      setError("至少填写一个模型名称");
      return;
    }

    if (adapterRuntime === "ts" && !adapterCode.trim()) {
      setError("TS adapter code is required.");
      return;
    }

    let parameterSchema: ProviderConfigPayload["parameter_schema"] = {};
    try {
      parameterSchema = JSON.parse(parameterSchemaText || "{}");
    } catch {
      setError("参数 Schema 必须是合法 JSON");
      return;
    }

    setSaving(true);
    setError("");
    const payload: ProviderConfigPayload = {
      service_type: serviceType,
      vendor: vendor.trim() || "自定义",
      name: name.trim(),
      api_spec: apiSpec,
      protocol,
      base_url: baseUrl.trim(),
      api_key: apiKey.trim() || undefined,
      submit_endpoint: showCustomEndpoints ? submitEndpoint.trim() : "",
      query_endpoint: showCustomEndpoints ? queryEndpoint.trim() : "",
      model_list: modelList,
      default_model: defaultModel.trim() || modelList[0],
      priority,
      is_default: isDefault,
      capabilities: serviceCapabilities(serviceType),
      parameter_schema: parameterSchema,
      credit_cost: Math.max(0, Math.round(creditCost)),
      adapter_runtime: adapterRuntime,
      adapter_code: adapterRuntime === "ts" ? adapterCode : "",
      icon_key: iconKey.trim() || undefined,
      icon_url: iconUrl.trim() || undefined,
    };
    if (config) {
      payload.status = config.status;
    }

    try {
      if (config) await updateProviderConfig(config.id, payload);
      else await createProviderConfig(payload);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      data-testid="provider-config-modal"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 py-[6vh] backdrop-blur-sm"
    >
      <button className="absolute inset-0 cursor-default" aria-label="关闭配置面板" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[88vh] w-full max-w-[1120px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111111] text-neutral-100 shadow-[0_28px_90px_rgba(0,0,0,0.45)]"
      >
        <header className="flex items-center justify-between border-b border-white/[0.08] px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">{isEdit ? "编辑配置" : "新增配置"}</p>
            <h3 className="mt-1 text-lg font-semibold text-neutral-100">{isEdit ? config?.name : "模型服务配置"}</h3>
          </div>
          <button className="rounded-full p-2 text-neutral-500 transition hover:bg-white/[0.08] hover:text-white" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="prompt-editor-scroll flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="space-y-5 rounded-lg border border-white/[0.08] bg-white/[0.025] p-4">
          <Field label="服务类型">
            <select value={serviceType} onChange={(event) => setServiceType(event.target.value as ServiceType)} className={FIELD_SELECT}>
              {Object.entries(SERVICE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>

          <Field label="中转站模板">
            <div className="prompt-editor-scroll grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1">
              {templates.map((tpl) => (
                <button
                  key={`${tpl.vendor}-${tpl.label}`}
                  type="button"
                  onClick={() => applyTemplate(tpl)}
                  className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.045] px-3 py-2 text-left text-xs text-neutral-300 transition hover:border-white/[0.16] hover:bg-white/[0.075] hover:text-white"
                >
                  <ModelBrandIcon model={tpl.models[0]} vendor={tpl.vendor} providerName={tpl.label} iconKey={tpl.iconKey} size={18} />
                  <span className="min-w-0 flex-1 truncate">{tpl.label}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="供应商 TS 脚本">
            <div className="space-y-3 rounded-md border border-white/[0.08] bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-xs text-neutral-500">
                  <FileCode2 className="h-4 w-4 text-neutral-400" />
                  粘贴供应商 TS，按当前服务类型解析模型、输入项和图标。
                </span>
                <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={() => setCodeEditorOpen(true)}>
                  <FileCode2 className="mr-2 h-4 w-4" />
                  编辑代码
                </Button>
                <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={handlePreviewTSImport} disabled={previewingTS || !adapterCode.trim()}>
                  {previewingTS ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  解析导入
                </Button>
              </div>
              <button
                type="button"
                onClick={() => setCodeEditorOpen(true)}
                className="flex w-full items-center justify-between rounded-md border border-white/[0.08] bg-white/[0.045] px-4 py-3 text-left transition hover:border-white/[0.16] hover:bg-white/[0.075]"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-100">{adapterCode.trim() ? "已载入 TS 供应商代码" : "尚未填写 TS 供应商代码"}</span>
                  <span className="mt-1 block text-xs text-neutral-500">
                    {adapterCode.trim()
                      ? `${adapterCode.split(/\r?\n/).length} 行 · ${adapterCode.length} 字符 · 运行时将使用 TypeScript 供应商脚本`
                      : "点击打开大编辑器，可粘贴代码或导入 .ts 文件"}
                  </span>
                </span>
                <FileCode2 className="h-5 w-5 text-neutral-400" />
              </button>
            </div>
          </Field>

            </aside>
            <div className="space-y-5">

          <div className="grid grid-cols-2 gap-3">
            <Field label="厂商"><input value={vendor} onChange={(event) => setVendor(event.target.value)} className={FIELD_INPUT} /></Field>
            <Field label="显示名称"><input value={name} onChange={(event) => setName(event.target.value)} className={FIELD_INPUT} /></Field>
          </div>

          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
            <Field label="图标 Key"><input value={iconKey} onChange={(event) => setIconKey(event.target.value)} placeholder="openai / gemini / volcengine" className={FIELD_INPUT} /></Field>
            <Field label="图标 URL"><input value={iconUrl} onChange={(event) => setIconUrl(event.target.value)} placeholder="https://... or data:image/..." className={FIELD_INPUT} /></Field>
            <div className="pb-3">
              <ModelBrandIcon model={defaultModel || modelListText.split(/\n/)[0]} vendor={vendor} providerName={name} iconKey={iconKey} iconUrl={iconUrl} size={24} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="协议">
              <select value={protocol} onChange={(event) => setProtocol(event.target.value as GatewayProtocol)} className={FIELD_SELECT}>
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="newapi">NewAPI</option>
                <option value="native">Native</option>
              </select>
            </Field>
            <Field label="适配器">
              <select value={apiSpec} onChange={(event) => setApiSpec(event.target.value)} className={FIELD_SELECT}>
                <option value="openai">OpenAI</option>
                <option value="custom">Custom</option>
                <option value="ark">Volcengine Ark</option>
              </select>
            </Field>
          </div>

          <Field label="运行时">
            <select value={adapterRuntime} onChange={(event) => setAdapterRuntime(event.target.value as AdapterRuntime)} className={FIELD_SELECT}>
              <option value="go">Go 内置适配器</option>
              <option value="ts">TypeScript 供应商脚本</option>
            </select>
          </Field>

          <Field label="Base URL">
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example-newapi.com/v1" className={FIELD_INPUT} />
            <p className="mt-2 text-xs text-neutral-500">建议填写到 /v1；后端会对普通根域名自动补 /v1。</p>
          </Field>

          <Field label={isEdit ? "API Key（留空保持不变）" : "API Key"}>
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" className={FIELD_INPUT} />
          </Field>

          {showCustomEndpoints ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="提交端点"><input value={submitEndpoint} onChange={(event) => setSubmitEndpoint(event.target.value)} className={FIELD_INPUT} /></Field>
              <Field label="查询端点"><input value={queryEndpoint} onChange={(event) => setQueryEndpoint(event.target.value)} className={FIELD_INPUT} /></Field>
            </div>
          ) : null}

          <div className="rounded-md border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-xs text-neutral-500">
            最终端点：{endpointPreview}
          </div>

          <Field label="模型列表（每行一个）">
            <textarea value={modelListText} onChange={(event) => setModelListText(event.target.value)} className={`${FIELD_INPUT} min-h-28 resize-none py-3`} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="默认模型"><input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} className={FIELD_INPUT} /></Field>
            <Field label="优先级"><input value={priority} onChange={(event) => setPriority(Number(event.target.value) || 0)} type="number" className={FIELD_INPUT} /></Field>
          </div>

          <Field label="积分 / 次（每次生成扣除）">
            <input
              value={creditCost}
              onChange={(event) => setCreditCost(Math.max(0, Number(event.target.value) || 0))}
              type="number"
              min={0}
              step={1}
              className={FIELD_INPUT}
            />
            <p className="mt-1 text-[11px] text-neutral-500">用此配置生成一次扣除的积分数。0 = 免费。按模型差异化可在下方 Schema 的 models.&lt;模型名&gt;.credit_cost 设置。</p>
          </Field>

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} className="accent-neutral-300" />
            设为默认配置
          </label>

          <Field label="参数 Schema JSON">
            <textarea
              value={parameterSchemaText}
              onChange={(event) => setParameterSchemaText(event.target.value)}
              spellCheck={false}
              className={`${FIELD_INPUT} min-h-36 resize-y py-3 font-mono text-xs`}
            />
            <p className="mt-2 text-xs text-neutral-500">控制前端参数按钮和后端允许透传字段，例如 quality_options、size_options、output_format_options、allowed_parameters、defaults。</p>
          </Field>

          {error ? <div className="rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-white/[0.08] bg-white/[0.025] px-6 py-4">
          <Button variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={onClose}>取消</Button>
          <Button className={SETTINGS_PRIMARY_BUTTON} onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}保存配置</Button>
        </footer>
        {codeEditorOpen ? (
          <Suspense fallback={<ProviderCodeEditorFallback />}>
            <ProviderCodeEditorModal
              open={codeEditorOpen}
              initialCode={adapterCode}
              onClose={() => setCodeEditorOpen(false)}
              onConfirm={(code) => {
                setAdapterCode(code);
                if (code.trim()) setAdapterRuntime("ts");
                setCodeEditorOpen(false);
              }}
            />
          </Suspense>
        ) : null}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm text-neutral-300">
      <span className="mb-2 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm text-neutral-300">
      <span className="mb-2 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function ActionIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.035] text-neutral-400 transition hover:border-white/[0.16] hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

function AnimatedProviderSwitch({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  const trackRef = useRef<HTMLButtonElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!trackRef.current || !knobRef.current) return;
    const duration = prefersReducedMotion() ? 0 : 0.24;
    gsap.to(knobRef.current, {
      x: checked ? 16 : 0,
      duration,
      ease: "power3.out",
      overwrite: "auto",
    });
    gsap.to(trackRef.current, {
      backgroundColor: checked ? "rgba(16, 185, 129, 0.72)" : "rgba(64, 64, 64, 0.95)",
      boxShadow: checked ? "0 0 0 1px rgba(16,185,129,0.16), 0 0 18px rgba(16,185,129,0.18)" : "0 0 0 1px rgba(255,255,255,0.04)",
      duration,
      ease: "power2.out",
      overwrite: "auto",
    });
  }, [checked]);

  return (
    <button
      type="button"
      ref={trackRef}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        if (!prefersReducedMotion() && trackRef.current && knobRef.current) {
          gsap.fromTo(trackRef.current, { scale: 0.96 }, { scale: 1, duration: 0.22, ease: "back.out(2)", overwrite: "auto" });
          gsap.fromTo(knobRef.current, { scale: 0.82 }, { scale: 1, duration: 0.24, ease: "back.out(2.2)", overwrite: "auto" });
        }
        onToggle();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="relative h-5 w-9 shrink-0 select-none rounded-full bg-neutral-700 outline-none transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white/30"
    >
      <span ref={knobRef} className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-[0_3px_10px_rgba(0,0,0,0.28)]" />
    </button>
  );
}

export function AdminModelCatalogPage({ panel = "model-service" }: { panel?: SettingsPanelKey } = {}) {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [codeEditingConfig, setCodeEditingConfig] = useState<ProviderConfig | null>(null);
  const [codeSaving, setCodeSaving] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [modelEditor, setModelEditor] = useState<ModelEditorState | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelEditorError, setModelEditorError] = useState("");
  const [testingModelKey, setTestingModelKey] = useState<string | null>(null);
  const [modelTestResult, setModelTestResult] = useState<ModelTestResult | null>(null);
  const activePanel = panel;
  const pageMeta = SETTINGS_PAGE_META[activePanel];

  const loadConfigs = async () => {
    setLoading(true);
    try {
      setConfigs(await listProviderConfigs());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfigs();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return configs;
    return configs.filter((config) =>
      [config.name, config.vendor, config.base_url, config.default_model, config.protocol]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(q)),
    );
  }, [configs, query]);

  const enabledCount = configs.filter((item) => item.status === "enabled").length;
  const selectedConfig = filtered.find((config) => config.id === selectedId) ?? filtered[0] ?? null;
  const selectedConfigModels = selectedConfig ? getVendorModels(selectedConfig) : [];
  const availableTextModels = useMemo(() => {
    const seen = new Set<string>();
    const models: string[] = [];
    configs
      .filter((config) => config.service_type === "text" && config.status === "enabled")
      .sort((a, b) => a.priority - b.priority)
      .forEach((config) => {
        config.model_list.forEach((model) => {
          const clean = model.trim();
          if (clean && !seen.has(clean)) {
            seen.add(clean);
            models.push(clean);
          }
        });
      });
    return models;
  }, [configs]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((config) => config.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const openCreate = () => {
    setEditing(null);
    setConfigModalOpen(true);
  };

  const openEdit = (config: ProviderConfig) => {
    setEditing(config);
    setConfigModalOpen(true);
  };

  const replaceConfig = (updated: ProviderConfig) => {
    setConfigs((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  };

  const handleToggle = async (config: ProviderConfig) => {
    replaceConfig(await toggleProviderConfigStatus(config.id));
  };

  const handleResetHealth = async (config: ProviderConfig) => {
    setResettingId(config.id);
    try {
      replaceConfig(await resetChannelHealth(config.id));
    } finally {
      setResettingId(null);
    }
  };

  const handleTestConnectivity = async (config: ProviderConfig, model?: VendorModelDefinition) => {
    const modelKey = model ? `${config.id}:${model.modelName}` : null;
    const target = {
      configName: config.name,
      modelName: model?.modelName ?? config.default_model ?? config.model_list[0] ?? config.name,
      type: model?.type ?? config.service_type,
    };
    if (modelKey) setTestingModelKey(modelKey);
    else setTestingId(config.id);
    setModelTestResult({
      ...target,
      status: "loading",
      ok: false,
      httpStatus: 0,
      latencyMs: 0,
    });
    try {
      const result = await testChannelConnectivity(config.id);
      setModelTestResult({
        ...target,
        status: result.ok ? "success" : "failed",
        ok: result.ok,
        httpStatus: result.http_status,
        latencyMs: result.latency_ms,
        errorMsg: result.error_msg,
      });
      void loadConfigs().catch((err) => {
        console.warn("Failed to refresh provider configs after connectivity test", err);
      });
    } catch (err) {
      setModelTestResult({
        ...target,
        status: "failed",
        ok: false,
        httpStatus: 0,
        latencyMs: 0,
        errorMsg: toAdminErrorSummary(err, "zh"),
      });
    } finally {
      if (modelKey) setTestingModelKey(null);
      else setTestingId(null);
    }
  };

  const handleDelete = async (config: ProviderConfig) => {
    if (!confirm(`确认删除「${config.name}」？`)) return;
    await deleteProviderConfig(config.id);
    setConfigs((prev) => prev.filter((item) => item.id !== config.id));
  };

  const providerPayloadFromConfig = (config: ProviderConfig): ProviderConfigPayload => ({
    service_type: config.service_type,
    vendor: config.vendor,
    name: config.name,
    api_spec: config.api_spec,
    protocol: config.protocol,
    base_url: config.base_url,
    submit_endpoint: config.submit_endpoint,
    query_endpoint: config.query_endpoint,
    model_list: config.model_list,
    default_model: config.default_model,
    priority: config.priority,
    is_default: config.is_default,
    status: config.status,
    capabilities: config.capabilities,
    parameter_schema: config.parameter_schema,
    adapter_runtime: config.adapter_runtime,
    adapter_code: config.adapter_code || "",
    icon_key: config.icon_key,
    icon_url: config.icon_url,
  });

  const handleSaveCode = async (config: ProviderConfig, code: string) => {
    if (!code.trim()) {
      setCodeError("TS 代码不能为空");
      return;
    }
    setCodeSaving(true);
    setCodeError("");
    try {
      const preview = await previewProviderConfigTSImport(code, config.service_type);
      const payload: ProviderConfigPayload = {
        ...providerPayloadFromConfig(config),
        service_type: preview.service_type || config.service_type,
        vendor: preview.vendor || config.vendor,
        name: preview.name || config.name,
        api_spec: preview.api_spec || config.api_spec,
        protocol: preview.protocol || config.protocol,
        base_url: preview.base_url || config.base_url,
        submit_endpoint: preview.submit_endpoint ?? config.submit_endpoint,
        query_endpoint: preview.query_endpoint ?? config.query_endpoint,
        model_list: preview.model_list?.length ? preview.model_list : config.model_list,
        default_model: preview.default_model || preview.model_list?.[0] || config.default_model,
        capabilities: preview.capabilities?.length ? preview.capabilities : config.capabilities,
        parameter_schema: preview.parameter_schema ?? config.parameter_schema,
        adapter_runtime: "ts",
        adapter_code: code,
        icon_key: preview.icon?.key || config.icon_key,
        icon_url: preview.icon?.url || config.icon_url,
      };
      replaceConfig(await updateProviderConfig(config.id, payload));
      setCodeEditingConfig(null);
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : "TS 代码保存失败");
    } finally {
      setCodeSaving(false);
    }
  };

  const saveModelsForConfig = async (config: ProviderConfig, models: VendorModelDefinition[], defaultModel?: string) => {
    const modelList = models.map((item) => item.modelName).filter(Boolean);
    const parameterSchema = syncModelCreditCostsIntoSchema({
      ...(config.parameter_schema ?? {}),
      vendor_models: models,
      vendor_all_models: models,
    }, models);
    const capabilities = Array.from(new Set<ServiceType>([config.service_type, ...models.map((item) => item.type)]));
    const updated = await updateProviderConfig(config.id, {
      ...providerPayloadFromConfig(config),
      model_list: modelList,
      default_model: defaultModel ?? (modelList.includes(config.default_model) ? config.default_model : modelList[0] || ""),
      capabilities,
      parameter_schema: parameterSchema,
    });
    replaceConfig(updated);
    return updated;
  };

  const openAddModel = (config: ProviderConfig) => {
    setModelEditorError("");
    setModelEditor({
      config,
      draft: createModelDraft(config),
    });
  };

  const openEditModel = (config: ProviderConfig, model: VendorModelDefinition) => {
    setModelEditorError("");
    setModelEditor({
      config,
      originalModelName: model.modelName,
      draft: createModelDraft(config, model),
    });
  };

  const handleSaveModel = async () => {
    if (!modelEditor) return;
    const model = buildModelFromDraft(modelEditor.draft);
    if (!model) {
      setModelEditorError("请填写显示名称和模型 ID");
      return;
    }
    const models = getVendorModels(modelEditor.config);
    const duplicate = models.some((item) => item.modelName === model.modelName && item.modelName !== modelEditor.originalModelName);
    if (duplicate) {
      setModelEditorError("模型 ID 已存在");
      return;
    }
    const nextModels = modelEditor.originalModelName
      ? models.map((item) => (item.modelName === modelEditor.originalModelName ? model : item))
      : [...models, model];
    const defaultModel = modelEditor.draft.isDefault || modelEditor.config.default_model === modelEditor.originalModelName
      ? model.modelName
      : modelEditor.config.default_model || nextModels[0]?.modelName || "";
    setModelSaving(true);
    setModelEditorError("");
    try {
      await saveModelsForConfig(modelEditor.config, nextModels, defaultModel);
      setModelEditor(null);
    } catch (err) {
      setModelEditorError(err instanceof Error ? err.message : "模型保存失败");
    } finally {
      setModelSaving(false);
    }
  };

  const handleDeleteModel = async (config: ProviderConfig, model: VendorModelDefinition) => {
    if (!confirm(`确认删除模型「${model.name || model.modelName}」？`)) return;
    const models = getVendorModels(config);
    if (!models.some((item) => item.modelName === model.modelName)) return;
    const nextModels = models.filter((item) => item.modelName !== model.modelName);
    await saveModelsForConfig(
      config,
      nextModels,
      config.default_model === model.modelName ? nextModels[0]?.modelName || "" : config.default_model,
    );
  };

  return (
    <AdminShell
      title={pageMeta.title}
      description={pageMeta.description}
      action={activePanel === "model-service" ? <Button onClick={openCreate}><Plus className="mr-1 h-4 w-4" />新增模型配置</Button> : null}
    >
      <div className="space-y-5">
        {activePanel === "model-service" ? <section className="rounded-[28px] border border-white/[0.08] bg-white/[0.035] p-4 shadow-2xl shadow-black/30">
          <div className="flex flex-wrap items-center gap-4">
            <StatCard label="配置总数" value={configs.length} />
            <StatCard label="在线模型" value={enabledCount} />
            <div className="relative min-w-[280px] flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-11 w-full rounded-full border border-white/[0.08] bg-black/20 pl-11 pr-4 text-sm text-white outline-none transition focus:border-white/[0.18] focus:ring-2 focus:ring-white/[0.04]"
                placeholder="搜索名称、厂商、Base URL、协议或模型"
              />
            </div>
            <Button variant="secondary" onClick={loadConfigs} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              刷新
            </Button>
          </div>
        </section> : null}

        {activePanel === "model-service" ? (
          <section data-testid="settings-panel-model-service" className="grid min-h-[680px] grid-cols-[260px_1fr] overflow-hidden rounded-[28px] border border-white/[0.10] bg-[#101010]/95 text-neutral-100 shadow-2xl shadow-black/35">
            <aside className="border-r border-white/[0.06] bg-white/[0.025] p-4">
              <Button onClick={openCreate} className={`mb-3 h-10 w-full rounded-full ${SETTINGS_PRIMARY_BUTTON}`}>
                <Plus className="mr-2 h-4 w-4" />
                添加供应商
              </Button>
              <div className="space-y-1">
                {loading ? (
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-4 py-6 text-center text-sm text-neutral-500">加载中...</div>
                ) : filtered.length === 0 ? (
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-4 py-6 text-center text-sm text-neutral-500">暂无供应商</div>
                ) : (
                  filtered.map((config) => (
                    <div
                      key={config.id}
                      role="button"
                      tabIndex={0}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setSelectedId(config.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") setSelectedId(config.id);
                      }}
                      className={[
                        "flex w-full cursor-pointer select-none items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition",
                        selectedConfig?.id === config.id ? "border-white/[0.14] bg-white/[0.08] text-white shadow-sm" : "border-transparent text-neutral-400 hover:border-white/[0.08] hover:bg-white/[0.045] hover:text-neutral-100",
                      ].join(" ")}
                    >
                      <ModelBrandIcon model={config.default_model || config.model_list?.[0]} vendor={config.vendor} providerName={config.name} iconKey={config.icon_key} iconUrl={config.icon_url} size={18} />
                      <span className="min-w-0 flex-1 truncate">{config.vendor || config.name}</span>
                      <AnimatedProviderSwitch
                        checked={config.status === "enabled"}
                        label={`${config.vendor || config.name} ${config.status === "enabled" ? "禁用" : "启用"}`}
                        onToggle={() => void handleToggle(config)}
                      />
                    </div>
                  ))
                )}
              </div>
            </aside>

            <div className="flex min-w-0 flex-col bg-[#111111] p-5">
              {selectedConfig ? (
                <>
                  <div className="flex items-center justify-between border-b border-white/[0.08] pb-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <ModelBrandIcon model={selectedConfig.default_model || selectedConfig.model_list?.[0]} vendor={selectedConfig.vendor} providerName={selectedConfig.name} iconKey={selectedConfig.icon_key} iconUrl={selectedConfig.icon_url} size={28} />
                        <div className="min-w-0">
                          <h3 className="truncate text-lg font-semibold text-neutral-100">{selectedConfig.name}</h3>
                          <p className="mt-1 truncate text-xs text-neutral-500">{selectedConfig.vendor} · {selectedConfig.base_url || "TS 供应商脚本"}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className={SETTINGS_BADGE}>{SERVICE_LABELS[selectedConfig.service_type]}</span>
                        <span className={SETTINGS_BADGE}>{selectedConfig.protocol || "openai_compatible"}</span>
                        {selectedConfig.adapter_runtime === "ts" ? <span className={SETTINGS_BADGE}>TS 脚本</span> : null}
                        <span className={SETTINGS_BADGE}>模型 ×{selectedConfig.model_list.length}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" onClick={() => handleToggle(selectedConfig)}>
                        <Power className="mr-2 h-4 w-4" />
                        {STATUS_LABEL[selectedConfig.status]}
                      </Button>
                      <Button variant="secondary" onClick={() => openEdit(selectedConfig)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        编辑配置
                      </Button>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto py-4">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <h4 className="text-sm font-semibold text-neutral-100">模型设置</h4>
                      <Button type="button" variant="secondary" size="sm" className={SETTINGS_PANEL_BUTTON} onClick={() => openAddModel(selectedConfig)}>
                        <Plus className="mr-1 h-4 w-4" />
                        手动添加
                      </Button>
                    </div>
                    <div className="space-y-3">
                      {selectedConfigModels.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-white/[0.12] bg-white/[0.035] px-4 py-10 text-center text-sm text-neutral-500">该供应商还没有模型</div>
                      ) : (
                        selectedConfigModels.map((model) => (
                          <div key={model.modelName} className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-5 py-4 shadow-sm transition hover:border-white/[0.16] hover:bg-white/[0.055]">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <div className="flex items-center gap-3">
                                  <ModelBrandIcon model={model.modelName} vendor={selectedConfig.vendor} providerName={selectedConfig.name} iconKey={selectedConfig.icon_key} iconUrl={selectedConfig.icon_url} size={22} />
                                  <h4 className="truncate text-base font-semibold text-neutral-100">{model.name || model.modelName}</h4>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {modelTags(model, selectedConfig).map((tag) => <span key={tag} className={SETTINGS_BADGE}>{tag}</span>)}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-3 text-xs">
                                <button
                                  type="button"
                                  onClick={() => handleTestConnectivity(selectedConfig, model)}
                                  disabled={testingModelKey === `${selectedConfig.id}:${model.modelName}`}
                                  className="font-medium text-neutral-400 transition hover:text-white disabled:cursor-wait disabled:opacity-60"
                                >
                                  {testingModelKey === `${selectedConfig.id}:${model.modelName}` ? "测试中" : "测试"}
                                </button>
                                <button type="button" onClick={() => openEditModel(selectedConfig, model)} className="font-medium text-neutral-400 transition hover:text-white">编辑</button>
                                <button type="button" onClick={() => handleDeleteModel(selectedConfig, model)} className="font-medium text-red-500 transition hover:text-red-400">删除</button>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="flex justify-end gap-3 border-t border-white/[0.08] pt-4">
                    <button
                      type="button"
                      onClick={() => handleDelete(selectedConfig)}
                      className="h-10 rounded bg-red-500 px-5 text-sm font-medium text-white transition hover:bg-red-600"
                    >
                      删除供应商
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCodeError("");
                        setCodeEditingConfig(selectedConfig);
                      }}
                      className="h-10 rounded-full border border-white/[0.10] bg-white/[0.035] px-5 text-sm font-medium text-neutral-200 transition hover:border-white/[0.18] hover:bg-white/[0.075] hover:text-white"
                    >
                      编辑代码
                    </button>
                  </div>
                </>
              ) : (
                <div className="grid h-full place-items-center rounded-xl border border-dashed border-white/[0.12] bg-white/[0.035] text-sm text-neutral-500">选择或新增一个供应商</div>
              )}
            </div>
          </section>
        ) : null}

        {activePanel === "agent-config" ? (
          <section className="rounded-[28px] border border-white/[0.10] bg-[#101010]/95 p-5 text-neutral-100 shadow-2xl shadow-black/35">
            <AdminAgentConfigPanel availableModels={availableTextModels} />
          </section>
        ) : null}

        {activePanel === "prompt-manage" ? (
          <section className="rounded-[28px] border border-white/[0.10] bg-[#101010]/95 p-5 text-neutral-100 shadow-2xl shadow-black/35">
            <PromptManagePanel />
          </section>
        ) : null}

        {activePanel === "skill-management" ? (
          <section className="rounded-[28px] border border-white/[0.10] bg-[#101010]/95 p-5 text-neutral-100 shadow-2xl shadow-black/35">
            <SkillManagementPanel />
          </section>
        ) : null}

        {activePanel === "memory-config" ? (
          <section className="rounded-[28px] border border-white/[0.10] bg-[#101010]/95 p-5 text-neutral-100 shadow-2xl shadow-black/35">
            <MemoryConfigPanel />
          </section>
        ) : null}

        <section className="hidden overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#101010]/85 shadow-2xl shadow-black/35">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/[0.035] text-xs uppercase tracking-[0.12em] text-neutral-500">
              <tr>
                <th className="px-4 py-3">服务类型</th>
                <th className="px-4 py-3">厂商</th>
                <th className="px-4 py-3">名称</th>
                <th className="px-4 py-3">Base URL</th>
                <th className="px-4 py-3">协议</th>
                <th className="px-4 py-3">默认模型</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">健康</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {loading ? (
                <tr><td colSpan={9} className="py-16 text-center text-neutral-500">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="py-16 text-center text-neutral-600">{configs.length === 0 ? "暂无配置，点击「新增模型配置」开始" : "无匹配结果"}</td></tr>
              ) : (
                filtered.map((config) => (
                  <tr key={config.id} className="group transition hover:bg-white/[0.025]">
                    <td className="px-4 py-3"><Badge className={SERVICE_BADGE_STYLES[config.service_type]}>{SERVICE_LABELS[config.service_type]}</Badge></td>
                    <td className="px-4 py-3 text-neutral-300">
                      <span className="inline-flex items-center gap-2">
                        <ModelBrandIcon model={config.default_model || config.model_list?.[0]} vendor={config.vendor} providerName={config.name} iconKey={config.icon_key} iconUrl={config.icon_url} size={20} />
                        <span>{config.vendor}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-neutral-100">
                      <span className="inline-flex max-w-[220px] items-center gap-2">
                        <span className="truncate">{config.name}</span>
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 font-mono text-xs text-neutral-500" title={config.base_url}>{config.base_url}</td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">{config.protocol || "openai_compatible"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">
                      <span className="inline-flex items-center gap-2">
                        <ModelBrandIcon model={config.default_model || config.model_list?.[0]} vendor={config.vendor} providerName={config.name} iconKey={config.icon_key} iconUrl={config.icon_url} size={18} />
                        <span>{config.default_model || "-"}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2 text-xs text-neutral-300">
                        <span className={["h-2 w-2 rounded-full", config.status === "enabled" ? "bg-emerald-400" : "bg-neutral-600"].join(" ")} />
                        {STATUS_LABEL[config.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3"><ChannelHealthBadge config={config} /></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5 opacity-80 transition group-hover:opacity-100">
                        <ActionIconButton label="编辑" onClick={() => openEdit(config)}><Pencil className="h-3.5 w-3.5" /></ActionIconButton>
                        <ActionIconButton label="重置健康" disabled={resettingId === config.id} onClick={() => handleResetHealth(config)}>
                          {resettingId === config.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                        </ActionIconButton>
                        <ActionIconButton label="测试连通" disabled={testingId === config.id} onClick={() => handleTestConnectivity(config)}>
                          {testingId === config.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                        </ActionIconButton>
                        <ActionIconButton label={config.status === "enabled" ? "禁用" : "启用"} onClick={() => handleToggle(config)}><Power className="h-3.5 w-3.5" /></ActionIconButton>
                        <ActionIconButton label="删除" onClick={() => handleDelete(config)}><Trash2 className="h-3.5 w-3.5" /></ActionIconButton>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="border-t border-white/[0.06] px-4 py-3 text-xs text-neutral-500">共 {configs.length} 条 · {enabledCount} 个已启用</div>
        </section>
      </div>

      <ConfigModal config={editing} open={configModalOpen} onClose={() => setConfigModalOpen(false)} onSaved={loadConfigs} />
      {modelEditor ? (
        <ModelEditorModal
          editor={modelEditor}
          saving={modelSaving}
          error={modelEditorError}
          onChange={(draft) => setModelEditor((prev) => (prev ? { ...prev, draft } : prev))}
          onClose={() => {
            if (!modelSaving) setModelEditor(null);
          }}
          onSave={handleSaveModel}
        />
      ) : null}
      {modelTestResult ? (
        <ModelTestResultModal result={modelTestResult} onClose={() => setModelTestResult(null)} />
      ) : null}
      {codeEditingConfig ? (
        <Suspense fallback={<ProviderCodeEditorFallback />}>
          <ProviderCodeEditorModal
            open={Boolean(codeEditingConfig)}
            initialCode={codeEditingConfig.adapter_code || ""}
            saving={codeSaving}
            error={codeError}
            onClose={() => {
              if (!codeSaving) setCodeEditingConfig(null);
            }}
            onConfirm={(code) => {
              if (codeEditingConfig) void handleSaveCode(codeEditingConfig, code);
            }}
          />
        </Suspense>
      ) : null}
    </AdminShell>
  );
}

function toggleArrayValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function ModelEditorModal({
  editor,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  editor: ModelEditorState;
  saving: boolean;
  error: string;
  onChange: (draft: ModelEditorDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const draft = editor.draft;
  const update = (patch: Partial<ModelEditorDraft>) => onChange({ ...draft, ...patch });
  const setType = (type: ServiceType) => {
    update({
      type,
      imageModes: type === "image" ? (draft.imageModes.length ? draft.imageModes : ["text"]) : draft.imageModes,
      videoModes: type === "video" ? (draft.videoModes.length ? draft.videoModes : ["text"]) : draft.videoModes,
    });
  };

  return (
    <CenterModal title={editor.originalModelName ? "编辑模型" : "添加模型"} onClose={onClose} widthClass="max-w-[760px]">
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <SettingsField label="显示名称">
            <input value={draft.name} onChange={(event) => update({ name: event.target.value })} className={SETTINGS_INPUT} placeholder="如：GPT Image 2" />
          </SettingsField>
          <SettingsField label="模型 ID">
            <input value={draft.modelName} onChange={(event) => update({ modelName: event.target.value })} className={SETTINGS_INPUT} placeholder="如：gpt-image-2" />
          </SettingsField>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <SettingsField label="模型类型">
            <select value={draft.type} onChange={(event) => setType(event.target.value as ServiceType)} className={SETTINGS_SELECT}>
              {MODEL_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </SettingsField>
          <div className="mt-6 flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input type="checkbox" checked={draft.isDefault} onChange={(event) => update({ isDefault: event.target.checked })} className="accent-neutral-300" />
              设为默认模型
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300" title="关闭后模型仍可被调用（如超分等内部功能），但不出现在前端的模型选择列表里">
              <input type="checkbox" checked={!draft.hidden} onChange={(event) => update({ hidden: !event.target.checked })} className="accent-neutral-300" />
              在模型选择中显示
            </label>
          </div>
        </div>

        <SettingsField label="积分 / 次（留空继承供应商默认）">
          <input
            type="number"
            min={0}
            step={1}
            value={draft.creditCost}
            onChange={(event) => update({ creditCost: event.target.value })}
            className={SETTINGS_INPUT}
            placeholder={`继承 ${getModelCreditCost(editor.config, draft.modelName || editor.originalModelName || "")}/次`}
          />
        </SettingsField>

        {draft.type === "text" ? (
          <label className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.035] px-3 py-2 text-sm text-neutral-300">
            <input type="checkbox" checked={draft.think} onChange={(event) => update({ think: event.target.checked })} className="accent-neutral-300" />
            支持深度思考
          </label>
        ) : null}

        {draft.type === "image" ? (
          <SettingsField label="图片模式">
            <div className="flex flex-wrap gap-2 rounded-lg border border-white/[0.08] bg-white/[0.035] p-3">
              {IMAGE_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => update({ imageModes: toggleArrayValue(draft.imageModes, option.value) })}
                  className={[
                    "rounded-full border px-3 py-1 text-xs transition",
                    draft.imageModes.includes(option.value) ? "border-white/[0.18] bg-white/[0.10] text-white" : "border-white/[0.08] bg-white/[0.045] text-neutral-400 hover:border-white/[0.16] hover:text-neutral-100",
                  ].join(" ")}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SettingsField>
        ) : null}

        {draft.type === "video" ? (
          <div className="space-y-4">
            <SettingsField label="视频模式">
              <div className="flex flex-wrap gap-2 rounded-lg border border-white/[0.08] bg-white/[0.035] p-3">
                {VIDEO_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => update({ videoModes: toggleArrayValue(draft.videoModes, option.value) })}
                    className={[
                      "rounded-full border px-3 py-1 text-xs transition",
                      draft.videoModes.includes(option.value) ? "border-white/[0.18] bg-white/[0.10] text-white" : "border-white/[0.08] bg-white/[0.045] text-neutral-400 hover:border-white/[0.16] hover:text-neutral-100",
                    ].join(" ")}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </SettingsField>

            {draft.videoModes.includes("multiReference") ? (
              <div className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-3">
                <p className="mb-3 text-xs font-medium text-neutral-500">多参考数量</p>
                <div className="flex flex-wrap gap-3">
                  {REFERENCE_MODE_OPTIONS.map((option) => {
                    const checked = draft.mixedMode.includes(option.value);
                    return (
                      <label key={option.value} className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-black/20 px-3 py-2 text-xs text-neutral-300">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => update({ mixedMode: toggleArrayValue(draft.mixedMode, option.value) })}
                          className="accent-neutral-300"
                        />
                        {option.label}
                        {checked ? (
                          <input
                            type="number"
                            min={1}
                            max={99}
                            value={draft.mixedModeCount[option.value] ?? 1}
                            onChange={(event) => update({ mixedModeCount: { ...draft.mixedModeCount, [option.value]: Number(event.target.value) || 1 } })}
                            className="h-7 w-16 rounded border border-white/[0.08] bg-white/[0.045] px-2 text-neutral-100 outline-none"
                          />
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <SettingsField label="音频输出">
              <select value={String(draft.audio)} onChange={(event) => update({ audio: event.target.value === "true" ? true : event.target.value === "false" ? false : "optional" })} className={SETTINGS_SELECT}>
                <option value="optional">音频可选</option>
                <option value="true">仅音频</option>
                <option value="false">无音频</option>
              </select>
            </SettingsField>

            <SettingsField label="时长 / 分辨率">
              <div className="space-y-2 rounded-lg border border-white/[0.08] bg-white/[0.035] p-3">
                {draft.durationResolutionMap.map((row, index) => (
                  <div key={index} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                    <input
                      value={row.duration}
                      onChange={(event) => {
                        const rows = [...draft.durationResolutionMap];
                        rows[index] = { ...row, duration: event.target.value };
                        update({ durationResolutionMap: rows });
                      }}
                      className={SETTINGS_INPUT}
                      placeholder="时长，如 5, 10"
                    />
                    <input
                      value={row.resolution}
                      onChange={(event) => {
                        const rows = [...draft.durationResolutionMap];
                        rows[index] = { ...row, resolution: event.target.value };
                        update({ durationResolutionMap: rows });
                      }}
                      className={SETTINGS_INPUT}
                      placeholder="分辨率，如 720p, 1080p"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className={SETTINGS_PANEL_BUTTON}
                      disabled={draft.durationResolutionMap.length <= 1}
                      onClick={() => update({ durationResolutionMap: draft.durationResolutionMap.filter((_, rowIndex) => rowIndex !== index) })}
                    >
                      删除
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  className={`w-full ${SETTINGS_PANEL_BUTTON}`}
                  onClick={() => update({ durationResolutionMap: [...draft.durationResolutionMap, { duration: "", resolution: "" }] })}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  添加时长分辨率
                </Button>
              </div>
            </SettingsField>
          </div>
        ) : null}

        {error ? <div className="rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
      </div>
      <ModalFooter saving={saving} onClose={onClose} onSave={onSave} />
    </CenterModal>
  );
}

function ModelTestResultModal({ result, onClose }: { result: ModelTestResult; onClose: () => void }) {
  const loading = result.status === "loading";
  const success = result.status === "success";
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cardRef.current) return;
    const duration = prefersReducedMotion() ? 0 : 0.24;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        cardRef.current,
        { autoAlpha: 0, y: 6, scale: 0.985 },
        { autoAlpha: 1, y: 0, scale: 1, duration, ease: "power2.out", overwrite: "auto" },
      );
      if (!loading && !success) {
        gsap.fromTo(
          cardRef.current,
          { x: -5 },
          { x: 0, duration: prefersReducedMotion() ? 0 : 0.4, ease: "elastic.out(1, 0.55)", overwrite: "auto" },
        );
      }
    }, cardRef);
    return () => ctx.revert();
  }, [loading, result.errorMsg, result.httpStatus, result.status, success]);

  return (
    <CenterModal title={`测试结果 - ${result.modelName}`} onClose={onClose} widthClass="max-w-[560px]">
      <div className="space-y-4">
        <div ref={cardRef} className={[
          "rounded-xl border px-4 py-4",
          loading ? "border-white/[0.10] bg-white/[0.045]" : success ? "border-emerald-400/20 bg-emerald-500/10" : "border-rose-400/25 bg-rose-500/10",
        ].join(" ")}>
          <p className={["flex items-center gap-2 text-sm font-semibold", loading ? "text-neutral-100" : success ? "text-emerald-200" : "text-rose-200"].join(" ")}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {loading ? "正在测试连接..." : success ? "连接可用" : "连接失败"}
          </p>
          <p className="mt-2 text-xs leading-6 text-neutral-400">
            供应商：{result.configName} · 类型：{SERVICE_LABELS[result.type]}
            {loading ? " · 正在验证供应商连通性和凭据路径" : ` · HTTP：${result.httpStatus || "-"} · 耗时：${result.latencyMs}ms`}
          </p>
          {result.errorMsg ? <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-black/35 p-3 text-xs text-rose-100 [overflow-wrap:anywhere]">{result.errorMsg}</pre> : null}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={onClose}>关闭</Button>
        </div>
      </div>
    </CenterModal>
  );
}

const PANEL_PAGE_SIZE = 20;

const PANEL_PAGER_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition hover:bg-white/8 disabled:opacity-30 disabled:hover:bg-transparent";

function PanelPager({ page, pageCount, onChange, className = "mt-4" }: { page: number; pageCount: number; onChange: (page: number) => void; className?: string }) {
  if (pageCount <= 1) return null;
  return (
    <div className={`flex items-center justify-center gap-1 ${className}`}>
      <button type="button" onClick={() => onChange(0)} disabled={page === 0} className={PANEL_PAGER_BUTTON}>
        <ChevronsLeft className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0} className={PANEL_PAGER_BUTTON}>
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="px-2 text-[11px] tabular-nums text-neutral-400">{page + 1} / {pageCount}</span>
      <button type="button" onClick={() => onChange(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1} className={PANEL_PAGER_BUTTON}>
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => onChange(pageCount - 1)} disabled={page >= pageCount - 1} className={PANEL_PAGER_BUTTON}>
        <ChevronsRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AdminAgentConfigPanel({ availableModels }: { availableModels: string[] }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"ordinary" | "advanced">("ordinary");
  const [useMode, setUseMode] = useState<AgentUseMode>(0);
  const [editor, setEditor] = useState<{ agent: Agent | null; draft: AgentEditorDraft } | null>(null);
  const [page, setPage] = useState(0);

  // Reset the pager whenever the tab changes.
  useEffect(() => { setPage(0); }, [tab]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [nextAgents, nextSkills, nextUseMode] = await Promise.all([adminListAgents(), adminListSkills(), adminGetAgentUseMode()]);
      setAgents(nextAgents);
      setSkills(nextSkills);
      setUseMode(nextUseMode.mode);
      setTab(nextUseMode.mode === 1 ? "advanced" : "ordinary");
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const promptSkills = useMemo(() => skills.filter(isPromptTemplateSkill), [skills]);
  const models = availableModels.length ? availableModels : ["gpt-4.1-mini"];
  const firstModel = models[0] || "";
  const presetAgents = useMemo(
    () => AGENT_PRESETS.map((preset) => ({ preset, agent: findPresetAgent(agents, preset) })),
    [agents],
  );
  const pageCount = Math.max(1, Math.ceil(agents.length / PANEL_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedAgents = agents.slice(currentPage * PANEL_PAGE_SIZE, (currentPage + 1) * PANEL_PAGE_SIZE);

  const switchUseMode = async (value: "ordinary" | "advanced") => {
    const mode: AgentUseMode = value === "advanced" ? 1 : 0;
    setTab(value);
    setUseMode(mode);
    try {
      const saved = await adminUpdateAgentUseMode(mode);
      setUseMode(saved.mode);
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    }
  };

  const openEditor = (agent: Agent | null, preset?: AgentPresetDefinition) => {
    if (preset?.disabled) {
      setError("TTS 配音尚未接入音频模型服务，当前保持未开放。");
      return;
    }
    setError("");
    setEditor({
      agent,
      draft: createAgentDraft(agent, firstModel, preset),
    });
  };

  const seedPresets = async () => {
    setSaving(true);
    setError("");
    try {
      await adminSeedCreatorSuiteAgents();
      await load();
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setSaving(false);
    }
  };

  const saveEditor = async () => {
    if (!editor) return;
    if (!editor.draft.name.trim() || !editor.draft.systemPrompt.trim() || (editor.draft.enabled && !editor.draft.model.trim())) {
      setError("请填写 Agent 名称、系统提示词；启用 Agent 时必须配置模型。");
      return;
    }
    const payload: AgentUpsert = {
      name: editor.draft.name.trim(),
      description: editor.draft.description.trim(),
      avatar: editor.agent?.avatar || "",
      system_prompt: editor.draft.systemPrompt.trim(),
      model: editor.draft.model.trim(),
      deploy_key: editor.draft.deployKey.trim(),
      parent_deploy_key: editor.draft.parentDeployKey.trim(),
      model_name: editor.draft.modelName.trim(),
      provider_id: editor.draft.providerId.trim(),
      temperature: editor.draft.temperature,
      max_output_tokens: editor.draft.maxOutputTokens,
      runtime: editor.draft.runtime.trim() || "generic",
      metadata: {
        source: "creator-suite",
        display_group: "创作智能体套件",
      },
      skill_ids: editor.draft.skillIds,
      canvas_tools: editor.draft.canvasTools,
      strategy: editor.draft.strategy,
      enabled: editor.draft.enabled,
    };
    setSaving(true);
    setError("");
    try {
      if (editor.agent) await adminUpdateAgent(editor.agent.id, payload);
      else await adminCreateAgent(payload);
      setEditor(null);
      await load();
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="settings-panel-agent-config" className="flex h-full min-h-[620px] flex-col">
      <PanelHeader
        icon={<Bot className="h-5 w-5" />}
        title="Agent配置"
        description="管理创作智能体套件的简易/高级模型路由，并接入本项目真实 Agent CRUD。"
        action={
          <Button type="button" variant="secondary" onClick={() => void load()} disabled={loading} className={SETTINGS_PANEL_BUTTON}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            刷新
          </Button>
        }
      />

      <div className="mt-4 rounded-xl border border-emerald-400/15 bg-emerald-500/10 p-4 text-sm text-emerald-100">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-400/15 text-emerald-200">
              <ThumbsUp className="h-5 w-5" />
            </span>
            <span>使用创作智能体套件预设，可一键填入剧本 Agent、生产 Agent、通用 AI，开箱即用。</span>
          </div>
          <div className="flex gap-2">
            <Button type="button" className={SETTINGS_PRIMARY_BUTTON} disabled={saving || loading} onClick={() => void seedPresets()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
              一键填入
            </Button>
          </div>
        </div>
      </div>

      {error ? <div className="mt-4 rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}

      <div className="mt-4 flex gap-2 border-b border-white/[0.08]">
        {[
          ["ordinary", "简易配置"] as const,
          ["advanced", "高级配置"] as const,
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => void switchUseMode(value)}
            className={[
              "border-b-2 px-4 py-2 text-sm transition",
              (tab === value || (value === "ordinary" && useMode === 0) || (value === "advanced" && useMode === 1)) ? "border-white font-medium text-white" : "border-transparent text-neutral-500 hover:text-neutral-200",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "ordinary" ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {loading ? (
            <div className="col-span-full rounded-lg border border-white/[0.08] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500">Agent 加载中...</div>
          ) : (
            presetAgents.map(({ preset, agent }) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => openEditor(agent, preset)}
                className={[
                  "rounded-xl border p-4 text-left shadow-sm transition",
                  preset.disabled
                    ? "cursor-not-allowed border-white/[0.05] bg-white/[0.02] opacity-70"
                    : "border-white/[0.08] bg-white/[0.035] hover:border-white/[0.16] hover:bg-white/[0.055]",
                ].join(" ")}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.045] text-neutral-200">
                      {preset.icon === "script" ? <FileText className="h-5 w-5" /> : null}
                      {preset.icon === "production" ? <Clapperboard className="h-5 w-5" /> : null}
                      {preset.icon === "general" ? <MessageSquareText className="h-5 w-5" /> : null}
                      {preset.icon === "tts" ? <Volume2 className="h-5 w-5" /> : null}
                    </span>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-neutral-100">{preset.name}</h4>
                      <p className="mt-1 text-xs text-neutral-500">{agent ? "已接入本项目 Agent" : "等待配置"}</p>
                    </div>
                  </div>
                  <span className={agent && !preset.disabled ? "rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300" : preset.disabled ? "rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-xs text-neutral-500" : "rounded-full border border-amber-400/20 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300"}>
                    {agent && !preset.disabled ? agent.model || preset.modelHint : preset.disabled ? "未开放" : "未配置"}
                  </span>
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-neutral-500">{preset.description}</p>
              </button>
            ))
          )}
        </div>
      ) : (
        <>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {loading ? (
          <div className="col-span-full rounded-lg border border-white/[0.08] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500">Agent 加载中...</div>
        ) : agents.length === 0 ? (
          <button
            type="button"
            onClick={() => openEditor(null)}
            className="col-span-full rounded-lg border border-dashed border-white/[0.12] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500 transition hover:border-white/[0.18] hover:bg-white/[0.055] hover:text-neutral-300"
          >
            暂无 Agent，点击创建一个可配置的创作角色。
          </button>
        ) : (
          pagedAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => openEditor(agent)}
              className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-4 text-left shadow-sm transition hover:border-white/[0.16] hover:bg-white/[0.055]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/[0.08] bg-white/[0.045] text-neutral-300">
                    <Bot className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-semibold text-neutral-100">{agent.name}</h4>
                    <p className="mt-1 truncate text-xs text-neutral-500">{agent.description || "暂无描述"}</p>
                  </div>
                </div>
                <span className={agent.enabled ? "rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300" : "rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-xs text-neutral-500"}>
                  {agent.enabled ? "已启用" : "未启用"}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className={SETTINGS_BADGE}>{agent.model || "未配置模型"}</span>
                <span className={SETTINGS_BADGE}>Skills ×{agent.skill_ids.length}</span>
                <span className={SETTINGS_BADGE}>{agent.canvas_tools ? "画布工具" : "纯对话"}</span>
                <span className={SETTINGS_BADGE}>策略：{agent.strategy}</span>
              </div>
              <p className="mt-3 line-clamp-2 text-xs leading-5 text-neutral-500">{agent.system_prompt}</p>
            </button>
          ))
        )}
        </div>
        {!loading ? <PanelPager page={currentPage} pageCount={pageCount} onChange={setPage} /> : null}
        </>
      )}

      {editor ? (
        <AgentConfigModal
          editor={editor}
          models={models}
          skills={promptSkills}
          saving={saving}
          onChange={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void saveEditor()}
        />
      ) : null}
    </section>
  );
}

function PromptManagePanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [previewOnly, setPreviewOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<{
    skill: Skill | null;
    name: string;
    commandName: string;
    modelHint: string;
    content: string;
  } | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setSkills(await adminListSkills());
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const prompts = skills.filter(isPromptTemplateSkill);
  const pageCount = Math.max(1, Math.ceil(prompts.length / PANEL_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedPrompts = prompts.slice(currentPage * PANEL_PAGE_SIZE, (currentPage + 1) * PANEL_PAGE_SIZE);

  const openEditor = (skill: Skill | null) => {
    const spec = (skill?.spec ?? {}) as Record<string, unknown>;
    setEditor({
      skill,
      name: skill?.name || "新提示词模板",
      commandName: skill ? getSkillCommandName(skill) : "/new-prompt",
      modelHint: typeof spec.model_hint === "string" ? spec.model_hint : "",
      content: skill ? getSkillTemplateBody(skill) : "请基于当前画布上下文，输出清晰、可执行的创作建议。",
    });
  };

  const savePrompt = async () => {
    if (!editor) return;
    if (!editor.name.trim() || !editor.content.trim()) {
      setError("请填写提示词名称和内容。");
      return;
    }
    const spec = {
      ...(editor.skill?.spec ?? {}),
      slash_command: editor.commandName.trim().replace(/^\/+/, ""),
      content_md: editor.content,
      user_template: editor.content,
      model_hint: editor.modelHint,
      trigger_mode: "slash",
    };
    const payload: SkillUpsert = editor.skill
      ? skillToUpsert(editor.skill, { name: editor.name.trim(), kind: "prompt", spec })
      : {
        name: editor.name.trim(),
        description: "后台提示词模板",
        category: "prompt",
        icon: "file-text",
        kind: "prompt",
        spec,
        input_schema: {},
        output_schema: {},
        enabled: true,
      };
    setSaving(true);
    setError("");
    try {
      if (editor.skill) await adminUpdateSkill(editor.skill.id, payload);
      else await adminCreateSkill(payload);
      setEditor(null);
      await load();
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="settings-panel-prompt-manage" className="flex h-full min-h-[620px] flex-col">
      <PanelHeader
        icon={<FileText className="h-5 w-5" />}
        title="提示词管理"
        description="维护提示词模板卡片和 Markdown 编辑弹窗，保存到本项目 prompt Skill。"
        action={<Button onClick={() => openEditor(null)} className={SETTINGS_PRIMARY_BUTTON}><Plus className="mr-2 h-4 w-4" />新增提示词</Button>}
      />
      {error ? <div className="mt-4 rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {loading ? (
          <div className="col-span-full rounded-lg border border-white/[0.08] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500">提示词加载中...</div>
        ) : prompts.length === 0 ? (
          <button
            type="button"
            onClick={() => openEditor(null)}
            className="col-span-full rounded-lg border border-dashed border-white/[0.12] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500 transition hover:border-white/[0.18] hover:bg-white/[0.055] hover:text-neutral-300"
          >
            暂无提示词模板，点击创建一个。
          </button>
        ) : (
          pagedPrompts.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => openEditor(skill)}
              className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-4 text-left shadow-sm transition hover:border-white/[0.16] hover:bg-white/[0.055]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-neutral-100">{skill.name}</h4>
                  <p className="mt-1 text-xs text-neutral-500">{getSkillCommandName(skill)} · {skill.category || "prompt"}</p>
                </div>
                <span className="text-xs text-neutral-500">{getSkillCommandName(skill).replace(/^\//, "")}</span>
              </div>
              <p className="mt-3 line-clamp-2 text-xs leading-5 text-neutral-500">{getSkillTemplateBody(skill) || skill.description || "暂无提示词内容"}</p>
            </button>
          ))
        )}
      </div>
      {!loading ? <PanelPager page={currentPage} pageCount={pageCount} onChange={setPage} /> : null}
      {editor ? (
        <PromptEditorModal
          editor={editor}
          saving={saving}
          previewOnly={previewOnly}
          onTogglePreview={() => setPreviewOnly((value) => !value)}
          onChange={setEditor}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void savePrompt()}
        />
      ) : null}
    </section>
  );
}

function SkillManagementPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Reset the pager whenever the search keyword changes.
  useEffect(() => { setPage(0); }, [keyword]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminListSkills();
      setSkills(next);
      const nextSkillPaths = next.filter((skill) => !isPromptTemplateSkill(skill)).map(skillFilePath);
      const nextFolderPaths = collectSkillFolderPaths(nextSkillPaths);
      setActivePath((current) => {
        return current && nextSkillPaths.includes(current) ? current : nextSkillPaths[0] ?? null;
      });
      setExpandedPaths((current) => {
        if (current.size === 0) return new Set(nextFolderPaths);
        const nextExpanded = new Set(Array.from(current).filter((path) => nextFolderPaths.includes(path)));
        return nextExpanded.size === 0 ? new Set(nextFolderPaths) : nextExpanded;
      });
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const entries = skills
    .filter((skill) => !isPromptTemplateSkill(skill))
    .map((skill) => ({ skill, path: skillFilePath(skill), content: skillToMarkdown(skill) }));
  const filtered = entries.filter((entry) => {
    const q = keyword.trim().toLowerCase();
    if (!q) return true;
    return [entry.path, entry.skill.name, entry.skill.category, entry.skill.kind, entry.skill.description].some((value) => value.toLowerCase().includes(q));
  });
  const activeEntry = filtered.find((entry) => entry.path === activePath) ?? filtered[0] ?? null;
  const active = activeEntry?.skill ?? null;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PANEL_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedEntries = filtered.slice(currentPage * PANEL_PAGE_SIZE, (currentPage + 1) * PANEL_PAGE_SIZE);
  const skillTree = buildSkillTree(pagedEntries);

  const saveSkillContent = async () => {
    if (!active || draft === null) return;
    setSaving(true);
    setError("");
    try {
      const spec = active.kind === "prompt"
        ? {
          ...(active.spec ?? {}),
          content_md: draft,
          user_template: draft,
        }
        : {
          ...(active.spec ?? {}),
          content_md: draft,
        };
      const description = active.description || markdownLineToText(draft.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#")) || "");
      await adminUpdateSkill(active.id, skillToUpsert(active, { description, spec }));
      setDraft(null);
      await load();
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setSaving(false);
    }
  };

  const renderSkillTree = (nodes: SkillTreeNode[], depth = 0): ReactElement[] => nodes.flatMap((node) => {
    if (node.entry) {
      return [
        <button
          key={node.path}
          type="button"
          onClick={() => setActivePath(node.entry!.path)}
          className={[
            "flex w-full items-center gap-2 rounded-lg border py-2 pr-3 text-left text-sm transition",
            activeEntry?.path === node.entry.path
              ? "border-white/[0.14] bg-white/[0.08] text-white"
              : "border-transparent text-neutral-400 hover:border-white/[0.08] hover:bg-white/[0.045] hover:text-neutral-100",
          ].join(" ")}
          style={{ paddingLeft: 12 + depth * 12 }}
        >
          <File className="h-4 w-4 shrink-0 text-rose-300/80" />
          <span className="min-w-0 flex-1 truncate">{node.label}</span>
        </button>,
      ];
    }

    const forceExpanded = keyword.trim().length > 0;
    const expanded = forceExpanded || expandedPaths.has(node.path);
    return [
      <button
        key={node.path}
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpandedPaths((current) => {
            const next = new Set(current);
            if (next.has(node.path)) next.delete(node.path);
            else next.add(node.path);
            return next;
          });
        }}
        className="mt-2 flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left text-xs font-medium text-neutral-500 transition hover:border-white/[0.08] hover:bg-white/[0.045] hover:text-neutral-200"
        style={{ marginLeft: depth * 12 }}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <FolderOpen className="h-4 w-4 shrink-0" />
        <span className="truncate">{node.label}</span>
      </button>,
      ...(expanded ? renderSkillTree(node.children, depth + 1) : []),
    ];
  });

  return (
    <section data-testid="settings-panel-skill-management" className="flex h-full min-h-[620px] flex-col">
      <PanelHeader
        icon={<Sparkles className="h-5 w-5" />}
        title="Skills技能管理"
        description="按左侧列表和右侧预览方式查看技能，支持搜索和编辑 Skill spec。"
        action={<Button variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={() => void load()} disabled={loading}>{loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}刷新</Button>}
      />
      {error ? <div className="mt-4 rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
      <div className="mt-4 grid min-h-0 flex-1 gap-3 lg:grid-cols-[300px_1fr]">
        <aside className="flex min-h-0 flex-col rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索文件名"
            className={SETTINGS_INPUT}
          />
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-8 text-center text-sm text-neutral-500">加载中...</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-neutral-500">暂无 Skill</div>
            ) : (
              <div className="space-y-1">{renderSkillTree(skillTree)}</div>
            )}
          </div>
          {!loading ? <PanelPager page={currentPage} pageCount={pageCount} onChange={setPage} className="mt-2 border-t border-white/[0.06] pt-2" /> : null}
        </aside>
        <div className="flex min-h-0 flex-col rounded-lg border border-white/[0.08] bg-white/[0.025]">
          {active && activeEntry ? (
            <>
              <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
                <div>
                  <h4 className="text-sm font-semibold text-neutral-100">{activeEntry.path}</h4>
                  <p className="mt-1 text-xs text-neutral-500">{active.kind} · {active.category || "未分类"} · {active.enabled ? "已启用" : "未启用"}</p>
                </div>
                <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={() => setDraft(activeEntry.content)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  编辑
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <MarkdownPreview content={activeEntry.content} />
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center text-sm text-neutral-500">选择左侧 Skill 查看内容</div>
          )}
        </div>
      </div>
      {draft !== null && active ? (
        <SkillSpecEditorModal
          title={`编辑 ${active.name}`}
          draft={draft}
          saving={saving}
          onChange={setDraft}
          onClose={() => {
            if (!saving) setDraft(null);
          }}
          onSave={() => void saveSkillContent()}
        />
      ) : null}
    </section>
  );
}

function MemoryConfigPanel() {
  const [form, setForm] = useState<MemoryConfigForm>(DEFAULT_MEMORY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    adminGetAgentMemorySettings()
      .then((next) => {
        if (alive) setForm({ ...DEFAULT_MEMORY_CONFIG, ...next });
      })
      .catch((err) => {
        if (alive) setError(toAdminErrorSummary(err, "zh"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (next = form) => {
    setSaving(true);
    setError("");
    try {
      const saved = await adminUpdateAgentMemorySettings(next);
      setForm({ ...DEFAULT_MEMORY_CONFIG, ...saved });
      setNotice("记忆配置已保存。");
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setSaving(false);
    }
  };

  const restore = () => {
    setForm(DEFAULT_MEMORY_CONFIG);
    void save(DEFAULT_MEMORY_CONFIG);
  };

  const clear = () => {
    setForm(DEFAULT_MEMORY_CONFIG);
    void save(DEFAULT_MEMORY_CONFIG);
  };

  return (
    <section data-testid="settings-panel-memory-config" className="flex h-full min-h-[620px] flex-col">
      <PanelHeader
        icon={<BrainCircuit className="h-5 w-5" />}
        title="Agent记忆配置"
        description="沉淀本项目 Agent 记忆策略的后台配置入口。"
      />
      {loading ? <div className="mt-4 rounded-md border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-sm text-neutral-400">记忆配置加载中...</div> : null}
      {error ? <div className="mt-4 rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
      {notice ? <div className="mt-4 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{notice}</div> : null}
      <div className="mt-4 space-y-4">
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-4">
          <h4 className="text-sm font-semibold text-neutral-100">向量模型配置</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <SettingsField label="模型文件路径">
              <input
                value={form.modelOnnxFile}
                onChange={(event) => setForm({ ...form, modelOnnxFile: event.target.value })}
                className={SETTINGS_INPUT}
              />
              <p className="mt-2 text-xs text-neutral-500">data/models/{form.modelOnnxFile}</p>
            </SettingsField>
            <SettingsField label="量化类型">
              <select value={form.modelDtype} onChange={(event) => setForm({ ...form, modelDtype: event.target.value })} className={SETTINGS_SELECT}>
                {["fp16", "auto", "fp32", "q8", "int8", "uint8", "q4", "bnb4", "q4f16"].map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </SettingsField>
          </div>
        </div>
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-4">
          <h4 className="text-sm font-semibold text-neutral-100">记忆参数</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <MemoryNumberField label="多少条消息触发摘要" value={form.messagesPerSummary} onChange={(value) => setForm({ ...form, messagesPerSummary: value })} />
            <MemoryNumberField label="短期记忆条数" value={form.shortTermLimit} onChange={(value) => setForm({ ...form, shortTermLimit: value })} />
            <MemoryNumberField label="摘要最大长度" value={form.summaryMaxLength} onChange={(value) => setForm({ ...form, summaryMaxLength: value })} />
            <MemoryNumberField label="摘要召回数量" value={form.summaryLimit} onChange={(value) => setForm({ ...form, summaryLimit: value })} />
            <MemoryNumberField label="RAG 召回数量" value={form.ragLimit} onChange={(value) => setForm({ ...form, ragLimit: value })} />
            <MemoryNumberField label="深度检索摘要数" value={form.deepRetrieveSummaryLimit} onChange={(value) => setForm({ ...form, deepRetrieveSummaryLimit: value })} />
          </div>
        </div>
      </div>
      <div className="mt-auto flex justify-end gap-3 border-t border-white/[0.08] pt-4">
        <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={clear} disabled={saving}>清空为默认</Button>
        <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={restore} disabled={saving}>恢复默认</Button>
        <Button type="button" onClick={() => void save()} disabled={saving} className={SETTINGS_PRIMARY_BUTTON}>{saving ? "保存中..." : "保存配置"}</Button>
      </div>
    </section>
  );
}

function PanelHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/[0.08] bg-white/[0.045] text-neutral-200">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-neutral-100">{title}</h3>
          <p className="mt-1 text-sm text-neutral-500">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function AgentConfigModal({
  editor,
  models,
  skills,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  editor: { agent: Agent | null; draft: AgentEditorDraft };
  models: string[];
  skills: Skill[];
  saving: boolean;
  onChange: (draft: AgentEditorDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { draft } = editor;
  const toggleSkill = (id: string) => {
    const set = new Set(draft.skillIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange({ ...draft, skillIds: Array.from(set) });
  };

  return (
    <CenterModal title={editor.agent ? `${editor.agent.name} 模型配置` : "新增 Agent"} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <SettingsField label="Agent 名称"><input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} className={SETTINGS_INPUT} /></SettingsField>
          <SettingsField label="选择模型">
            {models.length ? (
              <select value={draft.model} onChange={(event) => onChange({ ...draft, model: event.target.value })} className={SETTINGS_SELECT}>
                {models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            ) : (
              <input value={draft.model} onChange={(event) => onChange({ ...draft, model: event.target.value })} className={SETTINGS_INPUT} />
            )}
          </SettingsField>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <SettingsField label="Deploy Key">
            <input value={draft.deployKey} onChange={(event) => onChange({ ...draft, deployKey: event.target.value })} className={SETTINGS_INPUT} />
          </SettingsField>
          <SettingsField label="Parent Key">
            <input value={draft.parentDeployKey} onChange={(event) => onChange({ ...draft, parentDeployKey: event.target.value })} className={SETTINGS_INPUT} />
          </SettingsField>
          <SettingsField label="Runtime">
            <input value={draft.runtime} onChange={(event) => onChange({ ...draft, runtime: event.target.value })} className={SETTINGS_INPUT} />
          </SettingsField>
          <SettingsField label="Model Name">
            <input value={draft.modelName} onChange={(event) => onChange({ ...draft, modelName: event.target.value })} className={SETTINGS_INPUT} placeholder="provider:model-id" />
          </SettingsField>
          <SettingsField label="Provider ID">
            <input value={draft.providerId} onChange={(event) => onChange({ ...draft, providerId: event.target.value })} className={SETTINGS_INPUT} />
          </SettingsField>
          <div className="grid grid-cols-2 gap-2">
            <SettingsField label="Temperature">
              <input type="number" step="0.1" min="0" max="2" value={draft.temperature} onChange={(event) => onChange({ ...draft, temperature: Number(event.target.value) || 0 })} className={SETTINGS_INPUT} />
            </SettingsField>
            <SettingsField label="Max Tokens">
              <input type="number" min="0" value={draft.maxOutputTokens} onChange={(event) => onChange({ ...draft, maxOutputTokens: Number(event.target.value) || 0 })} className={SETTINGS_INPUT} />
            </SettingsField>
          </div>
        </div>
        <SettingsField label="描述"><textarea value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} rows={2} className={`${SETTINGS_INPUT} resize-none`} /></SettingsField>
        <SettingsField label="系统提示词"><textarea value={draft.systemPrompt} onChange={(event) => onChange({ ...draft, systemPrompt: event.target.value })} rows={7} className={`${SETTINGS_INPUT} resize-y font-mono text-xs`} /></SettingsField>
        <SettingsField label="可调用 Skills">
          <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border border-white/[0.08] bg-white/[0.035] p-3">
            {skills.length === 0 ? <span className="text-xs text-neutral-500">暂无提示词型 Skill。</span> : null}
            {skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => toggleSkill(skill.id)}
                className={[
                  "rounded-full border px-3 py-1 text-xs transition",
                  draft.skillIds.includes(skill.id) ? "border-white/[0.18] bg-white/[0.10] text-white" : "border-white/[0.08] bg-white/[0.045] text-neutral-400 hover:border-white/[0.16] hover:text-neutral-100",
                ].join(" ")}
              >
                {getSkillCommandName(skill)}
              </button>
            ))}
          </div>
        </SettingsField>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" checked={draft.canvasTools} onChange={(event) => onChange({ ...draft, canvasTools: event.target.checked })} className="accent-neutral-300" />
            允许画布工具
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} className="accent-neutral-300" />
            启用
          </label>
          <SettingsField label="策略">
            <select value={draft.strategy} onChange={(event) => onChange({ ...draft, strategy: event.target.value as AgentUpsert["strategy"] })} className={SETTINGS_SELECT}>
              <option value="reactive">reactive</option>
              <option value="scripted">scripted</option>
            </select>
          </SettingsField>
        </div>
      </div>
      <ModalFooter saving={saving} onClose={onClose} onSave={onSave} />
    </CenterModal>
  );
}

function PromptEditorModal({
  editor,
  saving,
  previewOnly,
  onTogglePreview,
  onChange,
  onClose,
  onSave,
}: {
  editor: { skill: Skill | null; name: string; commandName: string; modelHint: string; content: string };
  saving: boolean;
  previewOnly: boolean;
  onTogglePreview: () => void;
  onChange: (editor: { skill: Skill | null; name: string; commandName: string; modelHint: string; content: string }) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);

  const runToolbarAction = (action: (typeof PROMPT_TOOLBAR)[number]["key"]) => {
    const textarea = textRef.current;
    if (!textarea) return;
    textarea.focus();
    if (action === "undo" || action === "redo") {
      document.execCommand(action === "undo" ? "undo" : "redo");
      return;
    }
    const next = applyPromptToolbar(editor.content, textarea.selectionStart, textarea.selectionEnd, action);
    onChange({ ...editor, content: next });
  };

  return (
    <CenterModal title="提示词" onClose={onClose} widthClass="max-w-[1320px]">
      <div className="grid gap-3 md:grid-cols-3">
        <SettingsField label="名称">
          <input value={editor.name} onChange={(event) => onChange({ ...editor, name: event.target.value })} className={EDITOR_INPUT} />
        </SettingsField>
        <SettingsField label="类型 / Slash 命令">
          <input value={editor.commandName} onChange={(event) => onChange({ ...editor, commandName: event.target.value })} className={EDITOR_INPUT} />
        </SettingsField>
        <SettingsField label="模型提示">
          <input value={editor.modelHint} onChange={(event) => onChange({ ...editor, modelHint: event.target.value })} className={EDITOR_INPUT} />
        </SettingsField>
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border border-[#303030] bg-[#161615] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
        <div className="flex items-center justify-between border-b border-[#2d2b28] bg-[#1b1a18] px-3 py-2">
          <div className="flex items-center gap-1">
            {PROMPT_TOOLBAR.map((item) => (
              <button
                key={item.key}
                type="button"
                title={item.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runToolbarAction(item.key)}
                className={EDITOR_TOOL_BUTTON}
              >
                {item.icon}
              </button>
            ))}
          </div>
          <button
            type="button"
            title="预览"
            onClick={onTogglePreview}
            className={[
              "grid h-8 w-8 place-items-center rounded-md transition",
              previewOnly ? "bg-[#2f2b23] text-[#f2eadf]" : "text-[#a8a19a] hover:bg-[#2a2926] hover:text-[#f2eadf]",
            ].join(" ")}
          >
            <Eye className="h-4 w-4" />
          </button>
        </div>
        <div className={previewOnly ? "grid grid-cols-1" : "grid grid-cols-1 lg:grid-cols-2"} style={{ height: "clamp(420px, 54vh, 570px)" }}>
          {!previewOnly ? (
            <textarea
              ref={textRef}
              value={editor.content}
              onChange={(event) => onChange({ ...editor, content: event.target.value })}
              spellCheck={false}
              className={EDITOR_TEXTAREA}
              placeholder="请输入 Markdown 提示词..."
            />
          ) : null}
          <div className={EDITOR_PREVIEW}>
            <MarkdownPreview content={editor.content} />
          </div>
        </div>
      </div>
      <ModalFooter saving={saving} onClose={onClose} onSave={onSave} />
    </CenterModal>
  );
}

function SkillSpecEditorModal({
  title,
  draft,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  title: string;
  draft: string;
  saving: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const runToolbarAction = (action: (typeof PROMPT_TOOLBAR)[number]["key"]) => {
    const textarea = textRef.current;
    if (!textarea) return;
    textarea.focus();
    if (action === "undo" || action === "redo") {
      document.execCommand(action === "undo" ? "undo" : "redo");
      return;
    }
    onChange(applyPromptToolbar(draft, textarea.selectionStart, textarea.selectionEnd, action));
  };

  return (
    <CenterModal title={title} onClose={onClose} widthClass="max-w-[1320px]">
      <div className="overflow-hidden rounded-xl border border-[#303030] bg-[#161615] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
        <div className="flex items-center gap-1 border-b border-[#2d2b28] bg-[#1b1a18] px-3 py-2">
          {PROMPT_TOOLBAR.map((item) => (
            <button
              key={item.key}
              type="button"
              title={item.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runToolbarAction(item.key)}
              className={EDITOR_TOOL_BUTTON}
            >
              {item.icon}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2" style={{ height: "clamp(440px, 58vh, 610px)" }}>
          <textarea
            ref={textRef}
            value={draft}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            className={EDITOR_TEXTAREA}
          />
          <div className={EDITOR_PREVIEW}>
            <MarkdownPreview content={draft} />
          </div>
        </div>
      </div>
      <ModalFooter saving={saving} onClose={onClose} onSave={onSave} />
    </CenterModal>
  );
}

function CenterModal({
  title,
  onClose,
  children,
  widthClass = "max-w-[640px]",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!overlayRef.current || !panelRef.current) return;
    const duration = prefersReducedMotion() ? 0 : 0.26;
    const ctx = gsap.context(() => {
      gsap.fromTo(overlayRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: duration * 0.7, ease: "power1.out" });
      gsap.fromTo(
        panelRef.current,
        { autoAlpha: 0, y: 14, scale: 0.975, filter: "blur(8px)" },
        { autoAlpha: 1, y: 0, scale: 1, filter: "blur(0px)", duration, ease: "power3.out" },
      );
    }, panelRef);
    return () => ctx.revert();
  }, []);

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[60] flex items-start justify-center bg-black/70 px-4 py-[5vh] backdrop-blur-sm">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="关闭弹窗" onClick={onClose} />
      <section ref={panelRef} className={`relative z-10 max-h-[90vh] w-full ${widthClass} overflow-hidden rounded-xl border border-[#303030] bg-[#171716] text-[#eee7dc] shadow-[0_30px_100px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.03)]`}>
        <div className="flex items-center justify-between border-b border-[#2d2b28] bg-[#181817] px-5 py-4">
          <h3 className="text-base font-semibold tracking-[-0.01em] text-[#f4ede3]">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-[#8d867d] transition hover:bg-[#2a2926] hover:text-[#f2eadf]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className={`max-h-[calc(90vh-58px)] overflow-y-auto px-5 py-4 ${EDITOR_SCROLLBAR}`}>
          {children}
        </div>
      </section>
    </div>
  );
}

function ModalFooter({ saving, onClose, onSave }: { saving: boolean; onClose: () => void; onSave: () => void }) {
  return (
    <div className="mt-5 flex justify-end gap-3 border-t border-[#2d2b28] pt-4">
      <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={onClose} disabled={saving}>取消</Button>
      <Button type="button" onClick={onSave} disabled={saving} className={SETTINGS_PRIMARY_BUTTON}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        保存
      </Button>
    </div>
  );
}

function MemoryNumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <SettingsField label={label}>
      <input value={value} onChange={(event) => onChange(Number(event.target.value) || 0)} type="number" min={0} className={SETTINGS_INPUT} />
    </SettingsField>
  );
}

function skillToUpsert(skill: Skill, overrides: Partial<SkillUpsert> = {}): SkillUpsert {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    icon: skill.icon,
    kind: skill.kind,
    spec: skill.spec ?? {},
    input_schema: skill.input_schema ?? {},
    output_schema: skill.output_schema ?? {},
    enabled: skill.enabled,
    ...overrides,
  };
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-36 rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}
