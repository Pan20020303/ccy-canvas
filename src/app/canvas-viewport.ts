import { useCallback, useEffect, useRef, useState } from 'react';
import type { Viewport } from '@xyflow/react';

export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 4;
const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export function canvasViewportKey(userId: string | null, projectId: string | null) {
  return userId && projectId
    ? `ccy:canvas-viewport:v1:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`
    : null;
}

function validViewport(value: unknown): value is Viewport {
  if (!value || typeof value !== 'object') return false;
  const view = value as Record<string, unknown>;
  return typeof view.x === 'number' && Number.isFinite(view.x)
    && typeof view.y === 'number' && Number.isFinite(view.y)
    && typeof view.zoom === 'number' && Number.isFinite(view.zoom) && view.zoom > 0;
}

export function readCanvasViewport(key: string | null): Viewport | null {
  if (!key) return null;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!validViewport(value)) return null;
    return { x: value.x, y: value.y, zoom: Math.max(CANVAS_MIN_ZOOM, Math.min(CANVAS_MAX_ZOOM, value.zoom)) };
  } catch { return null; }
}

/** Local viewing preferences, never part of the shared collaborative snapshot.
 * Mount with a new key when changing accounts/projects so an outgoing viewport
 * cannot be recorded against the destination canvas while its nodes load.
 */
export function useCanvasViewportMemory(key: string | null, ready: boolean) {
  const [saved] = useState(() => readCanvasViewport(key));
  const latest = useRef<Viewport | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!key || !latest.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(latest.current));
      latest.current = null; // An idle old tab must not overwrite a newer tab on close.
    } catch { /* Storage may be blocked or full. */ }
  }, [key]);

  const onMove = useCallback((_event: unknown, viewport: Viewport) => {
    if (!ready || !validViewport(viewport)) return;
    latest.current = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
    // Keep long drags durable without serializing every animation frame.
    if (timer.current === null) timer.current = setTimeout(flush, 250);
  }, [ready, flush]);
  const onMoveEnd = useCallback((event: unknown, viewport: Viewport) => {
    onMove(event, viewport);
    flush();
  }, [onMove, flush]);

  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [flush]);

  return { defaultViewport: saved ?? DEFAULT_VIEWPORT, fitView: saved === null, onMove, onMoveEnd };
}
