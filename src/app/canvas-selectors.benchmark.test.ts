import type { Edge, Node } from '@xyflow/react';
import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import { expect, it } from 'vitest';
import { createCanvasQueryCache } from './canvas-selectors';

type Graph = { nodes: Node[]; edges: Edge[] };

/** Operation/notification benchmark, not a browser frame-rate measurement.
 * Same Zustand selector subscription counts for both implementations; models
 * BaseNode selection, two FlowEdge endpoint queries and ModeText upstream refs.
 * The last node is isolated and moves three times; no view depends on its data.
 */
function measure(size: number, indexed: boolean) {
  const nodes: Node[] = Array.from({ length: size }, (_, i) => ({
    id: `${i}`, type: i % 3 === 0 ? 'textNode' : 'imageNode',
    position: { x: i * 10, y: 0 }, data: { status: 'idle' },
  }));
  const edges: Edge[] = [];
  for (let i = 1; i < size - 1; i++) {
    edges.push({ id: `e${i}`, source: `${i - 1}`, target: `${i}` });
    if (i % 2 === 0) edges.push({ id: `b${i}`, source: `${Math.max(0, i - 3)}`, target: `${i}` });
  }
  const store = createStore(subscribeWithSelector<Graph>(() => ({ nodes, edges })));
  const queries = createCanvasQueryCache();
  let nodeVisits = 0;
  let selectorCalls = 0;
  let notifications = 0;
  const find = (list: Node[], id: string) => {
    for (const n of list) { nodeVisits++; if (n.id === id) return n; }
  };
  const listen = <T>(selector: (graph: Graph) => T) => store.subscribe((graph) => {
    selectorCalls++;
    return selector(graph);
  }, () => { notifications++; });
  for (const n of nodes) {
    listen(indexed ? (s) => queries.selectedCount(s.nodes) > 1 : (s) => {
      let count = 0;
      for (const n of s.nodes) { nodeVisits++; if (n.selected) count++; }
      return count > 1;
    });
    if (n.type === 'textNode') {
      if (indexed) listen(queries.incomingNodesSelector(n.id));
      else listen(s => s.nodes);
    }
  }
  for (const edge of edges) {
    listen(s => {
      const source = indexed ? queries.node(s.nodes, edge.source) : find(s.nodes, edge.source);
      const target = indexed ? queries.node(s.nodes, edge.target) : find(s.nodes, edge.target);
      return source?.data.status === 'running' || target?.data.status === 'running';
    });
    listen(indexed ? (s) => !!(queries.node(s.nodes, edge.source)?.selected || queries.node(s.nodes, edge.target)?.selected) : (s) => {
      for (const n of s.nodes) {
        nodeVisits++;
        if ((n.id === edge.source || n.id === edge.target) && n.selected) return true;
      }
      return false;
    });
  }
  const before = queries.stats();
  selectorCalls = nodeVisits = notifications = 0;
  const updates = 3;
  for (let step = 1; step <= updates; step++) {
    store.setState(s => ({ nodes: s.nodes.map((n, i) => i === size - 1
      ? { ...n, position: { x: n.position.x, y: step * 10 } } : n) }));
  }
  const after = queries.stats();
  return {
    nodes: size, edges: edges.length, updates, selectorCalls, notifications,
    nodeVisits: indexed ? after.nodeVisits - before.nodeVisits : nodeVisits,
    nodeIndexBuilds: after.nodeBuilds - before.nodeBuilds,
    edgeIndexBuilds: after.edgeBuilds - before.edgeBuilds,
    referenceVisits: after.referenceVisits - before.referenceVisits,
  };
}

it('bounds shared query work and avoids unrelated-reference notifications at 100/1000/3000 nodes', () => {
  const rows = [100, 1000, 3000].map(size => ({ before: measure(size, false), after: measure(size, true) }));
  for (const { before, after } of rows) {
    expect(after.selectorCalls).toBe(before.selectorCalls);
    expect(after.nodeIndexBuilds).toBe(after.updates);
    expect(after.nodeVisits).toBe(after.nodes * after.updates);
    expect(after.edgeIndexBuilds).toBe(0);
    expect(before.notifications).toBe(Math.ceil(before.nodes / 3) * before.updates);
    expect(after.notifications).toBe(0);
    expect(after.nodeVisits + after.referenceVisits).toBeLessThan(before.nodeVisits / 100);
  }
  console.log('CANVAS_SELECTOR_BENCHMARK', JSON.stringify(rows));
}, 30_000);
