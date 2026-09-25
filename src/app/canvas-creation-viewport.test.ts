import { describe, expect, it } from 'vitest';
import { clampCanvasMenu, revealPanDelta, unionScreenBounds } from './canvas-creation-viewport';

describe('canvas creation viewport', () => {
  it('keeps a tall menu visible when the connection ends past the canvas edge', () => {
    expect(clampCanvasMenu({ x: 1400, y: 900 }, { width: 1226, height: 816 }, { width: 230, height: 510 }))
      .toEqual({ x: 988, y: 298 });
    expect(clampCanvasMenu({ x: -50, y: -20 }, { width: 1226, height: 816 }, { width: 230, height: 510 }))
      .toEqual({ x: 8, y: 8 });
  });

  it('pans just enough to show both the created node and its floating composer', () => {
    const node = { left: 600, top: 735, right: 900, bottom: 900 };
    const composer = { left: 430, top: 916, right: 1070, bottom: 1200 };
    expect(revealPanDelta(unionScreenBounds(node, composer), { width: 1226, height: 816 }))
      .toEqual({ x: 0, y: -464 });
  });

  it('centers content that is larger than the available viewport', () => {
    expect(revealPanDelta({ left: 0, top: 0, right: 640, bottom: 700 }, { width: 500, height: 400 }))
      .toEqual({ x: -70, y: -158 });
  });
});
