import { apiClient } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceType = "text" | "image" | "video" | "audio";
export type AdapterProfileID = "openai" | "ark" | "custom";

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
  /** Channel-health snapshot (migration 011). Backend populates these so
   *  admins can see at a glance which channels are sick. */
  failure_count: number;
  last_failure_at?: string;
  last_error_msg?: string;
  last_success_at?: string;
  cooldown_until?: string;
  consecutive_cooldowns: number;
};

/** Result of POST /api/admin/provider-configs/:id/test */
export type ChannelTestResult = {
  ok: boolean;
  http_status: number;
  latency_ms: number;
  error_msg?: string;
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
  apiSpec: AdapterProfileID;
  models: string[];
  submitEndpoint?: string;
  queryEndpoint?: string;
};

export function supportsCustomSubmitQueryEndpoints(apiSpec: string): boolean {
  return apiSpec === "custom";
}

export function getEndpointPreview(
  serviceType: ServiceType,
  apiSpec: string,
  submitEndpoint = "",
  queryEndpoint = "",
  baseURL = "",
): string {
  const profile =
    apiSpec === "ark" ? "ark" : apiSpec === "custom" ? "custom" : "openai";
  const customSubmit = submitEndpoint.trim();
  const customQuery = queryEndpoint.trim();
  const isRelayBases = baseURL.toLowerCase().includes("relaybases");

  if (serviceType === "image") {
    const gen =
      profile === "custom" && customSubmit
        ? customSubmit
        : isRelayBases
          ? "/v1/images/generations"
          : "/images/generations";
    let edit =
      profile === "ark"
        ? "/images/generations"
        : isRelayBases
          ? "/v1/images/edits"
          : "/images/edits";
    if (profile === "custom" && customSubmit) {
      const lower = customSubmit.toLowerCase();
      const trimmed = customSubmit.replace(/\/+$/, "");
      if (lower.includes("edit")) {
        edit = customSubmit;
      } else if (trimmed.toLowerCase().endsWith("/generations")) {
        edit = `${trimmed.slice(0, -"/generations".length)}/edits`;
      }
    }
    return `生成 ${gen} · 编辑 ${edit}`;
  }

  if (serviceType === "video") {
    const submit =
      profile === "custom" && customSubmit
        ? customSubmit
        : profile === "ark"
          ? "/contents/generations/tasks"
          : "/videos";
    const query =
      profile === "custom" && customQuery
        ? customQuery
        : profile === "ark"
          ? "/contents/generations/tasks/{taskId}"
          : "/videos/{taskId}";
    return `提交 ${submit} · 查询 ${query}`;
  }

  const textSubmit =
    profile === "custom" && customSubmit ? customSubmit : "/chat/completions";
  return `提交 ${textSubmit}`;
}

export const VENDOR_TEMPLATES: Record<ServiceType, VendorTemplate[]> = {
  text: [
    // 国际
    {
      vendor: "OpenAI",
      label: "OpenAI GPT",
      baseURL: "https://api.openai.com/v1",
      apiSpec: "openai",
      models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1-preview", "o1-mini"],
    },
    {
      vendor: "Anthropic",
      label: "Anthropic Claude",
      baseURL: "https://api.anthropic.com",
      apiSpec: "custom",
      models: [
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
      ],
    },
    {
      vendor: "Google",
      label: "Google Gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiSpec: "custom",
      models: ["gemini-2.0-flash-exp", "gemini-1.5-pro", "gemini-1.5-flash"],
    },
    {
      vendor: "xAI",
      label: "xAI Grok",
      baseURL: "https://api.x.ai/v1",
      apiSpec: "openai",
      models: ["grok-2-1212", "grok-2-vision-1212"],
    },
    {
      vendor: "DeepSeek",
      label: "DeepSeek",
      baseURL: "https://api.deepseek.com/v1",
      apiSpec: "openai",
      models: ["deepseek-chat", "deepseek-reasoner"],
    },
    // 国内
    {
      vendor: "Volcengine",
      label: "火山引擎 · 豆包 Doubao",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiSpec: "ark",
      models: [
        "doubao-1-5-pro-32k",
        "doubao-1-5-pro-256k",
        "doubao-1-5-lite-32k",
        "doubao-vision-pro-32k",
      ],
    },
    {
      vendor: "Alibaba",
      label: "阿里云 · 通义千问 Qwen",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiSpec: "openai",
      models: [
        "qwen-max",
        "qwen-plus",
        "qwen-turbo",
        "qwen-vl-max",
        "qwen-vl-plus",
      ],
    },
    {
      vendor: "Baidu",
      label: "百度 · 文心 ERNIE",
      baseURL: "https://qianfan.baidubce.com/v2",
      apiSpec: "openai",
      models: ["ernie-4.0-turbo-8k", "ernie-3.5-8k", "ernie-speed-128k"],
    },
    {
      vendor: "Zhipu",
      label: "智谱 · GLM-4",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiSpec: "openai",
      models: ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4v-plus"],
    },
    {
      vendor: "Tencent",
      label: "腾讯 · 混元 Hunyuan",
      baseURL: "https://api.hunyuan.cloud.tencent.com/v1",
      apiSpec: "openai",
      models: [
        "hunyuan-turbo",
        "hunyuan-pro",
        "hunyuan-standard",
        "hunyuan-vision",
      ],
    },
    {
      vendor: "Moonshot",
      label: "Moonshot · Kimi",
      baseURL: "https://api.moonshot.cn/v1",
      apiSpec: "openai",
      models: ["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
    },
    {
      vendor: "MiniMax",
      label: "MiniMax · abab",
      baseURL: "https://api.minimax.chat/v1",
      apiSpec: "openai",
      models: ["abab6.5s-chat", "abab6.5-chat", "MiniMax-Text-01"],
    },
    {
      vendor: "StepFun",
      label: "阶跃 · Step",
      baseURL: "https://api.stepfun.com/v1",
      apiSpec: "openai",
      models: ["step-2-16k", "step-1-256k", "step-1-flash"],
    },
  ],
  image: [
    // 中转 / Relay
    {
      vendor: "RelayBases",
      label: "RelayBases · gpt-image-2",
      baseURL: "https://image-2.relaybases.com",
      apiSpec: "openai",
      models: ["gpt-image-2"],
    },
    // 国际
    {
      vendor: "OpenAI",
      label: "OpenAI DALL·E / gpt-image",
      baseURL: "https://api.openai.com/v1",
      apiSpec: "openai",
      models: ["dall-e-3", "dall-e-2", "gpt-image-1"],
    },
    {
      vendor: "Stability",
      label: "Stability AI",
      baseURL: "https://api.stability.ai/v2beta",
      apiSpec: "custom",
      models: [
        "sd3-large",
        "sd3-medium",
        "stable-image-ultra",
        "stable-image-core",
      ],
    },
    {
      vendor: "Google",
      label: "Google Imagen",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiSpec: "custom",
      models: ["imagen-3.0-generate-002", "imagen-3.0-fast-generate-001"],
    },
    {
      vendor: "BFL",
      label: "Black Forest Labs FLUX",
      baseURL: "https://api.bfl.ml/v1",
      apiSpec: "custom",
      models: ["flux-pro-1.1", "flux-pro", "flux-dev", "flux-schnell"],
    },
    {
      vendor: "Recraft",
      label: "Recraft",
      baseURL: "https://external.api.recraft.ai/v1",
      apiSpec: "openai",
      models: ["recraft-v3", "recraft-v3-svg", "recraftv2"],
    },
    {
      vendor: "Ideogram",
      label: "Ideogram",
      baseURL: "https://api.ideogram.ai",
      apiSpec: "custom",
      models: ["V_2", "V_2_TURBO", "V_1"],
    },
    // 国内
    {
      vendor: "Volcengine",
      label: "火山引擎 · 即梦 Seedream",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiSpec: "ark",
      models: [
        "doubao-seedream-3-0-t2i-250415",
        "doubao-seedream-2-0-t2i-241218",
      ],
    },
    {
      vendor: "Alibaba",
      label: "阿里云 · 通义万相 Wanx",
      baseURL: "https://dashscope.aliyuncs.com/api/v1",
      apiSpec: "custom",
      models: ["wanx2.1-t2i-turbo", "wanx2.1-t2i-plus", "wanx-v1"],
      submitEndpoint: "/services/aigc/text2image/image-synthesis",
      queryEndpoint: "/tasks/{taskId}",
    },
    {
      vendor: "Baidu",
      label: "百度 · 文心一格 ERNIE-ViLG",
      baseURL: "https://qianfan.baidubce.com/v2",
      apiSpec: "custom",
      models: ["ernie-vilg-v2", "ernie-irag-1.0"],
    },
    {
      vendor: "Zhipu",
      label: "智谱 · CogView",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      apiSpec: "openai",
      models: ["cogview-3-plus", "cogview-3", "cogview-3-flash"],
    },
    {
      vendor: "Tencent",
      label: "腾讯 · 混元生图 Hunyuan-DiT",
      baseURL: "https://hunyuan.tencentcloudapi.com",
      apiSpec: "custom",
      models: ["hunyuan-dit", "hunyuan-dit-distilled"],
    },
    {
      vendor: "Kling",
      label: "可灵 · Kling 图像",
      baseURL: "https://api.klingai.com",
      apiSpec: "custom",
      models: ["kling-image-v1", "kling-image-v1-5"],
    },
  ],
  video: [
    // 国际
    {
      vendor: "OpenAI",
      label: "OpenAI Sora",
      baseURL: "https://api.openai.com/v1",
      apiSpec: "openai",
      models: ["sora-2", "sora-1"],
    },
    {
      vendor: "Niuma",
      label: "Niuma 中转 (Sora)",
      baseURL: "https://niuma.me/v1",
      apiSpec: "custom",
      models: ["sora-v3-pro", "sora-v3-fast", "sora-2"],
      submitEndpoint: "/v1/videos",
      queryEndpoint: "/v1/videos/{taskId}",
    },
    {
      vendor: "Google",
      label: "Google Veo",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiSpec: "custom",
      models: ["veo-2.0-generate-001"],
    },
    {
      vendor: "Runway",
      label: "Runway Gen-3",
      baseURL: "https://api.dev.runwayml.com/v1",
      apiSpec: "custom",
      models: ["gen3a_turbo", "gen3a"],
      submitEndpoint: "/image_to_video",
      queryEndpoint: "/tasks/{taskId}",
    },
    {
      vendor: "Luma",
      label: "Luma Dream Machine",
      baseURL: "https://api.lumalabs.ai/dream-machine/v1",
      apiSpec: "custom",
      models: ["ray-2", "ray-1-6", "ray-flash-2"],
      submitEndpoint: "/generations",
      queryEndpoint: "/generations/{taskId}",
    },
    {
      vendor: "Pika",
      label: "Pika Labs",
      baseURL: "https://api.pikapikapika.io/web",
      apiSpec: "custom",
      models: ["pika-2.0", "pika-1.5"],
    },
    // 国内
    {
      vendor: "Volcengine",
      label: "火山引擎 · 即梦 Seedance",
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      apiSpec: "ark",
      models: [
        "doubao-seedance-1-0-pro-250528",
        "doubao-seedance-1-0-lite-t2v-250428",
        "doubao-seedance-1-0-lite-i2v-250428",
      ],
    },
    {
      vendor: "Alibaba",
      label: "阿里云 · 通义万相视频",
      baseURL: "https://dashscope.aliyuncs.com/api/v1",
      apiSpec: "custom",
      models: [
        "wanx2.1-t2v-turbo",
        "wanx2.1-t2v-plus",
        "wanx2.1-i2v-turbo",
        "wanx2.1-i2v-plus",
      ],
      submitEndpoint: "/services/aigc/video-generation/video-synthesis",
      queryEndpoint: "/tasks/{taskId}",
    },
    {
      vendor: "Kling",
      label: "可灵 · Kling 视频",
      baseURL: "https://api.klingai.com",
      apiSpec: "custom",
      models: ["kling-v1", "kling-v1-pro", "kling-v1-6", "kling-v1-6-pro"],
      submitEndpoint: "/v1/videos/text2video",
      queryEndpoint: "/v1/videos/text2video/{taskId}",
    },
    {
      vendor: "MiniMax",
      label: "MiniMax · 海螺视频 Hailuo",
      baseURL: "https://api.minimax.chat/v1",
      apiSpec: "custom",
      models: ["MiniMax-Hailuo-02", "video-01", "video-01-live2d"],
      submitEndpoint: "/video_generation",
      queryEndpoint: "/query/video_generation?task_id={taskId}",
    },
    {
      vendor: "Vidu",
      label: "Vidu",
      baseURL: "https://api.vidu.studio/ent/v2",
      apiSpec: "custom",
      models: ["vidu-1.5", "vidu-2.0"],
    },
    {
      vendor: "Tencent",
      label: "腾讯 · 混元视频 Hunyuan-Video",
      baseURL: "https://hunyuan.tencentcloudapi.com",
      apiSpec: "custom",
      models: ["hunyuan-video"],
    },
  ],
  audio: [
    // 国际
    {
      vendor: "OpenAI",
      label: "OpenAI TTS / Whisper",
      baseURL: "https://api.openai.com/v1",
      apiSpec: "openai",
      models: ["tts-1", "tts-1-hd", "whisper-1"],
    },
    {
      vendor: "ElevenLabs",
      label: "ElevenLabs",
      baseURL: "https://api.elevenlabs.io/v1",
      apiSpec: "custom",
      models: [
        "eleven_multilingual_v2",
        "eleven_turbo_v2_5",
        "eleven_flash_v2_5",
      ],
    },
    {
      vendor: "Suno",
      label: "Suno · 音乐生成",
      baseURL: "https://api.suno.ai/v1",
      apiSpec: "custom",
      models: ["chirp-v4", "chirp-v3-5", "bark"],
    },
    // 国内
    {
      vendor: "Alibaba",
      label: "阿里云 · CosyVoice",
      baseURL: "https://dashscope.aliyuncs.com/api/v1",
      apiSpec: "custom",
      models: ["cosyvoice-v1", "cosyvoice-v2", "sambert-zhichu-v1"],
    },
    {
      vendor: "Volcengine",
      label: "火山引擎 · 语音合成 TTS",
      baseURL: "https://openspeech.bytedance.com/api/v1",
      apiSpec: "custom",
      models: ["tts-en", "tts-zh", "doubao-tts"],
    },
    {
      vendor: "Tencent",
      label: "腾讯云 · 语音合成 TTS",
      baseURL: "https://tts.tencentcloudapi.com",
      apiSpec: "custom",
      models: ["tts-100", "tts-101", "tts-1003"],
    },
    {
      vendor: "Baidu",
      label: "百度智能云 · 语音合成",
      baseURL: "https://aip.baidubce.com",
      apiSpec: "custom",
      models: ["baidu-tts", "baidu-tts-female", "baidu-tts-male"],
    },
    {
      vendor: "MiniMax",
      label: "MiniMax · 语音合成",
      baseURL: "https://api.minimax.chat/v1",
      apiSpec: "custom",
      models: ["speech-01", "speech-01-turbo", "speech-01-hd"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

export function listProviderConfigs(): Promise<ProviderConfig[]> {
  return apiClient.get<ProviderConfig[]>("/api/admin/provider-configs");
}

export function createProviderConfig(
  payload: ProviderConfigPayload,
): Promise<ProviderConfig> {
  return apiClient.post<ProviderConfig>("/api/admin/provider-configs", payload);
}

export function updateProviderConfig(
  id: string,
  payload: ProviderConfigPayload,
): Promise<ProviderConfig> {
  return apiClient.put<ProviderConfig>(
    `/api/admin/provider-configs/${id}`,
    payload,
  );
}

export function deleteProviderConfig(id: string): Promise<void> {
  return apiClient.delete(`/api/admin/provider-configs/${id}`);
}

/** POST /api/admin/provider-configs/:id/reset-health — clears failure
 *  counters and cooldown so the channel re-enters rotation immediately. */
export function resetChannelHealth(id: string): Promise<ProviderConfig> {
  return apiClient.post<ProviderConfig>(
    `/api/admin/provider-configs/${id}/reset-health`,
  );
}

/** POST /api/admin/provider-configs/:id/test — probes the upstream relay
 *  to verify credentials + network path. Doesn't consume model quota. */
export function testChannelConnectivity(
  id: string,
): Promise<ChannelTestResult> {
  return apiClient.post<ChannelTestResult>(
    `/api/admin/provider-configs/${id}/test`,
  );
}

export function toggleProviderConfigStatus(
  id: string,
): Promise<ProviderConfig> {
  return apiClient.post<ProviderConfig>(
    `/api/admin/provider-configs/${id}/toggle`,
  );
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
  node_id?: string;
  service_type: string;
  model: string;
  prompt: string;
  size?: string; // image ratio: "1:1", "16:9", "auto"
  resolution?: string; // video: "480p"/"720p"
  quality?: string; // image quality: "auto"/"high"/"medium"/"low"
  duration?: number; // video duration in seconds
  aspect_ratio?: string; // video aspect ratio: "16:9", "9:16", etc.
  reference_images?: string[];
  reference_mode?: string;
  reference_video?: string;
  reference_videos?: string[];
  edit_operation?: string;
  mask_image?: string;
  output_count?: number;
  expand_direction?: string;
  derive_from_node_id?: string;
  trim_range?: { start: number; end: number };
  crop_rect?: { x: number; y: number; width: number; height: number };
  target_tracks?: string[];
  output_format?: string;
};

export type GenerateResult = {
  type: "text" | "url";
  content: string;
  /** Generation log row id — present when the backend was able to
   *  persist a log row. Frontend stores this on the node so recovery
   *  polling (Stage 2) can ask the backend "what happened to this
   *  task?" after a client-side timeout. */
  task_id?: string;
};

export function generate(
  payload: GeneratePayload,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  return apiClient.post<GenerateResult>("/api/app/generate", payload, signal);
}
