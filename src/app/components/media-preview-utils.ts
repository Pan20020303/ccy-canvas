import { useEffect, useRef } from 'react';

export function fitMedia(width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const w = width > 0 ? width : 16;
  const h = height > 0 ? height : 9;
  const scale = Math.min(Math.max(1, viewportWidth) / w, Math.max(1, viewportHeight) / h);
  return { width: w * scale, height: h * scale, scale };
}

export const MEDIA_PREVIEW_ACTION = 'ccy:media-preview-action';
export type MediaPreviewAction = 'edit' | 'upscale';
export function requestMediaPreviewAction(nodeId: string, action: MediaPreviewAction) {
  window.dispatchEvent(new CustomEvent(MEDIA_PREVIEW_ACTION, { detail: { nodeId, action } }));
}

export function useMediaPreviewAction(nodeId: string, handler: (action: MediaPreviewAction) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.nodeId === nodeId && (detail.action === 'edit' || detail.action === 'upscale')) latest.current(detail.action);
    };
    window.addEventListener(MEDIA_PREVIEW_ACTION, listener);
    return () => window.removeEventListener(MEDIA_PREVIEW_ACTION, listener);
  }, [nodeId]);
}
