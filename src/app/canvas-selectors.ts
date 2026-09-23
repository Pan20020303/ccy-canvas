import type { Edge, Node } from '@xyflow/react';
import { referenceKind, type ReferenceKind } from './reference-connections';

type CanvasGraph = { nodes: Node[]; edges: Edge[] };
type ReferenceConnection = { node: Node; edgeId: string; kind: ReferenceKind; index: number };

/** Shared by all mounted subscribers. Arrays and nodes must be updated immutably,
 * as required by React Flow/Zustand. Weak keys do not retain old canvas snapshots.
 * Build once per array identity, never once per node/edge component. */
export function createCanvasQueryCache() {
  const nodeIndexes = new WeakMap<Node[], {
    byId: Map<string, Node>;
    selectedCount: number;
    latestDerived: Map<string, Node>;
  }>();
  const edgeIndexes = new WeakMap<Edge[], Map<string, Edge[]>>();
  const emptyEdges: Edge[] = [];
  const stats = { nodeBuilds: 0, nodeVisits: 0, edgeBuilds: 0, edgeVisits: 0, referenceVisits: 0 };

  function nodeIndex(nodes: Node[]) {
    let cached = nodeIndexes.get(nodes);
    if (cached) return cached;
    const byId = new Map<string, Node>();
    const latestDerived = new Map<string, Node>();
    let selectedCount = 0;
    for (const node of nodes) {
      byId.set(node.id, node);
      if (node.selected) selectedCount += 1;
      const sourceId = node.data?.derivedFromNodeId;
      if (typeof sourceId === 'string') latestDerived.set(sourceId, node);
    }
    stats.nodeBuilds += 1;
    stats.nodeVisits += nodes.length;
    cached = { byId, selectedCount, latestDerived };
    nodeIndexes.set(nodes, cached);
    return cached;
  }

  function incomingEdges(edges: Edge[], targetId: string): Edge[] {
    let index = edgeIndexes.get(edges);
    if (!index) {
      index = new Map<string, Edge[]>();
      for (const edge of edges) {
        const incoming = index.get(edge.target);
        if (incoming) incoming.push(edge);
        else index.set(edge.target, [edge]);
      }
      stats.edgeBuilds += 1;
      stats.edgeVisits += edges.length;
      edgeIndexes.set(edges, index);
    }
    return index.get(targetId) ?? emptyEdges;
  }

  const node = (nodes: Node[], id?: string) => id === undefined ? undefined : nodeIndex(nodes).byId.get(id);
  const selectedCount = (nodes: Node[]) => nodeIndex(nodes).selectedCount;
  const latestDerived = (nodes: Node[], sourceId: string) => nodeIndex(nodes).latestDerived.get(sourceId);

  /** The text reverse-prompt input preserves edge order and duplicates, matching
   * the previous filter/map path. Stable results avoid unrelated-node renders. */
  function incomingNodesSelector(targetId: string) {
    let previous: Node[] = [];
    let lastNodes: Node[] | undefined;
    let lastEdges: Edge[] | undefined;
    return (state: CanvasGraph): Node[] => {
      if (state.nodes === lastNodes && state.edges === lastEdges) return previous;
      const byId = nodeIndex(state.nodes).byId;
      const next: Node[] = [];
      for (const edge of incomingEdges(state.edges, targetId)) {
        stats.referenceVisits += 1;
        const source = byId.get(edge.source);
        if (source) next.push(source);
      }
      if (next.length !== previous.length || next.some((n, i) => n !== previous[i])) previous = next;
      lastNodes = state.nodes;
      lastEdges = state.edges;
      return previous;
    };
  }

  /** Same order, source deduplication and per-kind numbering as
   * orderedReferenceConnections. Only the target's incoming edges are visited. */
  function referenceConnectionsSelector(targetId: string) {
    let previous: ReferenceConnection[] = [];
    let lastNodes: Node[] | undefined;
    let lastEdges: Edge[] | undefined;
    return (state: CanvasGraph): ReferenceConnection[] => {
      if (state.nodes === lastNodes && state.edges === lastEdges) return previous;
      const byId = nodeIndex(state.nodes).byId;
      const seen = new Set<string>();
      const counts: Record<ReferenceKind, number> = { image: 0, video: 0, audio: 0, text: 0, other: 0 };
      const next: ReferenceConnection[] = [];
      for (const edge of incomingEdges(state.edges, targetId)) {
        stats.referenceVisits += 1;
        if (edge.source === targetId || seen.has(edge.source)) continue;
        const source = byId.get(edge.source);
        if (!source) continue;
        seen.add(source.id);
        const kind = referenceKind(source.type);
        next.push({ node: source, edgeId: edge.id, kind, index: ++counts[kind] });
      }
      if (next.length !== previous.length || next.some((r, i) => {
        const old = previous[i];
        return r.node !== old.node || r.edgeId !== old.edgeId || r.kind !== old.kind || r.index !== old.index;
      })) previous = next;
      lastNodes = state.nodes;
      lastEdges = state.edges;
      return previous;
    };
  }

  return { node, selectedCount, latestDerived, incomingEdges, incomingNodesSelector, referenceConnectionsSelector,
    // Operation counts support reproducible non-rendering benchmarks; not FPS.
    stats: () => ({ ...stats }) };
}

export const canvasQueries = createCanvasQueryCache();
