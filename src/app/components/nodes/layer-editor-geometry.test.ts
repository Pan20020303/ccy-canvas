import { describe, expect, it } from 'vitest';
import { fitLayerRect, layerRect, layerSnapTargets, rectToLayer, reframeLayer, transformLayerRect, type LayerHandle } from './layer-editor-geometry';

const canvas = { width: 1000, height: 600 };
const start = { x: 100, y: 100, width: 200, height: 100 };
const targets = layerSnapTargets(canvas, []);
const transform = (mode: 'move' | LayerHandle, dx: number, dy: number, snap = false) => transformLayerRect(start, mode, dx, dy, canvas, targets, snap);

describe('layer editor anchored resize and snapping', () => {
  it.each([
    ['se', 100, 50, { x: 100, y: 100, width: 300, height: 150 }],
    ['sw', -100, 50, { x: 0, y: 100, width: 300, height: 150 }],
    ['nw', -50, -25, { x: 50, y: 75, width: 250, height: 125 }],
    ['ne', 100, -50, { x: 100, y: 50, width: 300, height: 150 }],
  ] as const)('%s keeps the opposite corner fixed', (mode, dx, dy, expected) => {
    expect(transform(mode, dx, dy).rect).toEqual(expected);
  });
  it.each([
    ['e', 100, 100, { x: 100, y: 100, width: 300, height: 100 }],
    ['w', -50, 100, { x: 50, y: 100, width: 250, height: 100 }],
    ['n', 100, -50, { x: 100, y: 50, width: 200, height: 150 }],
    ['s', 100, 50, { x: 100, y: 100, width: 200, height: 150 }],
  ] as const)('%s changes only its own axis', (mode, dx, dy, expected) => {
    expect(transform(mode, dx, dy).rect).toEqual(expected);
  });
  it('corners respond to vertical movement as well as horizontal movement', () => {
    expect(transform('se', 0, 50).rect).toEqual({ x: 100, y: 100, width: 300, height: 150 });
  });
  it('snaps moving edges and centers to the canvas', () => {
    expect(transform('move', -96, -95, true)).toEqual({ rect: { ...start, x: 0, y: 0 }, guides: { x: 0, y: 0 } });
    expect(transform('move', 294, 147, true)).toEqual({ rect: { ...start, x: 400, y: 250 }, guides: { x: 500, y: 300 } });
  });
  it('snaps to another layer and returns its guide position', () => {
    const others = layerSnapTargets(canvas, [{ x: 650, y: 350, width: 100, height: 100 }]);
    const result = transformLayerRect(start, 'move', 346, 0, canvas, others);
    expect(result.rect.x + result.rect.width).toBe(650); expect(result.guides.x).toBe(650);
  });
  it('can bypass snapping without bypassing canvas boundaries', () => {
    expect(transform('move', -96, 0, false).rect.x).toBe(4);
    expect(transform('move', -3000, 3000, false)).toEqual({ rect: { ...start, x: 0, y: 500 }, guides: {} });
  });
  it('snaps only the moving resize edges and preserves anchored corners', () => {
    expect(transform('e', 195, 0, true)).toEqual({ rect: { ...start, width: 400 }, guides: { x: 500 } });
    const result = transform('se', 194, 97, true);
    expect(result.rect).toEqual({ ...start, width: 400, height: 200 }); expect(result.guides).toEqual({ x: 500, y: 300 });
  });
  it('bounds corner scaling by both the horizontal and vertical limits', () => {
    const result = transform('nw', -10000, -10000).rect;
    expect(result).toEqual({ x: 0, y: 50, width: 300, height: 150 });
    expect(result.x + result.width).toBe(start.x + start.width);
    expect(result.y + result.height).toBe(start.y + start.height);
  });
  it('does not flip an image when dragging past its opposite edge', () => {
    const result = transform('w', 9000, 0).rect;
    expect(result.width).toBe(16); expect(result.x + result.width).toBe(300);
  });
  it('fits oversized old layers without distorting or cutting them', () => {
    const rect = fitLayerRect({ x: -800, y: -400, width: 2000, height: 1000 }, canvas);
    expect(rect).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
  });
  it('roundtrips independent width/height for preview, persistence and PNG export', () => {
    const layer = { id: 'one', image: '/one.png', xPct: 0.5, yPct: 0.5, wPct: 0.5, aspect: 2 };
    const changed = rectToLayer(layer, { x: 100, y: 200, width: 300, height: 250 }, canvas);
    expect(layerRect(changed, canvas)).toEqual({ x: 100, y: 200, width: 300, height: 250 });
    expect(layerRect(JSON.parse(JSON.stringify(changed)), { width: 2000, height: 1200 })).toEqual({ x: 200, y: 400, width: 600, height: 500 });
  });
  it('preserves displayed aspect and all content when changing portrait/landscape canvas', () => {
    const layer = { id: 'one', image: '/one.png', xPct: 0.5, yPct: 0.5, wPct: 0.8, hPct: 0.9, aspect: 2 };
    const before = layerRect(layer, { width: 9 / 16, height: 1 });
    const after = layerRect(reframeLayer(layer, 9 / 16, 16 / 9), { width: 16 / 9, height: 1 });
    expect(after.width / after.height).toBeCloseTo(before.width / before.height);
    expect(after.height).toBeLessThanOrEqual(1); expect(after.y).toBeGreaterThanOrEqual(0);
    expect(after.x).toBeGreaterThanOrEqual(0); expect(after.x + after.width).toBeLessThanOrEqual(16 / 9);
  });
  it('never moves an anchor or crosses canvas bounds over a range of drag directions', () => {
    for (const mode of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const) {
      for (const snap of [true, false]) for (const dx of [-2000, -280, -97, 0, 83, 600, 2000]) for (const dy of [-2000, -97, 0, 53, 600, 2000]) {
        const r = transform(mode, dx, dy, snap).rect;
        expect(r.x).toBeGreaterThanOrEqual(-1e-8); expect(r.y).toBeGreaterThanOrEqual(-1e-8);
        expect(r.width).toBeGreaterThan(0); expect(r.height).toBeGreaterThan(0);
        expect(r.x + r.width).toBeLessThanOrEqual(canvas.width + 1e-8); expect(r.y + r.height).toBeLessThanOrEqual(canvas.height + 1e-8);
        if (mode.includes('w')) expect(r.x + r.width).toBeCloseTo(300); else expect(r.x).toBeCloseTo(100);
        if (mode.includes('n')) expect(r.y + r.height).toBeCloseTo(200); else expect(r.y).toBeCloseTo(100);
        if (mode.length === 2) expect(r.width / r.height).toBeCloseTo(2);
      }
    }
  });
});
