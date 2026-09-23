import type { LayerEditorData, LayerEditorLayer } from './LayerEditorNode';
import { layerRect, type LayerBounds, type LayerRect } from './layer-editor-geometry';
import { normalizeCrop } from './layer-editor-crop';

export type BoardView = { x: number; y: number; scale: number };
/** Normalized legacy coordinates need a stable unit space, not a visible/export frame. */
export function boardUnits(data: LayerEditorData): LayerBounds {
  if (data.boardSize && Number.isFinite(data.boardSize.width) && Number.isFinite(data.boardSize.height) && data.boardSize.width > 0 && data.boardSize.height > 0) return data.boardSize;
  const [w, h] = (data.ratio || '16:9').split(':').map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 16 / 9;
  return ratio >= 1 ? { width: 1600, height: 1600 / ratio } : { width: 1600 * ratio, height: 1600 };
}

export function contentBounds(layers: LayerEditorLayer[], units: LayerBounds): LayerRect {
  if (!layers.length) return { x: 0, y: 0, ...units };
  const rects = layers.map(layer => layerRect(layer, units));
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
}

export function sourceRect(layer: LayerEditorLayer, units: LayerBounds): LayerRect {
  const r = layerRect(layer, units), c = normalizeCrop(layer.crop);
  const width = r.width / c.width, height = r.height / c.height;
  return { x: r.x - c.x * width, y: r.y - c.y * height, width, height };
}

export function fitBoardView(bounds: LayerRect, viewport: LayerBounds): BoardView {
  const availableWidth = Math.max(100, viewport.width - 360), availableHeight = Math.max(100, viewport.height - 200);
  const scale = Math.max(0.02, Math.min(1, availableWidth / bounds.width, availableHeight / bounds.height));
  return { x: 80 + availableWidth / 2 - (bounds.x + bounds.width / 2) * scale, y: viewport.height / 2 - (bounds.y + bounds.height / 2) * scale, scale };
}

export function zoomBoard(view: BoardView, scale: number, x: number, y: number): BoardView {
  const next = Math.max(0.02, Math.min(4, scale)), ratio = next / view.scale;
  return { x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio, scale: next };
}

/** Export all content, including negative/offscreen positions. Screen pan/zoom never enters here. */
export function boardExport(layers: LayerEditorLayer[], units: LayerBounds) {
  const bounds = contentBounds(layers, units), scale = 1600 / Math.max(bounds.width, bounds.height);
  return { bounds, scale, width: Math.max(1, Math.ceil(bounds.width * scale - 1e-8)), height: Math.max(1, Math.ceil(bounds.height * scale - 1e-8)) };
}
