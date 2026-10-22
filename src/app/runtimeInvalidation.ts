export type RuntimeInvalidationScope = "credits" | "identity" | "models";

export type RuntimeInvalidation = {
  id: string;
  scopes: RuntimeInvalidationScope[];
  targetUserId?: string;
  emittedAt: number;
};

const EVENT_NAME = "ccy:runtime-invalidation";
const STORAGE_KEY = "ccy.runtime-invalidation";

function isRuntimeInvalidation(value: unknown): value is RuntimeInvalidation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeInvalidation>;
  return typeof candidate.id === "string"
    && Array.isArray(candidate.scopes)
    && candidate.scopes.every((scope) => scope === "credits" || scope === "identity" || scope === "models")
    && typeof candidate.emittedAt === "number";
}

function dispatch(payload: RuntimeInvalidation) {
  window.dispatchEvent(new CustomEvent<RuntimeInvalidation>(EVENT_NAME, { detail: payload }));
}

export function publishRuntimeInvalidation(
  scopes: RuntimeInvalidationScope[],
  targetUserId?: string,
) {
  if (typeof window === "undefined") return;
  const payload: RuntimeInvalidation = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    scopes: Array.from(new Set(scopes)),
    targetUserId,
    emittedAt: Date.now(),
  };
  dispatch(payload);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Same-tab delivery still works when storage is unavailable.
  }
}

export function subscribeRuntimeInvalidation(
  listener: (payload: RuntimeInvalidation) => void,
) {
  if (typeof window === "undefined") return () => undefined;

  const onLocal = (event: Event) => {
    const payload = (event as CustomEvent<RuntimeInvalidation>).detail;
    if (isRuntimeInvalidation(payload)) listener(payload);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const payload: unknown = JSON.parse(event.newValue);
      if (isRuntimeInvalidation(payload)) listener(payload);
    } catch {
      // Ignore malformed values written by older clients.
    }
  };

  window.addEventListener(EVENT_NAME, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}
