export type ApiEnvelope<T> = {
  data: T;
  request_id: string;
};

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  request_id: string;
};

export class ApiClientError extends Error {
  code: string;
  details?: unknown;
  requestId?: string;
  status: number;
  rawBody?: string;

  constructor(options: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string;
    rawBody?: string;
  }) {
    super(options.message);
    this.name = "ApiClientError";
    this.code = options.code;
    this.details = options.details;
    this.requestId = options.requestId;
    this.status = options.status;
    this.rawBody = options.rawBody;
  }
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

function resolveUrl(input: string) {
  if (/^https?:\/\//.test(input) || !apiBaseUrl) {
    return input;
  }
  return `${apiBaseUrl}${input.startsWith("/") ? input : `/${input}`}`;
}

function isApiErrorEnvelope(body: unknown): body is ApiErrorEnvelope {
  return typeof body === "object" && body !== null && "error" in body && "request_id" in body;
}

function isApiEnvelope<T>(body: unknown): body is ApiEnvelope<T> {
  return typeof body === "object" && body !== null && "data" in body && "request_id" in body;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveUrl(input), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const rawBody = await response.text();
  let body: ApiEnvelope<T> | ApiErrorEnvelope | null = null;
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as ApiEnvelope<T> | ApiErrorEnvelope;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    if (body && isApiErrorEnvelope(body)) {
      throw new ApiClientError({
        code: body.error.code,
        message: body.error.message,
        details: body.error.details,
        requestId: body.request_id,
        status: response.status,
        rawBody,
      });
    }

    // Huma problem+json format: { $schema, title, status, detail, errors?: [{ message, location, value }] }
    if (body && typeof body === "object" && "detail" in body) {
      const humaErr = body as { title?: string; detail?: string; status?: number; errors?: Array<{ message?: string; location?: string }> };
      // Compose a message that includes per-field validation issues when present.
      let message = humaErr.detail ?? "Request failed";
      if (Array.isArray(humaErr.errors) && humaErr.errors.length > 0) {
        const parts = humaErr.errors
          .map((e) => [e.location, e.message].filter(Boolean).join(": "))
          .filter((part) => part.length > 0);
        if (parts.length > 0) message = `${message} — ${parts.join("; ")}`;
      }
      throw new ApiClientError({
        code: humaErr.title ?? "ERROR",
        message,
        status: response.status,
        details: humaErr.errors,
        rawBody,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const fallbackMessage = contentType.includes("text/html")
      ? "Unexpected HTML response from API"
      : "Request failed";

    throw new ApiClientError({
      code: "UNEXPECTED_RESPONSE",
      message: fallbackMessage,
      status: response.status,
      rawBody,
    });
  }

  if (!body || !isApiEnvelope<T>(body)) {
    throw new ApiClientError({
      code: "UNEXPECTED_RESPONSE",
      message: "API returned an invalid response payload",
      status: response.status,
      rawBody,
    });
  }

  return body.data;
}

export const apiClient = {
  get<T>(input: string) {
    return request<T>(input);
  },
  post<T>(input: string, payload?: unknown, signal?: AbortSignal) {
    return request<T>(input, {
      method: "POST",
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal,
    });
  },
  put<T>(input: string, payload?: unknown) {
    return request<T>(input, {
      method: "PUT",
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  },
  patch<T>(input: string, payload?: unknown) {
    return request<T>(input, {
      method: "PATCH",
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  },
  delete<T>(input: string) {
    return request<T>(input, { method: "DELETE" });
  },
};
