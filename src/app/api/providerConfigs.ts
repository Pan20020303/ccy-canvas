import { apiClient } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceType = "text" | "image" | "video" | "audio";

/** Admin view — encrypted API key never returned, only hint. */
export type ProviderConfig = {
  id: string;
  service_type: ServiceType;
  vendor: string;
  name: string;
  api_spec: string;
  base_url: string;
  api_key_set: boolean;
  api_key_hint: string;
  submit_endpoint: string;
  query_endpoint: string;
  model_list: string[];
  default_model: string;
  priority: number;
  is_default: boolean;
  status: "enabled" | "disabled";
  created_at: string;
  updated_at: string;
};

/** User app view — minimal info. */
export type AppProviderConfig = {
  id: string;
  service_type: ServiceType;
  vendor: string;
  name: string;
  model_list: string[];
  default_model: string;
  priority: number;
};

/** Create/Update payload. */
export type ProviderConfigPayload = {
  service_type: ServiceType;
  vendor: string;
  name: string;
  api_spec?: string;
  base_url: string;
  api_key?: string;
  submit_endpoint?: string;
  query_endpoint?: string;
  model_list?: string[];
  default_model?: string;
  priority?: number;
  is_default?: boolean;
  status?: "enabled" | "disabled";
};

// ---------------------------------------------------------------------------
// Vendor templates (frontend constants)
// ---------------------------------------------------------------------------

export type VendorTemplate = {
  vendor: string;
  label: string;
  baseURL: string;
  apiSpec: "openai" | "custom";
  models: string[];
  submitEndpoint?: string;
  queryEndpoint?: string;
};

export const VENDOR_TEMPLATES: Record<ServiceType, VendorTemplate[]> = {
  text: [
    { vendor: "OpenAI", label: "OpenAI GPT", baseURL: "https://api.openai.com/v1", apiSpec: "openai", models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"] },
    { vendor: "Anthropic", label: "Anthropic Claude", baseURL: "https://api.anthropic.com", apiSpec: "custom", models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"] },
    { vendor: "DeepSeek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", apiSpec: "openai", models: ["deepseek-chat", "deepseek-reasoner"] },
  ],
  image: [
    { vendor: "OpenAI", label: "DALL·E", baseURL: "https://api.openai.com/v1", apiSpec: "openai", models: ["dall-e-3", "dall-e-2"] },
    { vendor: "Stability", label: "Stability AI", baseURL: "https://api.stability.ai/v2beta", apiSpec: "custom", models: ["sd3-large", "sd3-medium", "stable-image-ultra"] },
  ],
  video: [
    { vendor: "Niuma", label: "Niuma (Sora)", baseURL: "https://niuma.me/v1", apiSpec: "custom", models: ["sora-v3-pro", "sora-v3-fast", "sora-2"], submitEndpoint: "/v1/videos", queryEndpoint: "/v1/videos/{taskId}" },
  ],
  audio: [
    { vendor: "OpenAI", label: "OpenAI TTS/Whisper", baseURL: "https://api.openai.com/v1", apiSpec: "openai", models: ["tts-1", "tts-1-hd", "whisper-1"] },
  ],
};

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

export function listProviderConfigs(): Promise<ProviderConfig[]> {
  return apiClient.get<ProviderConfig[]>("/api/admin/provider-configs");
}

export function createProviderConfig(payload: ProviderConfigPayload): Promise<ProviderConfig> {
  return apiClient.post<ProviderConfig>("/api/admin/provider-configs", payload);
}

export function updateProviderConfig(id: string, payload: ProviderConfigPayload): Promise<ProviderConfig> {
  return apiClient.put<ProviderConfig>(`/api/admin/provider-configs/${id}`, payload);
}

export function deleteProviderConfig(id: string): Promise<void> {
  return apiClient.delete(`/api/admin/provider-configs/${id}`);
}

export function toggleProviderConfigStatus(id: string): Promise<ProviderConfig> {
  return apiClient.post<ProviderConfig>(`/api/admin/provider-configs/${id}/toggle`);
}

// ---------------------------------------------------------------------------
// User App API
// ---------------------------------------------------------------------------

export function listAppProviderConfigs(): Promise<AppProviderConfig[]> {
  return apiClient.get<AppProviderConfig[]>("/api/app/provider-configs");
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type GeneratePayload = {
  service_type: string;
  model: string;
  prompt: string;
  size?: string;         // image ratio: "1:1", "16:9", "auto"
  resolution?: string;   // image: "1k"/"2k"/"4k", video: "480p"/"720p"
  duration?: number;     // video duration in seconds
  aspect_ratio?: string; // video aspect ratio: "16:9", "9:16", etc.
  reference_images?: string[];
  reference_mode?: string;
  reference_video?: string;
  reference_videos?: string[];
};

export type GenerateResult = {
  type: "text" | "url";
  content: string;
};

export function generate(payload: GeneratePayload, signal?: AbortSignal): Promise<GenerateResult> {
  return apiClient.post<GenerateResult>("/api/app/generate", payload, signal);
}
