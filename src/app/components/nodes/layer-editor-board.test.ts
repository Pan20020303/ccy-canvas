import { describe, expect, it } from 'vitest';
import { boardExport, boardUnits, contentBounds, fitBoardView, sourceRect, zoomBoard } from './layer-editor-board';
import { applyLayerCrop, layerRect, transformLayerRect } from './layer-editor-geometry';
import { FULL_CROP } from './layer-editor-crop';

const units = { width: 800, height: 450 };
const layer = { id: 'a', image: '/a.png', xPct: 0.5, yPct: 0.5, wPct: 0.5, aspect: 2 };

describe('free artboard coordinates and export', () => {
  it('migrates legacy ratios once and prefers stable units after saving', () => {
    expect(boardUnits({ ratio: '9:16' })).toEqual({ width: 900, height: 1600 });
    expect(boardUnits({ ratio: '16:9' })).toEqual({ width: 1600, height: 900 });
    expect(boardUnits({ ratio: '1:1' })).toEqual({ width: 1600, height: 1600 });
    expect(boardUnits({ ratio: 'broken' })).toEqual({ width: 1600, height: 900 });
    expect(boardUnits({ ratio: '9:16', boardSize: units })).toEqual(units);
    expect(boardUnits({ boardSize: { width: NaN, height: 0 } })).toEqual({ width: 1600, height: 900 });
  });
  it('exports all content including negative and offscreen locations without old-frame padding', () => {
    const left = { ...layer, xPct: -0.5 }, right = { ...layer, xPct: 1.5, yPct: 2 };
    expect(contentBounds([left, right], units)).toEqual({ x: -600, y: 125, width: 2000, height: 875 });
    const output = boardExport([left, right], units);
    expect(output).toEqual({ bounds: { x: -600, y: 125, width: 2000, height: 875 }, scale: 0.8, width: 1600, height: 700 });
    expect(boardExport([layer], units)).toEqual({ bounds: { x: 200, y: 125, width: 400, height: 200 }, scale: 4, width: 1600, height: 800 });
  });
  it('fits arbitrary content inside the available viewport and never changes world coordinates', () => {
    const bounds = { x: -10000, y: -5000, width: 4000, height: 2400 };
    const view = fitBoardView(bounds, { width: 1200, height: 800 });
    expect(view.scale).toBe(0.21);
    expect(view.x + bounds.x * view.scale).toBeCloseTo(80);
    expect(view.x + (bounds.x + bounds.width) * view.scale).toBeCloseTo(920);
    expect(view.y + bounds.y * view.scale).toBeGreaterThanOrEqual(100);
    expect(view.y + (bounds.y + bounds.height) * view.scale).toBeLessThanOrEqual(700);
  });
  it('zooms around the cursor and clamps magnification without moving the anchored point', () => {
    const view = { x: -250, y: 120, scale: 0.5 };
    for (const scale of [0.01, 0.5, 2, 10]) {
      const next = zoomBoard(view, scale, 333, 444);
      expect((333 - next.x) / next.scale).toBeCloseTo((333 - view.x) / view.scale);
      expect((444 - next.y) / next.scale).toBeCloseTo((444 - view.y) / view.scale);
      expect(next.scale).toBeGreaterThanOrEqual(0.02); expect(next.scale).toBeLessThanOrEqual(4);
    }
  });
  it('allows independent resizing and moving past every former frame boundary', () => {
    const start = layerRect(layer, units), targets = { x: [], y: [] };
    const move = transformLayerRect(start, 'move', -1500, 2000, units, targets, false, 7, false).rect;
    expect(move).toEqual({ x: -1300, y: 2125, width: 400, height: 200 });
    const west = transformLayerRect(start, 'w', -1000, 0, units, targets, false, 7, false).rect;
    expect(west.x + west.width).toBe(600); expect(west.width).toBe(1400); expect(west.height).toBe(200);
    const sw = transformLayerRect(start, 'sw', -800, 400, units, targets, false, 7, false).rect;
    expect(sw).toEqual({ x: -600, y: 125, width: 1200, height: 600 });
  });
  it('restores the entire original in place after cropping, even outside legacy bounds', () => {
    const original = { ...layer, xPct: -1, wPct: 3, hPct: 2 };
    const cropped = applyLayerCrop(original, { x: 0.2, y: 0.1, width: 0.5, height: 0.6 }, units, false);
    expect(sourceRect(cropped, units)).toEqual(layerRect(original, units));
    const restored = applyLayerCrop(cropped, FULL_CROP, units, false);
    expect(layerRect(restored, units)).toEqual(layerRect(original, units));
    expect(boardExport([restored], units).width).toBe(1600);
    expect(boardExport([restored], units).height).toBe(600);
  });
  it('uses visible crop dimensions for export without a fractional extra pixel', () => {
    const cropped = applyLayerCrop(layer, { x: 0.1, y: 0.2, width: 0.123456, height: 0.54321 }, units, false);
    const output = boardExport([cropped], units);
    expect(output.height).toBe(1600); expect(output.width).toBeLessThan(1600);
  });
});
