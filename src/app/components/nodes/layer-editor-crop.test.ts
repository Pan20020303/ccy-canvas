import { describe, expect, it } from 'vitest';
import { applyLayerCrop, layerRect, reframeLayer } from './layer-editor-geometry';
import { cropAtRatio, croppedAspect, FULL_CROP, normalizeCrop, transformCrop } from './layer-editor-crop';

describe('non-destructive layer cropping', () => {
  const layer = { id: 'one', image: '/original.png', aspect: 2, xPct: 0.5, yPct: 0.5, wPct: 0.5 };
  const canvas = { width: 800, height: 450 };
  it('normalizes malformed saved crops and preserves uncropped legacy layers', () => {
    expect(normalizeCrop()).toEqual(FULL_CROP);
    expect(normalizeCrop({ x: -1, y: 3, width: NaN, height: Infinity })).toEqual(FULL_CROP);
    expect(normalizeCrop({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 })).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    expect(croppedAspect(2)).toBe(2);
  });
  it('trims in place without scaling, replacing the source URL or changing its aspect', () => {
    const crop = { x: 0.25, y: 0.1, width: 0.5, height: 0.8 };
    const result = applyLayerCrop(layer, crop, canvas);
    expect(result.image).toBe(layer.image); expect(result.aspect).toBe(layer.aspect); expect(result.crop).toEqual(crop);
    expect(layerRect(result, canvas)).toEqual({ x: 300, y: 145, width: 200, height: 160 });
    expect(layer).not.toHaveProperty('crop');
    const restored = applyLayerCrop(result, FULL_CROP, canvas);
    expect(layerRect(restored, canvas)).toEqual(layerRect(layer, canvas));
  });
  it('recrops from the full source rather than destructively cropping the previous output', () => {
    const first = applyLayerCrop(layer, { x: 0.3, y: 0.2, width: 0.5, height: 0.6 }, canvas);
    const next = { x: 0.1, y: 0.1, width: 0.7, height: 0.8 };
    const sequential = layerRect(applyLayerCrop(first, next, canvas), canvas);
    const direct = layerRect(applyLayerCrop(layer, next, canvas), canvas);
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(sequential[k]).toBeCloseTo(direct[k]);
  });
  it('preserves edge stretching when cropping, and keeps restored/moved crops inside the canvas', () => {
    const stretched = { ...layer, hPct: 0.8 };
    const cropped = applyLayerCrop(stretched, { x: 0, y: 0.25, width: 0.5, height: 0.5 }, canvas);
    expect(layerRect(cropped, canvas).width).toBe(200); expect(layerRect(cropped, canvas).height).toBe(180);
    const enlarged = { ...cropped, xPct: 0.1, yPct: 0.1, wPct: 0.9, hPct: 0.9 };
    const r = layerRect(applyLayerCrop(enlarged, FULL_CROP, canvas), canvas);
    expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(800); expect(r.y + r.height).toBeLessThanOrEqual(450);
  });
  it('keeps the source window and visible aspect through canvas ratio changes', () => {
    const cropped = applyLayerCrop(layer, { x: 0.25, y: 0, width: 0.5, height: 1 }, canvas);
    const framed = reframeLayer(cropped, 16 / 9, 9 / 16);
    expect(framed.crop).toEqual(cropped.crop);
    const rect = layerRect(framed, { width: 9, height: 16 });
    expect(rect.width / rect.height).toBeCloseTo(1);
    expect(croppedAspect(layer.aspect, cropped.crop)).toBe(1);
  });
  it.each([1, 4 / 3, 3 / 4, 16 / 9, 9 / 16])('selects a centered fixed ratio %s from the original', ratio => {
    const c = cropAtRatio(FULL_CROP, 2, ratio);
    expect(croppedAspect(2, c)).toBeCloseTo(ratio);
    expect(c.x + c.width / 2).toBeCloseTo(0.5); expect(c.y + c.height / 2).toBeCloseTo(0.5);
  });
  it('adjusts free corners independently and prevents flipping or leaving the image', () => {
    const corner = transformCrop(FULL_CROP, 'nw', 0.2, 0.3);
    expect(corner.x).toBeCloseTo(0.2); expect(corner.y).toBeCloseTo(0.3);
    expect(corner.width).toBeCloseTo(0.8); expect(corner.height).toBeCloseTo(0.7);
    expect(transformCrop(FULL_CROP, 'w', 2, 0).width).toBeCloseTo(0.01);
    expect(transformCrop({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, 'move', 5, -5)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });
  it('keeps all eight locked/free handles inside the source across large drags', () => {
    for (const ratio of [undefined, 0.5, 1, 2]) for (const mode of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      const start = ratio ? cropAtRatio({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, 1, ratio) : { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
      for (const dx of [-5, -0.2, 0, 0.2, 5]) for (const dy of [-5, -0.2, 0, 0.2, 5]) {
        const c = transformCrop(start, mode, dx, dy, ratio);
        expect(c.x).toBeGreaterThanOrEqual(-1e-9); expect(c.y).toBeGreaterThanOrEqual(-1e-9);
        expect(c.x + c.width).toBeLessThanOrEqual(1 + 1e-9); expect(c.y + c.height).toBeLessThanOrEqual(1 + 1e-9);
        expect(c.width).toBeGreaterThan(0); expect(c.height).toBeGreaterThan(0);
        if (ratio) expect(c.width / c.height).toBeCloseTo(ratio);
      }
    }
  });
});
