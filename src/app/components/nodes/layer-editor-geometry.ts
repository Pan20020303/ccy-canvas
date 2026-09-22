import type { LayerEditorLayer } from './LayerEditorNode';

export type LayerBounds = { width: number; height: number };
export type LayerRect = LayerBounds & { x: number; y: number };
export type LayerHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type LayerGuides = { x?: number; y?: number };
type Targets = { x: number[]; y: number[] };
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const positive = (v: number | undefined, fallback: number) => v && Number.isFinite(v) && v > 0 ? v : fallback;

export function layerRect(layer: LayerEditorLayer, canvas: LayerBounds): LayerRect {
  const width = positive(layer.wPct, 0.5) * canvas.width;
  const height = layer.hPct === undefined ? width / positive(layer.aspect, 1) : positive(layer.hPct, 0.5) * canvas.height;
  return { x: layer.xPct * canvas.width - width / 2, y: layer.yPct * canvas.height - height / 2, width, height };
}

/** Shrink oversized legacy layers proportionally, then keep all four edges visible. */
export function fitLayerRect(rect: LayerRect, canvas: LayerBounds): LayerRect {
  const scale = Math.min(1, canvas.width / rect.width, canvas.height / rect.height);
  const width = rect.width * scale, height = rect.height * scale;
  return { x: clamp(rect.x + (rect.width - width) / 2, 0, canvas.width - width), y: clamp(rect.y + (rect.height - height) / 2, 0, canvas.height - height), width, height };
}

export function rectToLayer(layer: LayerEditorLayer, rect: LayerRect, canvas: LayerBounds): LayerEditorLayer {
  return { ...layer, xPct: (rect.x + rect.width / 2) / canvas.width, yPct: (rect.y + rect.height / 2) / canvas.height, wPct: rect.width / canvas.width, hPct: rect.height / canvas.height };
}

/** Preserve displayed proportions (including intentional edge stretching) when the canvas ratio changes. */
export function reframeLayer(layer: LayerEditorLayer, oldAspect: number, newAspect: number): LayerEditorLayer {
  const before = layerRect(layer, { width: oldAspect, height: 1 });
  const canvas = { width: newAspect, height: 1 };
  const width = layer.wPct * newAspect, height = width * before.height / before.width;
  return rectToLayer(layer, fitLayerRect({ x: layer.xPct * newAspect - width / 2, y: layer.yPct - height / 2, width, height }, canvas), canvas);
}

export function layerSnapTargets(canvas: LayerBounds, others: LayerRect[]): Targets {
  return {
    x: [...new Set([0, canvas.width / 2, canvas.width, ...others.flatMap(r => [r.x, r.x + r.width / 2, r.x + r.width])])],
    y: [...new Set([0, canvas.height / 2, canvas.height, ...others.flatMap(r => [r.y, r.y + r.height / 2, r.y + r.height])])],
  };
}

function nearest(points: number[], targets: number[], threshold: number) {
  let best: { delta: number; target: number } | undefined;
  for (const point of points) for (const target of targets) {
    const delta = target - point;
    if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, target };
  }
  return best;
}

/** Pure screen-space geometry, shared by every drag handle. No center-based resizing. */
export function transformLayerRect(start: LayerRect, mode: 'move' | LayerHandle, dx: number, dy: number, canvas: LayerBounds, targets: Targets, snap = true, threshold = 7): { rect: LayerRect; guides: LayerGuides } {
  const r = fitLayerRect(start, canvas), guides: LayerGuides = {};
  if (mode === 'move') {
    let x = clamp(r.x + dx, 0, canvas.width - r.width), y = clamp(r.y + dy, 0, canvas.height - r.height);
    if (snap) {
      const sx = nearest([x, x + r.width / 2, x + r.width], targets.x, threshold);
      const sy = nearest([y, y + r.height / 2, y + r.height], targets.y, threshold);
      if (sx && x + sx.delta >= 0 && x + sx.delta + r.width <= canvas.width) { x += sx.delta; guides.x = sx.target; }
      if (sy && y + sy.delta >= 0 && y + sy.delta + r.height <= canvas.height) { y += sy.delta; guides.y = sy.target; }
    }
    return { rect: { ...r, x, y }, guides };
  }

  const west = mode.includes('w'), east = mode.includes('e'), north = mode.includes('n'), south = mode.includes('s');
  const horizontal = west || east, vertical = north || south;
  const signX = west ? -1 : 1, signY = north ? -1 : 1;
  const anchorX = west ? r.x + r.width : r.x, anchorY = north ? r.y + r.height : r.y;
  const maxW = west ? anchorX : canvas.width - anchorX, maxH = north ? anchorY : canvas.height - anchorY;
  let width = r.width, height = r.height;

  if (horizontal && vertical) {
    // Corners retain the current aspect and keep the opposite corner fixed.
    const maxScale = Math.min(maxW / r.width, maxH / r.height);
    const minScale = Math.min(maxScale, Math.max(16 / r.width, 16 / r.height));
    const deltaScale = Math.abs(dx / r.width) >= Math.abs(dy / r.height) ? signX * dx / r.width : signY * dy / r.height;
    let scale = clamp(1 + deltaScale, minScale, maxScale);
    if (snap) {
      const sx = nearest([anchorX + signX * r.width * scale], targets.x.filter(t => {
        const s = (t - anchorX) / (signX * r.width); return s >= minScale && s <= maxScale;
      }), threshold);
      const sy = nearest([anchorY + signY * r.height * scale], targets.y.filter(t => {
        const s = (t - anchorY) / (signY * r.height); return s >= minScale && s <= maxScale;
      }), threshold);
      if (sx && (!sy || Math.abs(sx.delta) <= Math.abs(sy.delta))) scale += sx.delta / (signX * r.width);
      else if (sy) scale += sy.delta / (signY * r.height);
      scale = clamp(scale, minScale, maxScale);
    }
    width = r.width * scale; height = r.height * scale;
  } else {
    // Edges change only one dimension. The image is stretched, never cropped.
    if (horizontal) {
      width = clamp(r.width + signX * dx, Math.min(16, maxW), maxW);
      const sx = snap && nearest([anchorX + signX * width], targets.x.filter(t => (t - anchorX) * signX >= Math.min(16, maxW) && (t - anchorX) * signX <= maxW), threshold);
      if (sx) width += signX * sx.delta;
    }
    if (vertical) {
      height = clamp(r.height + signY * dy, Math.min(16, maxH), maxH);
      const sy = snap && nearest([anchorY + signY * height], targets.y.filter(t => (t - anchorY) * signY >= Math.min(16, maxH) && (t - anchorY) * signY <= maxH), threshold);
      if (sy) height += signY * sy.delta;
    }
  }
  const rect = { x: west ? anchorX - width : r.x, y: north ? anchorY - height : r.y, width, height };
  if (snap && horizontal) guides.x = nearest([west ? rect.x : rect.x + rect.width], targets.x, 0.01)?.target;
  if (snap && vertical) guides.y = nearest([north ? rect.y : rect.y + rect.height], targets.y, 0.01)?.target;
  return { rect, guides };
}
