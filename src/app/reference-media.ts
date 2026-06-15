export type ReferenceNodeType = "referenceImageNode" | "referenceVideoNode";

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
