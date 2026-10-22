/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasViewportKey, readCanvasViewport, useCanvasViewportMemory } from './canvas-viewport';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
let memory: ReturnType<typeof useCanvasViewportMemory>;
const key = canvasViewportKey('user-1', 'canvas-1')!;
const view = { x: -1324.25, y: 892.5, zoom: .37 };
function Harness({ storageKey = key, ready = true }: { storageKey?: string | null; ready?: boolean }) {
  memory = useCanvasViewportMemory(storageKey, ready);
  return null;
}
const render = async (storageKey: string | null = key, ready = true) => act(async () => root.render(<Harness key={storageKey} storageKey={storageKey} ready={ready} />));
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('canvas viewport memory', () => {
  it('restores exact translation and zoom without a competing fitView', async () => {
    localStorage.setItem(key, JSON.stringify(view)); await render();
    expect(memory.defaultViewport).toEqual(view); expect(memory.fitView).toBe(false);
  });
  it('fits only when there is no saved record and does not write on mount', async () => {
    await render(); expect(memory.fitView).toBe(true); expect(readCanvasViewport(key)).toBeNull();
  });
  it('flushes gesture ends and throttles a continuous drag', async () => {
    await render(); memory.onMove(null, view); expect(readCanvasViewport(key)).toBeNull();
    await act(async () => vi.advanceTimersByTime(250)); expect(readCanvasViewport(key)).toEqual(view);
    const final = { ...view, zoom: 1.35 }; memory.onMoveEnd(null, final); expect(readCanvasViewport(key)).toEqual(final);
  });
  it('saves the latest in-flight position on pagehide', async () => {
    await render(); memory.onMove(null, view); window.dispatchEvent(new Event('pagehide'));
    expect(readCanvasViewport(key)).toEqual(view);
  });
  it('saves an outgoing project separately and never records its stale nodes for the next', async () => {
    const nextKey = canvasViewportKey('user-1', 'canvas-2')!;
    await render(); memory.onMove(null, view);
    await render(nextKey, false);
    expect(readCanvasViewport(key)).toEqual(view); expect(memory.fitView).toBe(true);
    memory.onMoveEnd(null, { x: 0, y: 0, zoom: 4 }); expect(readCanvasViewport(nextKey)).toBeNull();
    await render(nextKey, true); memory.onMoveEnd(null, { x: 50, y: 20, zoom: .8 });
    await render(key); expect(memory.defaultViewport).toEqual(view);
    expect(readCanvasViewport(nextKey)).toEqual({ x: 50, y: 20, zoom: .8 });
  });
  it('isolates users and ignores anonymous/unbound canvases', async () => {
    localStorage.setItem(key, JSON.stringify(view)); await render(canvasViewportKey('user-2', 'canvas-1'));
    expect(memory.fitView).toBe(true); expect(canvasViewportKey(null, 'canvas-1')).toBeNull();
    await render(null); memory.onMoveEnd(null, view); expect(localStorage.length).toBe(1);
    expect(canvasViewportKey('a:b', 'c')).not.toBe(canvasViewportKey('a', 'b:c'));
  });
  it('rejects corrupt data and non-finite coordinates and clamps obsolete zoom ranges', () => {
    for (const value of ['{broken', 'null', '[]', '{"x":0,"y":0,"zoom":0}', '{"x":"0","y":0,"zoom":1}', '{"x":1e999,"y":0,"zoom":1}']) {
      localStorage.setItem(key, value); expect(readCanvasViewport(key)).toBeNull();
    }
    localStorage.setItem(key, JSON.stringify({ x: 0, y: 0, zoom: 8 })); expect(readCanvasViewport(key)?.zoom).toBe(4);
  });
  it('survives denied or full storage without breaking the canvas', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await render(); expect(memory.fitView).toBe(true); expect(() => memory.onMoveEnd(null, view)).not.toThrow();
  });
  it('does not overwrite a saved viewport if closed before hydration', async () => {
    localStorage.setItem(key, JSON.stringify(view)); await render(key, false);
    memory.onMoveEnd(null, { x: 0, y: 0, zoom: 1 }); window.dispatchEvent(new Event('pagehide'));
    expect(readCanvasViewport(key)).toEqual(view);
  });
  it('does not overwrite a newer tab when an idle older tab is hidden', async () => {
    await render(); memory.onMoveEnd(null, view);
    const newer = { x: 8, y: 50, zoom: .8 }; localStorage.setItem(key, JSON.stringify(newer));
    window.dispatchEvent(new Event('pagehide')); expect(readCanvasViewport(key)).toEqual(newer);
  });
});
