import { describe, expect, it, vi } from 'vitest';

import {
  buildCanvasClipboardSelection,
  remapClipboardSelectionForPaste,
} from './canvas-clipboard';

describe('canvas clipboard helpers', () => {
  it('copies only selected nodes and internal edges', () => {
    const selection = buildCanvasClipboardSelection({
      nodes: [
        { id: 'a', selected: true, position: { x: 10, y: 20 }, data: {} },
        { id: 'b', selected: true, position: { x: 40, y: 80 }, data: {} },
        { id: 'c', selected: false, position: { x: 90, y: 120 }, data: {} },
      ] as never,
      edges: [
        { id: 'ab', source: 'a', target: 'b' },
        { id: 'ac', source: 'a', target: 'c' },
      ] as never,
    });

    expect(selection?.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(selection?.edges.map((edge) => edge.id)).toEqual(['ab']);
  });

  it('remaps nodes and internal edges on paste', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);

    const remapped = remapClipboardSelectionForPaste({
      selection: {
        nodes: [
          { id: 'a', selected: true, position: { x: 10, y: 20 }, data: {} },
          { id: 'b', selected: true, position: { x: 40, y: 80 }, data: {} },
        ] as never,
        edges: [{ id: 'ab', source: 'a', target: 'b' }] as never,
      },
      offset: { x: 48, y: 48 },
    });

    expect(remapped.nodes).toHaveLength(2);
    expect(remapped.nodes.map((node) => node.position)).toEqual([
      { x: 58, y: 68 },
      { x: 88, y: 128 },
    ]);
    expect(remapped.nodes.every((node) => node.selected === true)).toBe(true);
    expect(remapped.edges).toHaveLength(1);
    expect(remapped.edges[0]?.source).toBe(remapped.nodes[0]?.id);
    expect(remapped.edges[0]?.target).toBe(remapped.nodes[1]?.id);
  });
});
