import type { LayerHandle } from './layer-editor-geometry';

/** Normalized source-image coordinates; the original URL is never replaced. */
export type LayerCrop = { x: number; y: number; width: number; height: number };
export const FULL_CROP: LayerCrop = { x: 0, y: 0, width: 1, height: 1 };
const MIN = 0.01;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const finite = (n: number | undefined, fallback: number) => n !== undefined && Number.isFinite(n) ? n : fallback;

export function normalizeCrop(crop?: LayerCrop): LayerCrop {
  const width = clamp(finite(crop?.width, 1), MIN, 1);
  const height = clamp(finite(crop?.height, 1), MIN, 1);
  return { x: clamp(finite(crop?.x, 0), 0, 1 - width), y: clamp(finite(crop?.y, 0), 0, 1 - height), width, height };
}

export function croppedAspect(aspect: number, crop?: LayerCrop) {
  const c = normalizeCrop(crop);
  return (Number.isFinite(aspect) && aspect > 0 ? aspect : 1) * c.width / c.height;
}

/** Largest centered rectangle inside the current crop at the requested image-space ratio. */
export function cropAtRatio(crop: LayerCrop, sourceAspect: number, ratio: number): LayerCrop {
  const c = normalizeCrop(crop), normalizedRatio = ratio / sourceAspect;
  if (!Number.isFinite(normalizedRatio) || normalizedRatio <= 0) return c;
  const width = Math.min(c.width, c.height * normalizedRatio), height = width / normalizedRatio;
  return normalizeCrop({ x: c.x + (c.width - width) / 2, y: c.y + (c.height - height) / 2, width, height });
}

/** Free cropping changes edges, not image scale. Locked sides resize about the perpendicular center. */
export function transformCrop(start: LayerCrop, mode: 'move' | LayerHandle, dx: number, dy: number, ratio?: number): LayerCrop {
  const c = normalizeCrop(start);
  if (mode === 'move') return { ...c, x: clamp(c.x + dx, 0, 1 - c.width), y: clamp(c.y + dy, 0, 1 - c.height) };
  const w = mode.includes('w'), e = mode.includes('e'), n = mode.includes('n'), s = mode.includes('s');
  let left = c.x, right = c.x + c.width, top = c.y, bottom = c.y + c.height;
  if (w) left = clamp(left + dx, 0, right - MIN);
  if (e) right = clamp(right + dx, left + MIN, 1);
  if (n) top = clamp(top + dy, 0, bottom - MIN);
  if (s) bottom = clamp(bottom + dy, top + MIN, 1);
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return normalizeCrop({ x: left, y: top, width: right - left, height: bottom - top });
  const horizontal = w || e, vertical = n || s;
  const anchorX = w ? c.x + c.width : e ? c.x : c.x + c.width / 2;
  const anchorY = n ? c.y + c.height : s ? c.y : c.y + c.height / 2;
  const maxWidth = horizontal ? (w ? anchorX : 1 - anchorX) : 2 * Math.min(anchorX, 1 - anchorX);
  const maxHeight = vertical ? (n ? anchorY : 1 - anchorY) : 2 * Math.min(anchorY, 1 - anchorY);
  const widthDriven = horizontal && (!vertical || Math.abs(dx / c.width) >= Math.abs(dy / c.height));
  const max = Math.min(maxWidth, maxHeight * ratio);
  const width = clamp(widthDriven ? right - left : (bottom - top) * ratio, Math.min(max, Math.max(MIN, MIN * ratio)), max);
  const height = width / ratio;
  return { x: w ? anchorX - width : e ? anchorX : anchorX - width / 2, y: n ? anchorY - height : s ? anchorY : anchorY - height / 2, width, height };
}
