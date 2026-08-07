export type ApiEnvelope<T> = {
  data: T;
  request_id?: string;
  total?: number;
};

export type ApiResponse<T> = {
  data: T;
  requestId?: string;
  total?: number;
};

export type ApiErrorEnvelope = {
  error: {
    code?: string;
    message?: string;
    details?: unknown;
    retryable?: boolean;
  };
  request_id?: string;
};

const MAX_DIAGNOSTIC_LENGTH = 512;
const SENSITIVE_VALUE = /((?:api[_-]?key|authorization|token|password|secret|cookie|session|credential)\s*[:=]\s*)[^\s,;"'}]+/gi;

function redactDiagnostic(value: string) {
  return value
    .replace(SENSITIVE_VALUE, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|password|secret|signature|sig)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export class ApiClientError extends Error {
  code: string;
  details?: unknown;
  requestId?: string;
  status: number;
  retryable: boolean;
  /** A short redacted transport diagnostic. Do not render it directly in UI. */
  rawBody?: string;

  constructor(options: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string;
    retryable?: boolean;
    rawBody?: string;
  }) {
    super(options.message);
    this.name = "ApiClientError";
    this.code = options.code || "REQUEST_FAILED";
    this.details = options.details;
    this.requestId = options.requestId;
    this.status = options.status;
    this.retryable = options.retryable ?? (options.status === 0 || options.status >= 500);
    this.rawBody = options.rawBody ? redactDiagnostic(options.rawBody) : undefined;
  }
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export function resolveApiUrl(input: string) {
  if (/^https?:\/\//.test(input) || !apiBaseUrl) return input;
  return `${apiBaseUrl}${input.startsWith("/") ? input : `/${input}`}`;
}

function inferSameHostBackendUrl(input: string) {
  if (apiBaseUrl || /^https?:\/\//.test(input) || !input.startsWith("/api/")) return "";
  if (typeof window === "undefined" || !window.location?.hostname) return "";
  const { protocol, hostname, port } = window.location;
  if (!/^https?:$/.test(protocol) || port === "8080") return "";
  return `${protocol}//${hostname}:8080${input}`;
}

export function resolveApiBrowserUrl(input: string) {
  return inferSameHostBackendUrl(input) || resolveApiUrl(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiErrorEnvelope(body: unknown): body is ApiErrorEnvelope {
  return isRecord(body) && isRecord(body.error);
}

function isApiEnvelope<T>(body: unknown): body is ApiEnvelope<T> {
  return isRecord(body) && "data" in body;
}

function requestIdFrom(response: Response, body: unknown) {
  if (isRecord(body) && typeof body.request_id === "string" && body.request_id.trim()) return body.request_id;
  return response.headers.get("x-request-id") ?? response.headers.get("x-requestid") ?? undefined;
}

function parseJson(rawBody: string): unknown {
  if (!rawBody.trim()) return undefined;
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

function genericMessageForStatus(status: number) {
  if (status === 0) return "网络连接异常，请稍后重试。";
  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 403) return "你没有权限执行此操作。";
  if (status === 404) return "请求的资源不存在或已被移除。";
  if (status === 408 || status === 504) return "请求超时，请稍后重试。";
  if (status === 429) return "请求过于频繁，请稍后再试。";
  if (status >= 500) return "服务暂时不可用，请稍后重试。";
  return "请求失败，请检查后重试。";
}

function apiErrorFromResponse(response: Response, body: unknown, rawBody: string): ApiClientError {
  const requestId = requestIdFrom(response, body);
  if (isApiErrorEnvelope(body)) {
    const code = typeof body.error.code === "string" && body.error.code.trim() ? body.error.code : "REQUEST_FAILED";
    const message = typeof body.error.message === "string" && body.error.message.trim()
      ? body.error.message
      : genericMessageForStatus(response.status);
    return new ApiClientError({
      code,
      message,
      details: body.error.details,
      requestId,
      retryable: body.error.retryable,
      status: response.status,
      rawBody,
    });
  }

  // Transitional Huma problem+json support. Its raw detail can contain rejected
  // field values, so it is never promoted into a user-facing message.
  if (isRecord(body) && (typeof body.detail === "string" || typeof body.title === "string")) {
    return new ApiClientError({
      code: response.status === 400 || response.status === 422 ? "VALIDATION_ERROR" : "REQUEST_FAILED",
      message: genericMessageForStatus(response.status),
      requestId,
      retryable: response.status >= 500,
      status: response.status,
      rawBody,
    });
  }

  return new ApiClientError({
    code: "UNEXPECTED_RESPONSE",
    message: genericMessageForStatus(response.status),
    requestId,
    retryable: response.status === 0 || response.status >= 500,
    status: response.status,
    rawBody,
  });
}

function requestCancelled(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchResponse(input: string, init?: RequestInit) {
  const primaryUrl = resolveApiUrl(input);
  const fallbackUrl = inferSameHostBackendUrl(input);
  const requestInit: RequestInit = {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  };

  try {
    return await fetch(primaryUrl, requestInit);
  } catch (error) {
    if (requestCancelled(error)) {
      throw new ApiClientError({ code: "REQUEST_CANCELLED", message: "请求已取消。", status: 0, retryable: false });
    }
    if (fallbackUrl && fallbackUrl !== primaryUrl) {
      try {
        return await fetch(fallbackUrl, requestInit);
      } catch (fallbackError) {
        if (requestCancelled(fallbackError)) {
          throw new ApiClientError({ code: "REQUEST_CANCELLED", message: "请求已取消。", status: 0, retryable: false });
        }
      }
    }
    throw new ApiClientError({ code: "NETWORK_ERROR", message: genericMessageForStatus(0), status: 0, retryable: true });
  }
}

async function requestEnvelope<T>(input: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const response = await fetchResponse(input, init);
  const rawBody = await response.text();
  const body = parseJson(rawBody);
  if (!response.ok) throw apiErrorFromResponse(response, body, rawBody);
  if (!rawBody.trim()) return { data: undefined as T, requestId: requestIdFrom(response, body) };
  if (!isApiEnvelope<T>(body)) {
    throw new ApiClientError({
      code: "UNEXPECTED_RESPONSE",
      message: "服务返回了无法识别的数据，请稍后重试。",
      requestId: requestIdFrom(response, body),
      status: response.status,
      retryable: false,
      rawBody,
    });
  }
  return {
    data: body.data,
    requestId: requestIdFrom(response, body),
    total: isRecord(body) && typeof body.total === "number" ? body.total : undefined,
  };
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  return (await requestEnvelope<T>(input, init)).data;
}

export const apiClient = {
  get<T>(input: string) {
    return request<T>(input);
  },
  getEnvelope<T>(input: string) {
    return requestEnvelope<T>(input);
  },
  post<T>(input: string, payload?: unknown, signal?: AbortSignal) {
    return request<T>(input, { method: "POST", body: payload === undefined ? undefined : JSON.stringify(payload), signal });
  },
  put<T>(input: string, payload?: unknown, options?: { keepalive?: boolean }) {
    return request<T>(input, {
      method: "PUT",
      body: payload === undefined ? undefined : JSON.stringify(payload),
      ...(options?.keepalive ? { keepalive: true } : {}),
    });
  },
  patch<T>(input: string, payload?: unknown) {
    return request<T>(input, { method: "PATCH", body: payload === undefined ? undefined : JSON.stringify(payload) });
  },
  delete<T>(input: string, payload?: unknown) {
    return request<T>(input, { method: "DELETE", body: payload === undefined ? undefined : JSON.stringify(payload) });
  },
};
