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
  /** 文本模型是否支持视觉(读图)。true 时,文本节点会把连入的参考图作为 image_url
   *  一并发给模型(如百炼 qwen3.7-plus 多模态);false/未设 → 纯文本,连图会被忽略。 */
  supportsVision?: boolean;
  /** 模型上下文窗口上限(tokens)。驱动智能体面板的上下文用量计量表
   *  (如「602.7k / 1.0M (60%)」);未声明的模型不显示上限,只显示已用量。 */
  contextWindow?: number;
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
// 火山方舟官方通道的 Seedream 4.0/5.0:官方文档明确支持 1K/2K/4K 分辨率
// (size 传关键字由模型定宽高,或传精确像素)。之前只暴露 quality(Auto/High/
// Medium/Low),用户看不到 1K 档且分辨率是被 quality 间接决定的,故改为显式
// 分辨率档位 + 宽高比。1K 会以关键字下发(见后端 mapAspectRatioToVolcengineSize)。
const SEEDREAM_TEMPLATE = {
  serviceType: "image" as const,
  supportsResolution: true,
  supportsAspectRatio: true,
  supportsAutoAspect: true,
  resolutionOptions: ["1k", "2k", "4k"],
  aspectRatioOptions: [...DEFAULT_ASPECT_RATIO_OPTIONS],
  defaults: { resolution: "2k", aspectRatio: "1:1" },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

// apimart 中转站的 Gemini-3.1-Flash-Image (Nano banana2) — 与 GPT-Image-2 同端点
// (/v1/images/generations)：size=比例 + resolution 0.5k/1k/2k/4k + image_urls 图生图，
// 由 generateImageApimart(按 base_url 嗅探)处理。
const APIMART_NANO_BANANA_2_TEMPLATE = {
  serviceType: "image" as const,
  supportsResolution: true,
  supportsAspectRatio: true,
  supportsAutoAspect: true,
  resolutionOptions: ["0.5k", "1k", "2k", "4k"],
  aspectRatioOptions: [...GPT_IMAGE_2_ASPECT_OPTIONS],
  defaults: { resolution: "2k", aspectRatio: "auto" },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

// apimart 中转站其余生图模型(seedream/qwen/wan/z-image/imagen/grok/gpt-image-1.x/
// gemini-2.5·3-pro …)的通用参数模板。统一契约同上：POST /v1/images/generations，
// size=比例 + resolution 档位 + image_urls 图生图，由 generateImageApimart 处理。
// 分辨率档位 1k/2k/4k(0.5k 仅 gemini-3.1 支持，见 NANO_BANANA_2 模板)，默认 2k。
const APIMART_IMAGE_TEMPLATE = {
  serviceType: "image" as const,
  supportsResolution: true,
  supportsAspectRatio: true,
  supportsAutoAspect: true,
  resolutionOptions: ["1k", "2k", "4k"],
  aspectRatioOptions: [...GPT_IMAGE_2_ASPECT_OPTIONS],
  defaults: { resolution: "2k", aspectRatio: "auto" },
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

// apimart 中转站视频模型的公共底座:统一 POST /v1/videos/generations，支持
// 分辨率/比例/时长 + 首帧(image_urls)图生视频，由 generateVideoApimart 处理。
// 各模型的具体档位/时长/比例在各自条目里按 apimart 文档覆盖。seedance 系不在此
// 声明——它们被 inferSeedanceTemplate 兜底成更完整的火山即梦视频模板。
const APIMART_VIDEO_BASE = {
  serviceType: "video" as const,
  supportsResolution: true,
  supportsAspectRatio: true,
  supportsDuration: true,
  referenceModes: ["text-to-video", "first-frame"] as ReferenceModeKey[],
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

export const modelTemplates: Record<string, ModelTemplate> = {
  "gpt-4.1-mini": {
    vendor: "OpenAI",
    serviceType: "text",
    modelName: "gpt-4.1-mini",
  },
  // 阿里云百炼 Qwen3.7 旗舰文本(混合思考模型)。走 DashScope 兼容端点
  // /compatible-mode/v1 的标准 chat/completions；后端对 qwen3.7-* 默认关思考
  // (enable_thinking=false)以适配同步/流式文本节点(仅取最终 content)。
  "qwen3.7-max": {
    vendor: "Alibaba",
    serviceType: "text",
    modelName: "qwen3.7-max",
    // Max 现阶段纯文本(官方文档:后续开放多模态),故不标 vision。
    contextWindow: 1_000_000, // 官方:1M tokens 上下文
  },
  "qwen3.7-plus": {
    vendor: "Alibaba",
    serviceType: "text",
    modelName: "qwen3.7-plus",
    // Plus 原生多模态(文档:支持 image_url 图片输入、OpenAI 兼容)。标 vision 后,
    // 文本节点会把连入的参考图一并发给模型 —— 支撑「连图 → 反推提示词」等图文推理。
    supportsVision: true,
    contextWindow: 1_000_000, // 官方:1M tokens 上下文
  },
  "gpt-image-2": {
    vendor: "OpenAI",
    serviceType: "image",
    modelName: "gpt-image-2",
    supportsQuality: true,
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    supportsOutputFormat: true,
    qualityOptions: ["Auto", "High", "Medium", "Low"],
    // apimart/Manju 中转站的 GPT-Image-2 走 size=比例 + resolution 档位；后端
    // generateImageApimart 透传 resolution(1k/2k/4k)。OpenAI 官方渠道忽略它。
    resolutionOptions: ["1k", "2k", "4k"],
    // 文档只列比例档（不再暴露 1024x… 像素尺寸；自适应由 supportsAutoAspect 提供）。
    aspectRatioOptions: [...GPT_IMAGE_2_ASPECT_OPTIONS],
    outputFormatOptions: ["png", "jpeg", "webp"],
    defaults: {
      quality: "Auto",
      resolution: "2k",
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
  // ── apimart 中转站视频全家桶(docs.apimart.ai)。model id 照抄文档，全部走
  //    POST /v1/videos/generations(generateVideoApimart 按 base_url 嗅探)。
  //    sora-2 已在上文声明；doubao-seedance-* 由 inferSeedanceTemplate 兜底。
  "sora-2-pro": {
    vendor: "OpenAI",
    modelName: "sora-2-pro",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720p", "1024p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16"],
    durationOptions: [4, 8, 12, 16, 20],
    referenceModes: ["text-to-video", "first-frame", "video-edit"],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "veo3.1-fast": {
    vendor: "Google",
    modelName: "veo3.1-fast",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720p", "1080p", "4k"],
    aspectRatioOptions: ["16:9", "9:16"],
    durationOptions: [8],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "veo3.1-quality": {
    vendor: "Google",
    modelName: "veo3.1-quality",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720p", "1080p", "4k"],
    aspectRatioOptions: ["16:9", "9:16"],
    durationOptions: [8],
    defaults: { resolution: "1080p", aspectRatio: "16:9" },
  },
  "veo3.1-lite": {
    vendor: "Google",
    modelName: "veo3.1-lite",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720p", "1080p", "4k"],
    aspectRatioOptions: ["16:9", "9:16"],
    durationOptions: [8],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "kling-v3": {
    vendor: "Kling",
    modelName: "kling-v3",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720P", "1080P", "4K"],
    aspectRatioOptions: ["16:9", "9:16", "1:1"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    referenceModes: ["text-to-video", "first-frame", "first-last"],
    defaults: { resolution: "1080P", aspectRatio: "16:9" },
  },
  "kling-v3-omni": {
    vendor: "Kling",
    modelName: "kling-v3-omni",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["std", "pro", "4k"],
    aspectRatioOptions: ["16:9", "9:16", "1:1"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    referenceModes: ["text-to-video", "first-frame", "multi-image"],
    defaults: { resolution: "pro", aspectRatio: "16:9" },
  },
  "kling-v2-6": {
    vendor: "Kling",
    modelName: "kling-v2-6",
    ...APIMART_VIDEO_BASE,
    supportsResolution: false,
    aspectRatioOptions: ["16:9", "9:16", "1:1"],
    durationOptions: [5, 10],
    referenceModes: ["text-to-video", "first-frame", "first-last"],
    defaults: { aspectRatio: "16:9" },
  },
  "kling-3.0-turbo": {
    vendor: "Kling",
    modelName: "kling-3.0-turbo",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16", "1:1"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "kling-video-o1": {
    vendor: "Kling",
    modelName: "kling-video-o1",
    ...APIMART_VIDEO_BASE,
    supportsResolution: false,
    aspectRatioOptions: ["16:9", "9:16", "1:1"],
    durationOptions: [5, 10],
    defaults: { aspectRatio: "16:9" },
  },
  "MiniMax-Hailuo-2.3": {
    vendor: "MiniMax",
    modelName: "MiniMax-Hailuo-2.3",
    ...APIMART_VIDEO_BASE,
    supportsAspectRatio: false,
    resolutionOptions: ["768p", "1080p"],
    durationOptions: [6, 10],
    defaults: { resolution: "768p" },
  },
  "MiniMax-Hailuo-2.3-Fast": {
    vendor: "MiniMax",
    modelName: "MiniMax-Hailuo-2.3-Fast",
    ...APIMART_VIDEO_BASE,
    supportsAspectRatio: false,
    resolutionOptions: ["768p", "1080p"],
    durationOptions: [6, 10],
    defaults: { resolution: "768p" },
  },
  "MiniMax-Hailuo-02": {
    vendor: "MiniMax",
    modelName: "MiniMax-Hailuo-02",
    ...APIMART_VIDEO_BASE,
    supportsAspectRatio: false,
    resolutionOptions: ["512p", "768p", "1080p"],
    durationOptions: [5, 10],
    defaults: { resolution: "768p" },
  },
  "wan2.7": {
    vendor: "Alibaba",
    modelName: "wan2.7",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationRange: { min: 2, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "720P", aspectRatio: "16:9" },
  },
  "wan2.7-r2v": {
    vendor: "Alibaba",
    modelName: "wan2.7-r2v",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationOptions: [2, 5, 10, 15],
    referenceModes: ["first-frame", "multi-image"],
    defaults: { resolution: "720P", aspectRatio: "16:9" },
  },
  "wan2.6": {
    vendor: "Alibaba",
    modelName: "wan2.6",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationOptions: [5, 10, 15],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "wan2.5-preview": {
    vendor: "Alibaba",
    modelName: "wan2.5-preview",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["480p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationOptions: [5, 10],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "viduq3": {
    vendor: "Vidu",
    modelName: "viduq3",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["540p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16", "4:3", "3:4", "1:1"],
    durationRange: { min: 1, max: 16, step: 1, defaultValue: 5 },
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "viduq3-mix": {
    vendor: "Vidu",
    modelName: "viduq3-mix",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["540p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16", "4:3", "3:4", "1:1"],
    durationRange: { min: 1, max: 16, step: 1, defaultValue: 5 },
    referenceModes: ["text-to-video", "first-frame", "multi-image"],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "viduq3-pro": {
    vendor: "Vidu",
    modelName: "viduq3-pro",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["540p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16", "4:3", "3:4", "1:1"],
    durationRange: { min: 1, max: 16, step: 1, defaultValue: 5 },
    defaults: { resolution: "1080p", aspectRatio: "16:9" },
  },
  "viduq3-turbo": {
    vendor: "Vidu",
    modelName: "viduq3-turbo",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["540p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "9:16", "4:3", "3:4", "1:1"],
    durationRange: { min: 1, max: 16, step: 1, defaultValue: 5 },
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "pixverse-v6": {
    vendor: "PixVerse",
    modelName: "pixverse-v6",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["360p", "540p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"],
    durationRange: { min: 1, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "grok-imagine-1.5-video-apimart": {
    vendor: "xAI",
    modelName: "grok-imagine-1.5-video-apimart",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["480p", "720p"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "3:2", "2:3"],
    durationOptions: [6, 30],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "gemini-omni-flash-preview": {
    vendor: "Google",
    modelName: "gemini-omni-flash-preview",
    ...APIMART_VIDEO_BASE,
    supportsDuration: false,
    resolutionOptions: ["720p"],
    aspectRatioOptions: ["16:9", "9:16"],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "Omni-Flash-Ext": {
    vendor: "apimart",
    modelName: "Omni-Flash-Ext",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720p", "1080p", "4k"],
    aspectRatioOptions: ["16:9", "9:16"],
    durationOptions: [4, 6, 8, 10],
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "skyreels-v4-fast": {
    vendor: "SkyReels",
    modelName: "skyreels-v4-fast",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["480p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "4:3", "1:1", "9:16", "3:4"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "skyreels-v4-std": {
    vendor: "SkyReels",
    modelName: "skyreels-v4-std",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["480p", "720p", "1080p"],
    aspectRatioOptions: ["16:9", "4:3", "1:1", "9:16", "3:4"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "720p", aspectRatio: "16:9" },
  },
  "happyhorse-1.0": {
    vendor: "Alibaba",
    modelName: "happyhorse-1.0",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "720P", aspectRatio: "16:9" },
  },
  "happyhorse-1.1": {
    vendor: "Alibaba",
    modelName: "happyhorse-1.1",
    ...APIMART_VIDEO_BASE,
    resolutionOptions: ["720P", "1080P"],
    aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    durationRange: { min: 3, max: 15, step: 1, defaultValue: 5 },
    defaults: { resolution: "720P", aspectRatio: "16:9" },
  },
  // ── Manju 中转站(manjuapi.com)chat/completions 视频三家 ─────────────────
  // 模型名与中转站完全一致(sora2 无连字符、Veo 带空格),后端按名嗅探路由到
  // generateVideoChatCompletions。均为单参考图(首帧)图生视频。
  "sora2": {
    vendor: "Manju",
    modelName: "sora2",
    serviceType: "video",
    supportsAspectRatio: true,
    supportsDuration: true,
    aspectRatioOptions: ["16:9", "9:16"],
    durationOptions: [4, 8, 12],
    referenceModes: ["text-to-video", "first-frame"],
    defaults: { aspectRatio: "16:9" },
    durationRange: { min: 4, max: 12, step: 4, defaultValue: 8 },
  },
  "Veo 3.1 Fast 1080p": {
    vendor: "Manju",
    modelName: "Veo 3.1 Fast 1080p",
    serviceType: "video",
    supportsAspectRatio: true,
    supportsDuration: true,
    aspectRatioOptions: ["16:9", "9:16"],
    durationOptions: [4, 6, 8],
    referenceModes: ["text-to-video", "first-frame"],
    defaults: { aspectRatio: "16:9" },
    durationRange: { min: 4, max: 8, step: 2, defaultValue: 8 },
  },
  "grok-imagine-video": {
    vendor: "Manju",
    modelName: "grok-imagine-video",
    serviceType: "video",
    supportsAspectRatio: true,
    supportsDuration: true,
    aspectRatioOptions: ["16:9", "9:16"],
    durationOptions: [6, 10, 15],
    referenceModes: ["text-to-video", "first-frame"],
    defaults: { aspectRatio: "16:9" },
    durationRange: { min: 6, max: 15, step: 1, defaultValue: 6 },
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
  // NoToken(notoken.pro)中转站的 Seedance 2.0 —— 模型 id 用点号 `seedance-2.0`,
  // 走 Ark 任务式接口(/api/v3/contents/generations/tasks),能力与官方 2.0 一致。
  "seedance-2.0": {
    vendor: "Volcengine",
    modelName: "seedance-2.0",
    ...SEEDANCE_2_TEMPLATE,
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
  // apimart 中转站的 Gemini-3.1-Flash-Image (Nano banana2)。apimart 用 preview 名，
  // 兼容别名 nano-banana-2；均走 /v1/images/generations(generateImageApimart)。
  "gemini-3.1-flash-image-preview": {
    vendor: "Google",
    modelName: "gemini-3.1-flash-image-preview",
    ...APIMART_NANO_BANANA_2_TEMPLATE,
  },
  "gemini-3.1-flash-image": {
    vendor: "Google",
    modelName: "gemini-3.1-flash-image",
    ...APIMART_NANO_BANANA_2_TEMPLATE,
  },
  "nano-banana-2": {
    vendor: "Google",
    modelName: "nano-banana-2",
    ...APIMART_NANO_BANANA_2_TEMPLATE,
  },
  // ── apimart 中转站生图全家桶(docs.apimart.ai)。model id 照抄文档请求体 model 字段，
  //    全部走 POST /v1/images/generations(generateImageApimart 按 base_url 嗅探)。
  //    gpt-image-2 / gemini-3.1-flash-image-preview 已在上文单独声明(带 quality/0.5k 档)。
  "gpt-image-1.5-official": {
    vendor: "OpenAI",
    modelName: "gpt-image-1.5-official",
    ...APIMART_IMAGE_TEMPLATE,
  },
  "gpt-image-1-official": {
    vendor: "OpenAI",
    modelName: "gpt-image-1-official",
    ...APIMART_IMAGE_TEMPLATE,
  },
  "gemini-3-pro-image-preview": {
    vendor: "Google",
    modelName: "gemini-3-pro-image-preview",
    ...APIMART_IMAGE_TEMPLATE,
  },
  "gemini-2.5-flash-image-preview": {
    vendor: "Google",
    modelName: "gemini-2.5-flash-image-preview",
    ...APIMART_IMAGE_TEMPLATE,
  },
  "imagen-4.0-apimart": {
    vendor: "Google",
    modelName: "imagen-4.0-apimart",
    ...APIMART_IMAGE_TEMPLATE,
  },
  "grok-imagine-1.5-apimart": {
    vendor: "xAI",
    modelName: "grok-imagine-1.5-apimart",
    ...APIMART_IMAGE_TEMPLATE,
  },
  "qwen-image-2.0": {
    vendor: "Alibaba",
    modelName: "qwen-image-2.0",
    ...APIMART_IMAGE_TEMPLATE,
  },
  // apimart 文档中 seedream-4.5 / 4.0 的 model 字段实为 doubao-seedance-4-x(照抄)，
  // seedream-5.0-lite 为 doubao-seedream-5-0-lite。
  "doubao-seedance-4-5": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-4-5",
    ...APIMART_IMAGE_TEMPLATE,
  },
  "doubao-seedance-4-0": {
    vendor: "Volcengine",
    modelName: "doubao-seedance-4-0",
    ...APIMART_IMAGE_TEMPLATE,
  },
  "doubao-seedream-5-0-lite": {
    vendor: "Volcengine",
    modelName: "doubao-seedream-5-0-lite",
    ...APIMART_IMAGE_TEMPLATE,
  },
  // wan2.7-image-pro 已在上文单独声明(带 wan 参考模式/seed/1K·2K·4K),此处不重复。
  "z-image-turbo": {
    vendor: "apimart",
    modelName: "z-image-turbo",
    ...APIMART_IMAGE_TEMPLATE,
  },
  // apimart Midjourney:走 /midjourney/generations，MJ 参数用 --ar(由比例映射)。
  // 无 apimart 分辨率档位；需显式比例(不给自适应)，默认 1:1。
  "midjourney": {
    vendor: "Midjourney",
    modelName: "midjourney",
    serviceType: "image",
    supportsAspectRatio: true,
    aspectRatioOptions: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
    defaults: { aspectRatio: "1:1" },
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

// 按 model id 模式识别 Seedance 家族。中转站/自定义配置里模型 id 五花八门
// (doubao-seedance-2.0 / -mini / -fast、seedance-2.0、doubao-seedance-2-0-260128
// …… 点号或连字符都有),精确表里没有时会退化成默认模板,而默认视频模板没有
// referenceModes → modesForModel 只给一个「多图参考」。这里按版本兜底成对应的
// Seedance 视频模板,把首尾帧/多图/动作模仿/全能参考等模式补回来。
function inferSeedanceTemplate(
  modelName: string,
  provider?: Pick<AppProviderConfig, "vendor"> | null,
): ModelTemplate | null {
  const m = modelName.toLowerCase();
  if (!m.includes("seedance")) return null;
  const vendor = provider?.vendor ?? "Volcengine";
  const v = m.replace(/\./g, "-"); // 归一化点号→连字符,便于版本判断
  const fast = v.includes("fast");
  if (v.includes("seedance-2")) {
    return { vendor, modelName, ...(fast ? SEEDANCE_2_FAST_TEMPLATE : SEEDANCE_2_TEMPLATE) };
  }
  if (v.includes("seedance-1-5")) {
    return { vendor, modelName, ...SEEDANCE_15_PRO_TEMPLATE };
  }
  if (v.includes("seedance-1")) {
    return { vendor, modelName, ...SEEDANCE_10_PRO_TEMPLATE };
  }
  return null;
}

export function getModelTemplate(
  modelName?: string | null,
  provider?: Pick<AppProviderConfig, "service_type" | "vendor" | "parameter_schema"> | null,
): ModelTemplate | null {
  if (!modelName) {
    return null;
  }
  const base = modelTemplates[modelName]
    ?? inferSeedanceTemplate(modelName, provider)
    ?? inferProviderTemplate(modelName, provider);
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
