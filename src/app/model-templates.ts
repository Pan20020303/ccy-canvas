import type { ServiceType } from "./model-config";

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
  durationRange?: DurationRange;
  /** Fixed duration choices (e.g. [6, 10]). When present, takes priority over durationRange slider. */
  durationOptions?: number[];
  defaults?: {
    mode?: string;
    resolution?: string;
    quality?: string;
    aspectRatio?: string;
  };
};

export type ModelRequestParams = {
  model?: string;
  mode?: string;
  resolution?: string;
  quality?: string;
  aspectRatio?: string;
  durationSeconds?: number;
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
} satisfies Omit<ModelTemplate, "vendor" | "modelName">;

const SEEDANCE_10_PRO_TEMPLATE = {
  ...SEEDANCE_2_TEMPLATE,
  durationRange: { min: 2, max: 12, step: 1, defaultValue: 5 },
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
    qualityOptions: ["Auto", "High", "Medium", "Low"],
    aspectRatioOptions: [...DEFAULT_ASPECT_RATIO_OPTIONS],
    defaults: {
      quality: "Auto",
      aspectRatio: "1:1",
    },
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
};

export function getModelTemplate(modelName?: string | null): ModelTemplate | null {
  if (!modelName) {
    return null;
  }
  return modelTemplates[modelName] ?? null;
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
  };
}
