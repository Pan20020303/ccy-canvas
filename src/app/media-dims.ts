// Session-level cache of measured media dimensions, keyed by URL. When a canvas
// is re-entered the nodes remount and reload from the (possibly dimension-less)
// snapshot; without this they'd render a default 16:9 box and then JUMP to the
// real aspect once the image/video loads. Remembering the measured size lets the
// remount render the correct box immediately — and it helps read-only visitors,
// who can't persist the measured dims back into the saved snapshot.
//
// The canvas loader (CanvasLoader.tsx) prewarms this cache during the entry
// animation, so by the time the canvas reveals, every node already knows its
// aspect and its image is in the browser cache.
export const mediaDimCache = new Map<string, { w: number; h: number }>();

export function rememberMediaDims(url: unknown, w: number, h: number) {
  if (typeof url === "string" && url && w > 0 && h > 0) {
    mediaDimCache.set(url, { w, h });
  }
}

/** Best-known dimensions for a media node: persisted data first, else this
 *  session's measured cache. null when still unknown (first-ever load). */
export function resolveMediaDims(data: Record<string, any>): { w: number; h: number } | null {
  const w = Number(data.mediaWidth);
  const h = Number(data.mediaHeight);
  if (w > 0 && h > 0) return { w, h };
  const cached = typeof data.url === "string" ? mediaDimCache.get(data.url) : undefined;
  return cached ?? null;
}
