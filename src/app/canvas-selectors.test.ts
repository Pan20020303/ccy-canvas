import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Edge, Node } from '@xyflow/react';
import { createCanvasQueryCache } from './canvas-selectors';
import { orderedReferenceConnections, usesConnectedReferenceInputs } from './reference-connections';

const node = (id: string, type = 'imageNode', data: Record<string, unknown> = {}): Node =>
  ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (id: string, source: string, target = 'target'): Edge => ({ id, source, target });

describe('shared canvas selectors', () => {
  it('shares one index across node, selection and derived lookups, and supports undo snapshots', () => {
    const q = createCanvasQueryCache();
    const original = [node('source'), { ...node('first', 'imageNode', { derivedFromNodeId: 'source' }), selected: true },
      node('last', 'imageNode', { derivedFromNodeId: 'source' })];
    expect(q.node(original, 'source')).toBe(original[0]);
    expect(q.selectedCount(original)).toBe(1);
    expect(q.latestDerived(original, 'source')).toBe(original[2]);
    expect(q.node(original, 'missing')).toBeUndefined();
    expect(q.stats()).toMatchObject({ nodeBuilds: 1, nodeVisits: 3 });
    const changed = original.map(n => n.id === 'source' ? { ...n, data: { status: 'running' }, selected: true } : n);
    expect(q.node(changed, 'source')?.data.status).toBe('running');
    expect(q.selectedCount(changed)).toBe(2);
    expect(q.node(original, 'source')?.data.status).toBeUndefined();
    expect(q.selectedCount(original)).toBe(1);
    expect(q.stats().nodeBuilds).toBe(2);
    expect(q.latestDerived(changed.slice(0, 2), 'source')?.id).toBe('first');
  });

  it('preserves canonical reference order, per-kind numbering, duplicates and missing-source rules', () => {
    const q = createCanvasQueryCache();
    const select = q.referenceConnectionsSelector('target');
    const nodes = [node('target', 'videoNode'), node('a'), node('b', 'referenceAudioNode'),
      node('c', 'textNode'), node('d', 'directorStageNode'), node('v', 'videoEditorNode')];
    const edges = [edge('audio', 'b'), edge('image', 'a'), edge('dup', 'a'), edge('text', 'c'),
      edge('self', 'target'), edge('missing', 'gone'), edge('other', 'a', 'other'), edge('stage', 'd'), edge('video', 'v')];
    const state = { nodes, edges };
    expect(select(state)).toEqual(orderedReferenceConnections(nodes, edges, 'target'));
    const initial = select(state);
    expect(select({ nodes: [...nodes, node('unrelated')], edges })).toBe(initial);
    expect(select({ nodes, edges: [...edges, edge('outside', 'b', 'elsewhere')] })).toBe(initial);
    const reversed = [...edges].reverse();
    expect(select({ nodes, edges: reversed })).toEqual(orderedReferenceConnections(nodes, reversed, 'target'));
    const changedKind = nodes.map(n => n.id === 'a' ? { ...n, type: 'referenceAudioNode', data: { url: '/new.wav' } } : n);
    expect(select({ nodes: changedKind, edges })).toEqual(orderedReferenceConnections(changedKind, edges, 'target'));
    const removed = nodes.filter(n => n.id !== 'b');
    expect(select({ nodes: removed, edges })).toEqual(orderedReferenceConnections(removed, edges, 'target'));
    expect(select({ nodes, edges: [] })).toEqual([]);
  });

  it('preserves text-input duplicate ordering and updates live upstream content', () => {
    const q = createCanvasQueryCache();
    const select = q.incomingNodesSelector('target');
    const a = node('a', 'referenceImageNode', { url: '/one.png' });
    const b = node('b', 'textNode', { content: 'first' });
    const nodes = [a, b, node('unrelated')];
    const edges = [edge('1', 'b'), edge('2', 'a'), edge('3', 'b'), edge('missing', 'gone')];
    const first = select({ nodes, edges });
    expect(first).toEqual([b, a, b]);
    const moved = nodes.map(n => n.id === 'unrelated' ? { ...n, position: { x: 50, y: 60 } } : n);
    expect(select({ nodes: moved, edges })).toBe(first);
    const edited = nodes.map(n => n.id === 'b' ? { ...n, data: { content: 'changed' } } : n);
    expect(select({ nodes: edited, edges }).map(n => n.data.content)).toEqual(['changed', undefined, 'changed']);
    expect(select({ nodes: edited, edges: edges.slice(1) }).map(n => n.id)).toEqual(['a', 'b']);
  });

  it('keeps connection-ownership behavior on the reduced prompt-panel graph', () => {
    const q = createCanvasQueryCache();
    const select = q.referenceConnectionsSelector('target');
    for (const data of [
      { generationParams: { model: 'dreamina-seedance-2-5-260628' } },
      { generationParams: { model: 'other', referenceInputSource: 'connections' } },
      { sourceKind: 'derived', generationParams: { model: 'dreamina-seedance-2-5-260628' } },
      { derivationAction: 'edit', generationParams: { referenceInputSource: 'connections' } },
    ]) {
      const target = node('target', 'videoNode', data);
      const nodes = [target, node('a'), node('t', 'textNode')];
      for (const edges of [[], [edge('1', 't')], [edge('1', 'a'), edge('2', 'a')]]) {
        const refs = select({ nodes, edges });
        const reducedEdges = refs.map(r => edge(r.edgeId, r.node.id));
        expect(usesConnectedReferenceInputs(target, refs.map(r => r.node), reducedEdges))
          .toBe(usesConnectedReferenceInputs(target, nodes, edges));
      }
    }
  });

  it('does not notify unrelated subscribers, but propagates selection, metadata and reconnection', () => {
    const q = createCanvasQueryCache();
    const store = createStore(subscribeWithSelector(() => ({
      nodes: [node('target', 'videoNode'), node('source'), node('unrelated')], edges: [edge('e', 'source')],
    })));
    const calls = { target: 0, reference: 0, selection: 0 };
    store.subscribe(s => q.node(s.nodes, 'target'), () => calls.target++);
    store.subscribe(q.referenceConnectionsSelector('target'), () => calls.reference++);
    store.subscribe(s => q.selectedCount(s.nodes), () => calls.selection++);
    const patch = (id: string, value: Partial<Node>) => store.setState(s => ({ nodes: s.nodes.map(n => n.id === id ? { ...n, ...value } : n) }));
    patch('unrelated', { position: { x: 4, y: 5 } });
    expect(calls).toEqual({ target: 0, reference: 0, selection: 0 });
    patch('source', { data: { url: '/latest.png' } });
    expect(calls.reference).toBe(1);
    patch('source', { selected: true });
    expect(calls.selection).toBe(1);
    store.setState({ edges: [edge('new', 'unrelated')] });
    expect(calls.reference).toBe(3);
    patch('target', { data: { prompt: 'updated' } });
    expect(calls.target).toBe(1);
  });
});
