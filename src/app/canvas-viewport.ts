import type { Viewport } from '@xyflow/react';

const STORAGE_PREFIX = 'ccy:canvas-viewport:v1:';

export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 4;

type ViewportStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function canvasViewportStorageKey(projectKey: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(projectKey)}`;
}

function normalizeViewport(value: unknown): Viewport | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<Viewport>;
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const zoom = Number(candidate.zoom);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) return null;
  return {
    x,
    y,
    zoom: Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom)),
  };
}

export function readCanvasViewport(projectKey: string, storage?: ViewportStorage): Viewport | null {
  if (!projectKey) return null;
  const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!target) return null;
  try {
    const raw = target.getItem(canvasViewportStorageKey(projectKey));
    return raw ? normalizeViewport(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCanvasViewport(projectKey: string, viewport: Viewport, storage?: ViewportStorage) {
  if (!projectKey) return false;
  const normalized = normalizeViewport(viewport);
  const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!target || !normalized) return false;
  try {
    target.setItem(canvasViewportStorageKey(projectKey), JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}
