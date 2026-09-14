import { describe, expect, it } from 'vitest';

import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  canvasViewportStorageKey,
  readCanvasViewport,
  writeCanvasViewport,
} from './canvas-viewport';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('canvas viewport persistence', () => {
  it('stores independent pan and zoom values for every project', () => {
    const storage = memoryStorage();
    writeCanvasViewport('project-a', { x: -1820.5, y: 440, zoom: 0.45 }, storage);
    writeCanvasViewport('project-b', { x: 25, y: -80, zoom: 1.25 }, storage);

    expect(readCanvasViewport('project-a', storage)).toEqual({ x: -1820.5, y: 440, zoom: 0.45 });
    expect(readCanvasViewport('project-b', storage)).toEqual({ x: 25, y: -80, zoom: 1.25 });
    expect(canvasViewportStorageKey('project/a')).not.toBe(canvasViewportStorageKey('project-a'));
  });

  it('rejects corrupt coordinates and clamps stale zoom values to canvas limits', () => {
    const storage = memoryStorage();
    storage.setItem(canvasViewportStorageKey('broken'), JSON.stringify({ x: 'oops', y: 0, zoom: 1 }));
    storage.setItem(canvasViewportStorageKey('too-small'), JSON.stringify({ x: 1, y: 2, zoom: 0.001 }));
    storage.setItem(canvasViewportStorageKey('too-large'), JSON.stringify({ x: 1, y: 2, zoom: 12 }));

    expect(readCanvasViewport('broken', storage)).toBeNull();
    expect(readCanvasViewport('too-small', storage)?.zoom).toBe(CANVAS_MIN_ZOOM);
    expect(readCanvasViewport('too-large', storage)?.zoom).toBe(CANVAS_MAX_ZOOM);
  });

  it('fails safely when browser storage is unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };

    expect(readCanvasViewport('project-a', storage)).toBeNull();
    expect(writeCanvasViewport('project-a', { x: 0, y: 0, zoom: 1 }, storage)).toBe(false);
  });
});
