import type { Edge, Node } from '@xyflow/react';

const GROUP_PADDING = 32;
const GROUP_TITLE_HEIGHT = 36;

type NodeLike = Pick<Node, 'id' | 'position' | 'width' | 'height' | 'measured'>;

export function computeGroupBounds(nodes: NodeLike[]) {
  if (!nodes.length) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + (node.measured?.width ?? node.width ?? 300)));
  const bottom = Math.max(...nodes.map((node) => node.position.y + (node.measured?.height ?? node.height ?? 200)));

  return {
    x: left - GROUP_PADDING,
    y: top - GROUP_PADDING - GROUP_TITLE_HEIGHT,
    width: right - left + GROUP_PADDING * 2,
    height: bottom - top + GROUP_PADDING * 2 + GROUP_TITLE_HEIGHT,
  };
}

function edgeExists(existingEdges: Edge[], source: string, target: string) {
  return existingEdges.some(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (edge.sourceHandle ?? null) === null &&
      (edge.targetHandle ?? null) === null,
  );
}

export function buildBulkOutboundEdges({
  groupId,
  memberNodeIds,
  targetNodeId,
  existingEdges,
}: {
  groupId: string;
  memberNodeIds: string[];
  targetNodeId: string;
  existingEdges: Edge[];
}) {
  return memberNodeIds
    .filter((memberNodeId) => memberNodeId !== targetNodeId)
    .filter((memberNodeId) => !edgeExists(existingEdges, memberNodeId, targetNodeId))
    .map((memberNodeId, index) => ({
      id: `group-out-${groupId}-${targetNodeId}-${memberNodeId}-${index}`,
      source: memberNodeId,
      target: targetNodeId,
      sourceHandle: null,
      targetHandle: null,
      type: 'flow',
    }));
}

export function buildBulkInboundEdges({
  sourceNodeId,
  groupId,
  memberNodeIds,
  existingEdges,
}: {
  sourceNodeId: string;
  groupId: string;
  memberNodeIds: string[];
  existingEdges: Edge[];
}) {
  return memberNodeIds
    .filter((memberNodeId) => memberNodeId !== sourceNodeId)
    .filter((memberNodeId) => !edgeExists(existingEdges, sourceNodeId, memberNodeId))
    .map((memberNodeId, index) => ({
      id: `group-in-${groupId}-${sourceNodeId}-${memberNodeId}-${index}`,
      source: sourceNodeId,
      target: memberNodeId,
      sourceHandle: null,
      targetHandle: null,
      type: 'flow',
    }));
}
