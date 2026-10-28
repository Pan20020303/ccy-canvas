import { describe, expect, it } from 'vitest';
import type { Node, NodeChange, NodePositionChange } from '@xyflow/react';
import { snapCanvasChanges, type CanvasSnapOptions } from './canvas-snapping';

const node = (id: string, x: number, y: number, selected = false): Node => ({
  id, position: { x, y }, width: 100, height: 100, selected, data: {},
});
const position = (id: string, x: number, y: number, dragging = true): NodePositionChange => ({
  type: 'position', id, position: { x, y }, dragging,
});
const defaults: CanvasSnapOptions = { enabled: true, showGuides: true, strength: 3, gridGap: 24, zoom: 1 };
const moving = node('moving', 0, 0);
const target = node('target', 100, 400);
function resolve(change: NodePositionChange, options: Partial<CanvasSnapOptions> = {}, others = [target]) {
  return snapCanvasChanges([change], [moving, ...others], { ...defaults, ...options });
}
const firstPosition = (result: ReturnType<typeof snapCanvasChanges>) => (result.changes[0] as NodePositionChange).position;

describe('one master switch for canvas snapping', () => {
  it.each([true, false])('does not move nodes with guides enabled when snapping is off (dragging=%s)', dragging => {
    const changes = [position('moving', 98, 73, dragging)];
    const result = snapCanvasChanges(changes, [moving, target], { ...defaults, enabled: false });
    expect(result.changes).toBe(changes);
    expect(result.guides).toEqual([]);
    expect(firstPosition(result)).toEqual({ x: 98, y: 73 });
  });
  it('does not snap non-drag programmatic moves or dimension changes', () => {
    const changes: NodeChange[] = [
      { type: 'position', id: 'moving', position: { x: 98, y: 73 } },
      { type: 'dimensions', id: 'moving', dimensions: { width: 120, height: 120 } },
    ];
    expect(snapCanvasChanges(changes, [moving, target], defaults).changes).toBe(changes);
  });
  it('keeps guide visibility separate from actual attraction', () => {
    const visible = resolve(position('moving', 98, 73));
    const hidden = resolve(position('moving', 98, 73), { showGuides: false });
    expect(firstPosition(visible)).toEqual({ x: 100, y: 73 });
    expect(visible.guides.length).toBeGreaterThan(0);
    expect(firstPosition(hidden)).toEqual(firstPosition(visible));
    expect(hidden.guides).toEqual([]);
  });
});

describe('soft configurable screen-pixel attraction', () => {
  it('weak snapping leaves the pointer position alone while a stronger setting engages', () => {
    expect(firstPosition(resolve(position('moving', 96, 73), { strength: 2 }))).toEqual({ x: 96, y: 73 });
    expect(firstPosition(resolve(position('moving', 96, 73), { strength: 6 }))).toEqual({ x: 100, y: 73 });
  });
  it.each([0.37, 0.65, 1, 2, 4])('uses the same screen radius at zoom %s', zoom => {
    const inside = 100 - 2 / zoom, outside = 100 - 4 / zoom;
    expect(firstPosition(resolve(position('moving', inside, 73), { zoom }))?.x).toBeCloseTo(100);
    expect(firstPosition(resolve(position('moving', outside, 73), { zoom }))?.x).toBeCloseTo(outside);
  });
  it('does not quantize motion to the grid during dragging', () => {
    expect(firstPosition(resolve(position('moving', 25, 37), {}, []))).toEqual({ x: 25, y: 37 });
  });
  it('snaps only nearby grid axes on release instead of jumping half a cell', () => {
    const result = resolve(position('moving', 25, 37, false), {}, []);
    expect(firstPosition(result)).toEqual({ x: 24, y: 37 });
    expect(result.guides).toEqual([]);
    expect(firstPosition(resolve(position('moving', 29, 37, false), {}, []))).toEqual({ x: 29, y: 37 });
    expect(firstPosition(resolve(position('moving', 29, 37, false), { strength: 6 }, []))).toEqual({ x: 24, y: 37 });
  });
  it('respects negative coordinates and the screen radius when snapping to the grid', () => {
    expect(firstPosition(resolve(position('moving', -25, -37, false), {}, []))).toEqual({ x: -24, y: -37 });
    expect(firstPosition(resolve(position('moving', 26, 37, false), { zoom: 2 }, []))).toEqual({ x: 26, y: 37 });
  });
  it('keeps a perfect object alignment on release even when the grid is nearby', () => {
    expect(firstPosition(resolve(position('moving', 100, 73, false), { strength: 6 }))).toEqual({ x: 100, y: 72 });
  });
  it('does not create non-finite positions from invalid grid/zoom settings', () => {
    expect(firstPosition(resolve(position('moving', 25, 37, false), { zoom: NaN, gridGap: 0, strength: NaN }, []))).toEqual({ x: 25, y: 37 });
  });
});

describe('multi-node dragging', () => {
  it('moves co-dragged nodes by the same delta and never chases another moving node', () => {
    const a = node('a', 0, 0, true), b = node('b', 250, 0, true);
    const changes = [position('a', 98, 73), position('b', 348, 73)];
    const result = snapCanvasChanges(changes, [a, b, target], defaults);
    expect(result.changes).toMatchObject([
      { position: { x: 100, y: 73 } }, { position: { x: 350, y: 73 } },
    ]);
    const withoutTarget = snapCanvasChanges(changes, [a, b], defaults);
    expect(withoutTarget.changes).toBe(changes);
  });
  it('passes selection-only events through without changing history or position', () => {
    const changes: NodeChange[] = [{ type: 'select', id: 'moving', selected: true }];
    expect(snapCanvasChanges(changes, [moving, target], defaults).changes).toBe(changes);
  });
});
