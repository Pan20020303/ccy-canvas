export type ScreenBounds = { left: number; top: number; right: number; bottom: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Keep a context menu inside the canvas without changing the flow-space drop point. */
export function clampCanvasMenu(
  anchor: { x: number; y: number },
  canvas: { width: number; height: number },
  menu: { width: number; height: number },
  margin = 8,
) {
  return {
    x: clamp(anchor.x, margin, Math.max(margin, canvas.width - menu.width - margin)),
    y: clamp(anchor.y, margin, Math.max(margin, canvas.height - menu.height - margin)),
  };
}

export function unionScreenBounds(a: ScreenBounds, b: ScreenBounds): ScreenBounds {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** Minimum pan to reveal a node and its floating composer. Oversized content is centered. */
export function revealPanDelta(
  bounds: ScreenBounds,
  canvas: { width: number; height: number },
  inset = { left: 24, right: 24, top: 64, bottom: 80 },
) {
  const axis = (start: number, end: number, low: number, high: number) => {
    if (end - start > high - low) return (low + high - start - end) / 2;
    if (start < low) return low - start;
    if (end > high) return high - end;
    return 0;
  };
  const left = inset.left;
  const right = Math.max(left, canvas.width - inset.right);
  const top = inset.top;
  const bottom = Math.max(top, canvas.height - inset.bottom);
  return {
    x: axis(bounds.left, bounds.right, left, right),
    y: axis(bounds.top, bounds.bottom, top, bottom),
  };
}
