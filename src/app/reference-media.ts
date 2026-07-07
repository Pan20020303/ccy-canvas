export type ReferenceNodeType =
  | "referenceImageNode"
  | "referenceVideoNode"
  | "referenceAudioNode";

const transientReferencePayloadValues = new Map<string, string>();

export function getReferenceNodeTypeFromMimeType(mimeType?: string | null): ReferenceNodeType | null {
  if (!mimeType) {
    return null;
  }

  if (mimeType.startsWith("image/")) {
    return "referenceImageNode";
  }

  if (mimeType.startsWith("video/")) {
    return "referenceVideoNode";
  }

  if (mimeType.startsWith("audio/")) {
    return "referenceAudioNode";
  }

  return null;
}

export function resolveBackendAssetUrl(url?: string | null, apiBaseUrl?: string | null): string {
  if (!url) {
    return "";
  }

  if (!url.startsWith("/") || !apiBaseUrl?.trim()) {
    return url;
  }

  return new URL(url, apiBaseUrl).toString();
}

export function isPublicHttpAssetUrl(url?: string | null): boolean {
  if (!url || !/^https?:\/\//i.test(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host !== "localhost"
      && host !== "127.0.0.1"
      && host !== "::1"
      && !host.startsWith("10.")
      && !host.startsWith("192.168.")
      && !/^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  } catch {
    return false;
  }
}

export function isTransientBrowserMediaUrl(url?: string | null): boolean {
  if (!url) {
    return false;
  }

  return url.startsWith("data:") || url.startsWith("blob:");
}

const PROXY_MEDIA_PATH = "/api/app/proxy-media";

function apiBaseUrlPrefix(): string {
  return (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
}

/** True when the URL already targets our media proxy endpoint, regardless of
 *  its origin (absolute `http://host:9090/api/app/proxy-media?...` or the bare
 *  relative `/api/app/proxy-media?...`). */
export function isProxyMediaUrl(url?: string | null): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url, "http://localhost").pathname === PROXY_MEDIA_PATH;
  } catch {
    return false;
  }
}

/** Peel any (possibly nested) proxy-media wrapper and return the real upstream
 *  URL. Idempotent: a non-proxy URL is returned unchanged. The loop guards
 *  against historical double-wrapped values that leaked into persisted state. */
export function extractOriginalMediaUrl(url?: string | null): string {
  let current = url ?? "";
  for (let i = 0; i < 5 && isProxyMediaUrl(current); i++) {
    try {
      const inner = new URL(current, "http://localhost").searchParams.get("url");
      if (!inner) {
        break;
      }
      current = inner;
    } catch {
      break;
    }
  }
  return current;
}

/** Produce a URL the browser can load through our media proxy (sidesteps
 *  CORS / referer / mixed-content for remote hosts). Idempotent and
 *  double-wrap-safe: data:/blob: and relative paths pass through unchanged,
 *  and any remote http(s) URL — including one that is already wrapped in
 *  proxy-media — collapses to exactly one proxy layer. */
export function toRenderableMediaUrl(url?: string | null, opts?: { thumbWidth?: number }): string {
  if (!url) {
    return "";
  }
  if (isTransientBrowserMediaUrl(url)) {
    return url;
  }
  const origin = extractOriginalMediaUrl(url);
  if (!/^https?:\/\//i.test(origin)) {
    // Relative path (e.g. /uploads/..) — leave as-is for the page/backend to serve.
    return origin;
  }
  // Optional thumbnail hint: the media proxy downsizes our own OSS images to a
  // small WebP (`?w=`), cutting bytes for gallery/canvas tiles. It's ignored for
  // non-OSS or non-image sources, so passing it is always safe.
  const thumb = opts?.thumbWidth && opts.thumbWidth > 0 ? `&w=${Math.round(opts.thumbWidth)}` : "";
  return `${apiBaseUrlPrefix()}${PROXY_MEDIA_PATH}?url=${encodeURIComponent(origin)}${thumb}`;
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function setReferencePayloadValue(nodeId: string, value: string) {
  if (!nodeId || !value) {
    return;
  }

  transientReferencePayloadValues.set(nodeId, value);
}

export function clearReferencePayloadValue(nodeId: string) {
  transientReferencePayloadValues.delete(nodeId);
}

export function getReferencePayloadValue(nodeId: string, data?: Record<string, unknown> | null): string {
  const transientValue = transientReferencePayloadValues.get(nodeId);
  if (transientValue) {
    return transientValue;
  }

  if (typeof data?.referenceValue === "string" && data.referenceValue) {
    return data.referenceValue;
  }

  return typeof data?.url === "string" ? data.url : "";
}
