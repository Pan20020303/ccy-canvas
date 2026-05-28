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
  aspectRatioOptions?: string[];
  supportsMode?: boolean;
  supportsResolution?: boolean;
  supportsAspectRatio?: boolean;
  supportsAutoAspect?: boolean;
  supportsDuration?: boolean;
  durationRange?: DurationRange;
  defaults?: {
    mode?: string;
    resolution?: string;
    aspectRatio?: string;
  };
};

export type ModelRequestParams = {
  model?: string;
  mode?: string;
  resolution?: string;
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
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    resolutionOptions: ["1K", "2K", "4K"],
    aspectRatioOptions: [...DEFAULT_ASPECT_RATIO_OPTIONS],
    defaults: {
      resolution: "1K",
      aspectRatio: "1:1",
    },
  },
  "runway-gen3": {
    vendor: "Runway",
    serviceType: "video",
    modelName: "runway-gen3",
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
  },
  "suno-v4": {
    vendor: "Suno",
    serviceType: "audio",
    modelName: "suno-v4",
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
    aspect_ratio: template?.supportsAspectRatio ? params.aspectRatio : undefined,
    duration: template?.supportsDuration ? params.durationSeconds : undefined,
  };
}
