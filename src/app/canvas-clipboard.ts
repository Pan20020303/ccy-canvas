import type { Edge, Node } from '@xyflow/react';

export type CanvasClipboardSelection = {
  nodes: Node[];
  edges: Edge[];
};

function cloneNode(node: Node): Node {
  return {
    ...node,
    position: { ...node.position },
    data: { ...(node.data ?? {}) },
    measured: node.measured ? { ...node.measured } : node.measured,
  };
}

function cloneEdge(edge: Edge): Edge {
  return {
    ...edge,
    style: edge.style ? { ...edge.style } : edge.style,
  };
}

export function buildCanvasClipboardSelection({
  nodes,
  edges,
}: {
  nodes: Node[];
  edges: Edge[];
}): CanvasClipboardSelection | null {
  const selectedNodes = nodes.filter((node) => node.selected).map(cloneNode);
  if (!selectedNodes.length) return null;

  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = edges
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .map(cloneEdge);

  return { nodes: selectedNodes, edges: selectedEdges };
}

export function remapClipboardSelectionForPaste({
  selection,
  offset,
}: {
  selection: CanvasClipboardSelection;
  offset: { x: number; y: number };
}) {
  const idMap = new Map<string, string>();
  const stamp = Date.now();

  const nodes = selection.nodes.map((node, index) => {
    const nextId = `node-paste-${stamp}-${index}`;
    idMap.set(node.id, nextId);
    return {
      ...cloneNode(node),
      id: nextId,
      selected: true,
      position: {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      },
    };
  });

  const edges = selection.edges.flatMap((edge, index) => {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (!source || !target) return [];

    return [{
      ...cloneEdge(edge),
      id: `edge-paste-${stamp}-${index}`,
      source,
      target,
      selected: false,
    }];
  });

  return { nodes, edges };
}
