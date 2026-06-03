import { describe, expect, it } from 'vitest';

import {
  buildBulkInboundEdges,
  buildBulkOutboundEdges,
  computeGroupBounds,
} from './group-routing';

describe('group routing helpers', () => {
  it('computes padded bounds around member nodes', () => {
    const bounds = computeGroupBounds([
      { id: 'a', position: { x: 100, y: 120 }, width: 200, height: 160 },
      { id: 'b', position: { x: 360, y: 220 }, width: 180, height: 140 },
    ] as never);

    expect(bounds).toEqual({
      x: 68,
      y: 52,
      width: 504,
      height: 340,
    });
  });

  it('builds deduplicated outbound bulk edges', () => {
    const edges = buildBulkOutboundEdges({
      groupId: 'g1',
      memberNodeIds: ['n1', 'n2'],
      targetNodeId: 'target',
      existingEdges: [{ source: 'n1', target: 'target', sourceHandle: null, targetHandle: null }] as never,
    });

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([['n2', 'target']]);
  });

  it('builds deduplicated inbound bulk edges', () => {
    const edges = buildBulkInboundEdges({
      sourceNodeId: 'source',
      groupId: 'g1',
      memberNodeIds: ['n1', 'n2'],
      existingEdges: [{ source: 'source', target: 'n2', sourceHandle: null, targetHandle: null }] as never,
    });

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([['source', 'n1']]);
  });

  it('skips outbound self loops', () => {
    const edges = buildBulkOutboundEdges({
      groupId: 'g1',
      memberNodeIds: ['a', 'b'],
      targetNodeId: 'a',
      existingEdges: [],
    });

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([['b', 'a']]);
  });

  it('skips inbound self loops', () => {
    const edges = buildBulkInboundEdges({
      sourceNodeId: 'b',
      groupId: 'g1',
      memberNodeIds: ['a', 'b'],
      existingEdges: [],
    });

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([['b', 'a']]);
  });
});
