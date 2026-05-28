export type ServiceType = "text" | "image" | "video" | "audio";

export type ModelConfig = {
  id: string;
  serviceType: ServiceType;
  vendor: string;
  protocol: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  submitEndpoint: string;
  queryEndpoint: string;
  modelList: string[];
  defaultModel: string;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ConnectionTestResult = {
  ok: boolean;
  status: "idle" | "success" | "error";
  message: string;
  checkedAt?: number;
};

export function normalizeModelList(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getModelsForServiceType(
  configs: ModelConfig[],
  serviceType: ServiceType,
): string[] {
  const seen = new Set<string>();
  const models: string[] = [];

  for (const config of configs) {
    if (config.serviceType !== serviceType || !config.enabled) {
      continue;
    }

    for (const model of config.modelList) {
      if (!seen.has(model)) {
        seen.add(model);
        models.push(model);
      }
    }
  }

  return models;
}

export function getEnabledConfigsForServiceType(
  configs: ModelConfig[],
  serviceType: ServiceType,
): ModelConfig[] {
  return configs.filter((config) => config.serviceType === serviceType && config.enabled);
}

export function resolvePreferredModelConfig(
  configs: ModelConfig[],
  serviceType: ServiceType,
): ModelConfig | null {
  return (
    configs
      .filter((config) => config.serviceType === serviceType && config.enabled)
      .sort((left, right) => {
        if (left.isDefault !== right.isDefault) {
          return left.isDefault ? -1 : 1;
        }
        return left.priority - right.priority;
      })[0] ?? null
  );
}

export function resolveModelConfigForSelection(
  configs: ModelConfig[],
  serviceType: ServiceType,
  modelName?: string,
): ModelConfig | null {
  const enabled = configs.filter((config) => config.serviceType === serviceType && config.enabled);

  if (modelName?.trim()) {
    const matched = enabled
      .filter((config) => config.modelList.includes(modelName))
      .sort((left, right) => {
        if (left.isDefault !== right.isDefault) {
          return left.isDefault ? -1 : 1;
        }
        return left.priority - right.priority;
      })[0];

    if (matched) {
      return matched;
    }
  }

  return resolvePreferredModelConfig(enabled, serviceType);
}

export function normalizeModelBaseUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(value);
    if (!parsed.pathname || parsed.pathname === "/") {
      value = `${parsed.origin}/v1`;
    }
  } catch {
    return value;
  }

  return value;
}

export function getDefaultSubmitEndpoint(
  config: Pick<ModelConfig, "serviceType" | "submitEndpoint">,
): string {
  if (config.submitEndpoint.trim()) {
    return config.submitEndpoint.trim();
  }

  if (config.serviceType === "text") {
    return "/chat/completions";
  }
  if (config.serviceType === "image") {
    return "/images/generations";
  }

  return "/generations";
}

function buildConnectionProbePayload(
  config: Pick<ModelConfig, "serviceType" | "modelList" | "defaultModel">,
) {
  const modelName = config.defaultModel || config.modelList[0] || "";

  if (config.serviceType === "text") {
    return {
      model: modelName,
      messages: [{ role: "user", content: "connection test" }],
      max_tokens: 1,
    };
  }

  if (config.serviceType === "image") {
    return {
      model: modelName,
      prompt: "connection test",
      n: 1,
      size: "1024x1024",
    };
  }

  return {
    model: modelName,
    prompt: "connection test",
  };
}

export async function probeModelConfigConnection(
  config: Pick<
    ModelConfig,
    "baseUrl" | "apiKey" | "submitEndpoint" | "serviceType" | "modelList" | "defaultModel"
  >,
): Promise<ConnectionTestResult> {
  if (!config.baseUrl.trim()) {
    return { ok: false, status: "error", message: "请先填写 Base URL" };
  }

  if (!config.apiKey.trim()) {
    return { ok: false, status: "error", message: "请先填写 API Key" };
  }

  if (!config.defaultModel.trim() && config.modelList.length === 0) {
    return { ok: false, status: "error", message: "请先填写模型列表" };
  }

  const baseUrl = normalizeModelBaseUrl(config.baseUrl);
  const endpointPath = config.submitEndpoint.trim() || getDefaultSubmitEndpoint(config);
  const endpoint = `${baseUrl}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
  const body = buildConnectionProbePayload(config);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const rawText = await response.text();

    if (response.ok) {
      return {
        ok: true,
        status: "success",
        message: "连接成功",
        checkedAt: Date.now(),
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: "error",
        message: "认证失败，请检查 API Key",
        checkedAt: Date.now(),
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        status: "error",
        message: "端点不存在，请检查 Base URL 或 endpoint",
        checkedAt: Date.now(),
      };
    }

    if (response.status === 400 || response.status === 422) {
      return {
        ok: true,
        status: "success",
        message: "接口已连通，请继续核对请求参数映射",
        checkedAt: Date.now(),
      };
    }

    return {
      ok: false,
      status: "error",
      message: `连接失败（HTTP ${response.status}）${rawText ? `: ${rawText.slice(0, 80)}` : ""}`,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      message: error instanceof Error ? error.message : "连接失败",
      checkedAt: Date.now(),
    };
  }
}
