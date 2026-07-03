import type { ServiceType } from "./model-config";
import type { AppProviderConfig, ModelParameterSchema } from "./api/providerConfigs";
import type { ReferenceModeKey } from "./reference-modes";

export type DurationRange = {
  min: number;
  max: number;
  step: number;
  defaultValue: number;
};

export type ModelTemplate = {
  vendor: string;
  serviceType: ServiceType;
  modelName: string;
  modeOptions?: string[];
  resolutionOptions?: string[];
  qualityOptions?: string[];
  aspectRatioOptions?: string[];
  supportsMode?: boolean;
  supportsResolution?: boolean;
  supportsQuality?: boolean;
  supportsAspectRatio?: boolean;
  supportsAutoAspect?: boolean;
  supportsDuration?: boolean;
  supportsOutputFormat?: boolean;
  /** When set, exposes an audio-control selector (HappyHorse video-edit:
   *  ["auto","origin"] — auto lets the model decide, origin keeps source audio). */
  audioSettingOptions?: string[];
  /** When true, exposes a numeric seed input (0..2147483647) for reproducible runs. */
  supportsSeed?: boolean;
  durationRange?: DurationRange;
  /** Fixed duration choices (e.g. [6, 10]). When present, takes priority over durationRange slider. */
  durationOptions?: number[];
  outputFormatOptions?: string[];
  /** Video reference modes this model supports. Drives the tab strip in
   *  the prompt panel. Omitted → no reference tabs (pure text-to-video).
   *  See reference-modes.ts for the capability registry. */
  referenceModes?: ReferenceModeKey[];
  defaults?: {
    mode?: string;
    resolution?: string;
    quality?: string;
    aspectRatio?: string;
    outputFormat?: string;
  };
};

export type ModelRequestParams = {
  model?: string;
  mode?: string;
  resolution?: string;
  quality?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  outputFormat?: string;
};

export const DEFAULT_ASPECT_RATIO_OPTIONS = [
  "1:1",
  "9:16",
  "16:9",
  "3:4",
  "4:3",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
  "21:9",
  "2:1",
  "1:2",
  "9:21",
] as const;

const OPENAI_IMAGE_SIZE_OPTIONS = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;

// New API 文生图文档（2026-07，第 5 节「支持比例与分辨率」）：
// Gemini / Nano Banana 图像家族支持的画幅比例（各档一致）。
const GEMINI_IMAGE_ASPECT_OPTIONS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as const;
// gpt-image-2 渠道支持的画幅比例。
const GPT_IMAGE_2_ASPECT_OPTIONS = ["1:1", "5:4", "4:5", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"] as const;

function schemaArray<T>(schema: ModelParameterSchema | undefined, snake: keyof ModelParameterSchema, camel: keyof ModelParameterSchema): T[] | undefined {
  const value = schema?.[snake] ?? schema?.[camel];
  return Array.isArray(value) ? (value.filter((item) => item !== undefined && item !== null) as T[]) : undefined;
}

function schemaBool(schema: ModelParameterSchema | undefined, snake: keyof ModelParameterSchema, camel: keyof ModelParameterSchema): boolean | undefined {
  const value = schema?.[snake] ?? schema?.[camel];
  return typeof value === "boolean" ? value : undefined;
}

function schemaDefault(schema: ModelParameterSchema | undefined, key: string): string | undefined {
  const value = schema?.defaults?.[key];
  return typeof value === "string" ? value : undefined;
}

const DEFAULT_VIDEO_TEMPLATE = {
  serviceType: "video" as const,
  supportsMode: true,
  supportsResolution: true,
  supportsAspectRatio: true,
  supportsAutoAspect: true,
  supportsDuration: true,
  modeOptions: ["Standard", "Fast"],
  resolutionOptions: ["720p", "1080p"],
  aspectRatioOptions: ["1:1", "9:16", "16:9", "3:4", "4:3", "5:4", "4:5", "21:9"],
  durationRange: {
    min: 5,
    max: 15,
    step: 5,
    defaultValue: 5,
  },
  defaults: {
    mode: "Standard",
    resolution: "720p",
    aspectRatio: "1:1",
  },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

const SORA_V3_TEMPLATE = {
  serviceType: "video" as const,
  supportsResolution: true,
  supportsAspectRatio: true,
  supportsDuration: true,
  resolutionOptions: ["480p", "720p"],
  aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  durationRange: {
    min: 5,
    max: 15,
    step: 1,
    defaultValue: 5,
  },
  // Sora supports a first reference frame and full video edit/remix.
  referenceModes: ["first-last", "video-edit"] as ReferenceModeKey[],
  defaults: {
    resolution: "480p",
    aspectRatio: "16:9",
  },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

const SORA_2_TEMPLATE = {
  serviceType: "video" as const,
  supportsResolution: true,
  supportsAspectRatio: true,
  supportsDuration: true,
  resolutionOptions: ["720p"],
  aspectRatioOptions: ["16:9", "9:16"],
  durationRange: {
    min: 4,
    max: 12,
    step: 4,
    defaultValue: 8,
  },
  referenceModes: ["first-last", "video-edit"] as ReferenceModeKey[],
  defaults: {
    resolution: "720p",
    aspectRatio: "16:9",
  },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

// Volcengine ark seedance (video) — ratios/resolutions/duration come from the
// 火山引擎 model capabilities table.
const SEEDANCE_2_TEMPLATE = {
  serviceType: "video" as const,
  supportsResolution: true,
  supportsAspectRatio: true,
  supportsAutoAspect: true,
  supportsDuration: true,
  resolutionOptions: ["480p", "720p", "1080p"],
  aspectRatioOptions: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
  durationRange: { min: 4, max: 15, step: 1, defaultValue: 5 },
  // Seedance 2.0 is the most capable: first/last frame, 1–9 multi-image,
  // motion mimic, and mixed all-in-one references.
  referenceModes: ["first-last", "multi-image", "motion-mimic", "all-in-one"] as ReferenceModeKey[],
  defaults: { resolution: "720p", aspectRatio: "16:9" },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

const SEEDANCE_2_FAST_TEMPLATE = {
  ...SEEDANCE_2_TEMPLATE,
  resolutionOptions: ["480p", "720p"],
  defaults: { resolution: "480p", aspectRatio: "16:9" },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

const SEEDANCE_15_PRO_TEMPLATE = {
  ...SEEDANCE_2_TEMPLATE,
  durationRange: { min: 4, max: 12, step: 1, defaultValue: 5 },
  // Seedance 1.5 supports first/last frame + multi-image, no motion mimic.
  referenceModes: ["first-last", "multi-image"] as ReferenceModeKey[],
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

const SEEDANCE_10_PRO_TEMPLATE = {
  ...SEEDANCE_2_TEMPLATE,
  durationRange: { min: 2, max: 12, step: 1, defaultValue: 5 },
  // Seedance 1.0 first/last frame only.
  referenceModes: ["first-last"] as ReferenceModeKey[],
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

// Seedream (image) — the UI exposes ratios, then the backend maps them to
// Seedream-compatible WIDTHxHEIGHT / 2K / 3K / 4K values per model.
const SEEDREAM_TEMPLATE = {
  serviceType: "image" as const,
  supportsQuality: true,
  supportsAspectRatio: true,
  supportsAutoAspect: true,
  qualityOptions: ["Auto", "High", "Medium", "Low"],
  aspectRatioOptions: [...DEFAULT_ASPECT_RATIO_OPTIONS],
  defaults: { quality: "Auto", aspectRatio: "1:1" },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

export const modelTemplates: Record<string, ModelTemplate> = {
  "gpt-4.1-mini": {
    vendor: "OpenAI",
    serviceType: "text",
    modelName: "gpt-4.1-mini",
  },
  "gpt-image-2": {
    vendor: "OpenAI",
    serviceType: "image",
    modelName: "gpt-image-2",
    supportsQuality: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    supportsOutputFormat: true,
    qualityOptions: ["Auto", "High", "Medium", "Low"],
    // 文档只列比例档（不再暴露 1024x… 像素尺寸；自适应由 supportsAutoAspect 提供）。
    aspectRatioOptions: [...GPT_IMAGE_2_ASPECT_OPTIONS],
    outputFormatOptions: ["png", "jpeg", "webp"],
    defaults: {
      quality: "Auto",
      aspectRatio: "auto",
      outputFormat: "png",
    },
  },
  "gpt-image-1": {
    vendor: "OpenAI",
    serviceType: "image",
    modelName: "gpt-image-1",
    supportsQuality: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    supportsOutputFormat: true,
    qualityOptions: ["Auto", "High", "Medium", "Low"],
    aspectRatioOptions: [...OPENAI_IMAGE_SIZE_OPTIONS],
    outputFormatOptions: ["png", "jpeg", "webp"],
    defaults: { quality: "Auto", aspectRatio: "auto", outputFormat: "png" },
  },
  "dall-e-3": {
    vendor: "OpenAI",
    serviceType: "image",
    modelName: "dall-e-3",
    supportsQuality: true,
    supportsAspectRatio: true,
    qualityOptions: ["standard", "hd"],
    aspectRatioOptions: ["1024x1024", "1792x1024", "1024x1792"],
    defaults: { quality: "standard", aspectRatio: "1024x1024" },
  },
  "dall-e-2": {
    vendor: "OpenAI",
    serviceType: "image",
    modelName: "dall-e-2",
    supportsAspectRatio: true,
    aspectRatioOptions: ["256x256", "512x512", "1024x1024"],
    defaults: { aspectRatio: "1024x1024" },
  },
  // 万相2.7 (DashScope) — ONE model, param-driven modes: 文生图 / 图像编辑 /
  // 组图生成 (交互式编辑 bbox UI is Phase 2). The mode is picked via the
  // reference-mode tab strip (wan-t2i / wan-edit / wan-group). size maps to the
  // resolution 1K/2K/4K; watermark ships off in the backend.
  "wan2.7-image-pro": {
    vendor: "阿里云·通义",
    serviceType: "image",
    modelName: "wan2.7-image-pro",
    referenceModes: ["wan-t2i", "wan-edit", "wan-group"],
    supportsSeed: true,
    supportsResolution: true,
    resolutionOptions: ["1K", "2K", "4K"],
    defaults: { resolution: "2K" },
  },
  "wan2.7-image": {
    vendor: "阿里云·通义",
    serviceType: "image",
    modelName: "wan2.7-image",
    referenceModes: ["wan-t2i", "wan-edit", "wan-group"],
    supportsSeed: true,
    supportsResolution: true,
    resolutionOptions: ["1K", "2K"],
    defaults: { resolution: "2K" },
  },
  "runway-gen3": {
    vendor: "Runway",
    modelName: "runway-gen3",
    ...DEFAULT_VIDEO_TEMPLATE,
  },
  "sora-v3-fast": {
    vendor: "Niuma",
    modelName: "sora-v3-fast",
    ...SORA_V3_TEMPLATE,
  },
  "sora-v3-pro": {
    vendor: "Niuma",
    modelName: "sora-v3-pro",
    ...SORA_V3_TEMPLATE,
  },
  "sora-2": {
    vendor: "Niuma",
    modelName: "sora-2",
    ...SORA_2_TEMPLATE,
  },
  "suno-v4": {
    vendor: "Suno",
    serviceType: "audio",
    modelName: "suno-v4",
  },
  "doubao-seedance-2-0-260128": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-2-0-260128",
    ...SEEDANCE_2_TEMPLATE,
  },
  "doubao-seedance-2-0-fast-260128": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-2-0-fast-260128",
    ...SEEDANCE_2_FAST_TEMPLATE,
  },
  "doubao-seedance-1-5-pro-251215": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-1-5-pro-251215",
    ...SEEDANCE_15_PRO_TEMPLATE,
  },
  "doubao-seedance-1-0-pro-250528": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-1-0-pro-250528",
    ...SEEDANCE_10_PRO_TEMPLATE,
  },
  "doubao-seedance-1-0-pro-fast-251015": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-1-0-pro-fast-251015",
    ...SEEDANCE_10_PRO_TEMPLATE,
  },
  "doubao-seedance-1-0-lite-t2v-250428": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-1-0-lite-t2v-250428",
    ...SEEDANCE_10_PRO_TEMPLATE,
  },
  "doubao-seedance-1-0-lite-i2v-250428": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-1-0-lite-i2v-250428",
    ...SEEDANCE_10_PRO_TEMPLATE,
  },
  "doubao-seedream-5-0-260128": {
    vendor: "Volcengine",
    modelName: "doubao-seedream-5-0-260128",
    ...SEEDREAM_TEMPLATE,
  },
  "doubao-seedream-4-0-250828": {
    vendor: "Volcengine",
    modelName: "doubao-seedream-4-0-250828",
    ...SEEDREAM_TEMPLATE,
  },
  // ── Nano Pro（gemini-3.0-pro-image）高清图像家族 ─────────────────────────
  // 供应商把 2K/4K 拆成两个模型 id（"gemini-3.0-pro-image" 与 "… 4K"）。
  // 模型下拉只展示基础名（PromptPanel 折叠 " 4K" 变体），2K/4K 在参数面板的
  // 分辨率里选；后端 applyGeminiProImageResolution 按分辨率补 output_resolution
  // 并在 4K 时切换到 " 4K" 模型 id。
  "gemini-3.0-pro-image": {
    vendor: "Google",
    serviceType: "image",
    modelName: "gemini-3.0-pro-image",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    resolutionOptions: ["2k", "4k"],
    aspectRatioOptions: [...GEMINI_IMAGE_ASPECT_OPTIONS],
    defaults: { resolution: "2k", aspectRatio: "auto" },
  },
  "gemini-3.0-pro-image 4K": {
    vendor: "Google",
    serviceType: "image",
    modelName: "gemini-3.0-pro-image 4K",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    resolutionOptions: ["2k", "4k"],
    aspectRatioOptions: [...GEMINI_IMAGE_ASPECT_OPTIONS],
    defaults: { resolution: "4k", aspectRatio: "auto" },
  },
  // Gemini Flash / Nano Banana 家族 — 之前落在通用兜底模板上（给出全量比例表），
  // 文档明确它们只支持上面的 7 档比例，这里显式声明。
  "gemini-2.5-flash-image": {
    vendor: "Google",
    serviceType: "image",
    modelName: "gemini-2.5-flash-image",
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    aspectRatioOptions: [...GEMINI_IMAGE_ASPECT_OPTIONS],
    defaults: { aspectRatio: "auto" },
  },
  "Nano Banana 2": {
    vendor: "Google",
    serviceType: "image",
    modelName: "Nano Banana 2",
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    aspectRatioOptions: [...GEMINI_IMAGE_ASPECT_OPTIONS],
    defaults: { aspectRatio: "auto" },
  },
  "Nano Banana 2 4K": {
    vendor: "Google",
    serviceType: "image",
    modelName: "Nano Banana 2 4K",
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    aspectRatioOptions: [...GEMINI_IMAGE_ASPECT_OPTIONS],
    defaults: { aspectRatio: "auto" },
  },
  // ── 阿里云百炼 HappyHorse 快乐马（图/参/编/文 4 个 mode × 1.0 / 1.1 两个版本）
  // 文档：图生(i2v)、参考生(r2v)、视频编辑(video-edit)、文生(t2v)
  // 前端 UI 在 CustomNodes 里识别 happyhorse 家族，把模型 dropdown 拆成
  // 「版本 + 模式」两个选择器，提交时映射回这里的真实模型名。
  "happyhorse-1.1-t2v": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "happyhorse-1.1-t2v",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsDuration: true,
    supportsSeed: true,
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "1080P", aspectRatio: "16:9" },
  },
  "happyhorse-1.0-t2v": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "happyhorse-1.0-t2v",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsDuration: true,
    supportsSeed: true,
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "1080P", aspectRatio: "16:9" },
  },
  // 图生：仅首帧。不支持 ratio —— 输出宽高比自动跟随首帧图（DashScope 文档明确
  // i2v 不接受 ratio 参数）。故不声明 supportsAspectRatio / aspectRatioOptions，
  // 也不给 defaults.aspectRatio，避免向后端发出被禁的 aspect_ratio。
  "happyhorse-1.1-i2v": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "happyhorse-1.1-i2v",
    supportsResolution: true,
    supportsDuration: true,
    supportsSeed: true,
    resolutionOptions: ["720P", "1080P"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    referenceModes: ["first-frame"] as ReferenceModeKey[],
    defaults: { resolution: "1080P" },
  },
  "happyhorse-1.0-i2v": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "happyhorse-1.0-i2v",
    supportsResolution: true,
    supportsDuration: true,
    supportsSeed: true,
    resolutionOptions: ["720P", "1080P"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    referenceModes: ["first-frame"] as ReferenceModeKey[],
    defaults: { resolution: "1080P" },
  },
  // 参考生：多图（1～9 张）+ ratio
  "happyhorse-1.1-r2v": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "happyhorse-1.1-r2v",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsDuration: true,
    supportsSeed: true,
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    referenceModes: ["multi-image"] as ReferenceModeKey[],
    defaults: { resolution: "1080P", aspectRatio: "16:9" },
  },
  "happyhorse-1.0-r2v": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "happyhorse-1.0-r2v",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsDuration: true,
    supportsSeed: true,
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    referenceModes: ["multi-image"] as ReferenceModeKey[],
    defaults: { resolution: "1080P", aspectRatio: "16:9" },
  },
  // 视频编辑：只在 1.0；无 duration / ratio（输出时长跟随输入视频）。
  // 独有 audio_setting（自动 / 保留原声）。
  "happyhorse-1.0-video-edit": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "happyhorse-1.0-video-edit",
    supportsResolution: true,
    supportsSeed: true,
    audioSettingOptions: ["auto", "origin"],
    resolutionOptions: ["720P", "1080P"],
    referenceModes: ["video-edit"] as ReferenceModeKey[],
    defaults: { resolution: "1080P" },
  },
  // ── 可灵 Kling v3（阿里云百炼渠道，DashScope 异步）────────────────────────
  // 文档（2026-07 百炼可灵-视频生成）：单模型多能力 — 文生 / 首帧 / 首尾帧，
  // Omni 额外支持参考生（refer ≤7）与视频编辑（base ≤1 + refer ≤4）。
  // 分辨率档位映射 mode：1080P → pro（默认）、720P → std（后端换算，不发
  // resolution）；aspect_ratio 仅 16:9 / 9:16 / 1:1，图生场景跟随首帧（自适应）。
  // audio 是布尔（生成音效），复用 audioSetting 通道。首位是默认值 ——
  // 2026-07 反馈：默认要有声，所以 "on" 在前；分辨率按钮左 720P 右 1080P。
  "kling/kling-v3-video-generation": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "kling/kling-v3-video-generation",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    supportsDuration: true,
    audioSettingOptions: ["on", "off"],
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    referenceModes: ["text-to-video", "first-frame", "first-last"] as ReferenceModeKey[],
    defaults: { resolution: "1080P", aspectRatio: "16:9" },
  },
  "kling/kling-v3-omni-video-generation": {
    vendor: "Alibaba",
    serviceType: "video",
    modelName: "kling/kling-v3-omni-video-generation",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    supportsDuration: true,
    audioSettingOptions: ["on", "off"],
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    referenceModes: ["text-to-video", "first-frame", "first-last", "multi-image", "video-edit"] as ReferenceModeKey[],
    defaults: { resolution: "1080P", aspectRatio: "16:9" },
  },
};

function inferProviderTemplate(modelName: string, provider?: Pick<AppProviderConfig, "service_type" | "vendor" | "parameter_schema"> | null): ModelTemplate | null {
  if (!provider) {
    return null;
  }
  if (provider.service_type !== "image") {
    return null;
  }
  const lower = modelName.toLowerCase();
  if (lower.includes("gpt-image")) {
    return {
      vendor: provider.vendor,
      serviceType: "image",
      modelName,
      supportsQuality: true,
      supportsAspectRatio: true,
      supportsAutoAspect: true,
      supportsOutputFormat: true,
      qualityOptions: ["Auto", "High", "Medium", "Low"],
      aspectRatioOptions: [...OPENAI_IMAGE_SIZE_OPTIONS],
      outputFormatOptions: ["png", "jpeg", "webp"],
      defaults: { quality: "Auto", aspectRatio: "auto", outputFormat: "png" },
    };
  }
  return {
    vendor: provider.vendor,
    serviceType: "image",
    modelName,
    supportsQuality: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    qualityOptions: ["Auto", "High", "Medium", "Low"],
    aspectRatioOptions: [...DEFAULT_ASPECT_RATIO_OPTIONS],
    defaults: { quality: "Auto", aspectRatio: "auto" },
  };
}

function applyParameterSchema(template: ModelTemplate, schema?: ModelParameterSchema): ModelTemplate {
  schema = schema?.models?.[template.modelName] ?? schema;
  if (!schema || Object.keys(schema).length === 0) {
    return template;
  }
  const qualityOptions = schemaArray<string>(schema, "quality_options", "qualityOptions");
  const aspectRatioOptions = schemaArray<string>(schema, "size_options", "sizeOptions")
    ?? schemaArray<string>(schema, "aspect_ratio_options", "aspectRatioOptions");
  const resolutionOptions = schemaArray<string>(schema, "resolution_options", "resolutionOptions");
  const durationOptions = schemaArray<number>(schema, "duration_options", "durationOptions");
  const outputFormatOptions = schemaArray<string>(schema, "output_format_options", "outputFormatOptions");

  return {
    ...template,
    supportsQuality: schemaBool(schema, "supports_quality", "supportsQuality") ?? template.supportsQuality ?? Boolean(qualityOptions?.length),
    supportsAspectRatio: schemaBool(schema, "supports_aspect_ratio", "supportsAspectRatio") ?? template.supportsAspectRatio ?? Boolean(aspectRatioOptions?.length),
    supportsAutoAspect: schemaBool(schema, "supports_auto_aspect", "supportsAutoAspect") ?? template.supportsAutoAspect,
    supportsResolution: schemaBool(schema, "supports_resolution", "supportsResolution") ?? template.supportsResolution ?? Boolean(resolutionOptions?.length),
    supportsDuration: schemaBool(schema, "supports_duration", "supportsDuration") ?? template.supportsDuration ?? Boolean(durationOptions?.length),
    supportsOutputFormat: schemaBool(schema, "supports_output_format", "supportsOutputFormat") ?? template.supportsOutputFormat ?? Boolean(outputFormatOptions?.length),
    qualityOptions: qualityOptions ?? template.qualityOptions,
    aspectRatioOptions: aspectRatioOptions ?? template.aspectRatioOptions,
    resolutionOptions: resolutionOptions ?? template.resolutionOptions,
    durationOptions: durationOptions ?? template.durationOptions,
    outputFormatOptions: outputFormatOptions ?? template.outputFormatOptions,
    defaults: {
      ...template.defaults,
      quality: schemaDefault(schema, "quality") ?? template.defaults?.quality,
      aspectRatio: schemaDefault(schema, "size") ?? schemaDefault(schema, "aspect_ratio") ?? template.defaults?.aspectRatio,
      resolution: schemaDefault(schema, "resolution") ?? template.defaults?.resolution,
      outputFormat: schemaDefault(schema, "output_format") ?? template.defaults?.outputFormat,
    },
  };
}

export function getModelTemplate(
  modelName?: string | null,
  provider?: Pick<AppProviderConfig, "service_type" | "vendor" | "parameter_schema"> | null,
): ModelTemplate | null {
  if (!modelName) {
    return null;
  }
  const base = modelTemplates[modelName] ?? inferProviderTemplate(modelName, provider);
  if (!base) {
    return null;
  }
  return applyParameterSchema(base, provider?.parameter_schema);
}

export function getTemplatesForServiceType(serviceType: ServiceType): ModelTemplate[] {
  return Object.values(modelTemplates).filter((template) => template.serviceType === serviceType);
}

export function buildModelRequestBody(
  template: ModelTemplate | null,
  prompt: string,
  params: ModelRequestParams,
) {
  return {
    prompt,
    model: params.model,
    mode: template?.supportsMode ? params.mode : undefined,
    size: template?.supportsResolution ? params.resolution : undefined,
    quality: template?.supportsQuality ? params.quality : undefined,
    aspect_ratio: template?.supportsAspectRatio ? params.aspectRatio : undefined,
    duration: template?.supportsDuration ? params.durationSeconds : undefined,
    output_format: template?.supportsOutputFormat ? params.outputFormat : undefined,
  };
}
