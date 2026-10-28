import type { Node, NodeChange, NodePositionChange, XYPosition } from '@xyflow/react';

export type GuideLine = { orientation: 'h' | 'v'; pos: number; from: number; to: number };

export function getNodeBounds(node: Node) {
  const w = node.measured?.width ?? node.width ?? 300;
  const h = node.measured?.height ?? node.height ?? 200;
  const x = node.position.x;
  const y = node.position.y;
  return {
    left: x,
    right: x + w,
    top: y,
    bottom: y + h,
    cx: x + w / 2,
    cy: y + h / 2,
  };
}
function computeGuides(dragged: Node, others: Node[], threshold: number): {
  guides: GuideLine[];
  snapDx: number;
  snapDy: number;
  hasSnapX: boolean;
  hasSnapY: boolean;
} {
  const db = getNodeBounds(dragged);
  const guides: GuideLine[] = [];

  // hasSnapX/Y must be tracked separately from the delta: a PERFECT alignment
  // yields snapDx === 0, which the caller used to misread as "no snap" and
  // then grid-round the node right off its alignment.
  let bestDistX = threshold;
  let bestDistY = threshold;
  let snapDx = 0;
  let snapDy = 0;
  let hasSnapX = false;
  let hasSnapY = false;

  const dragXAnchors = [db.left, db.cx, db.right];
  const dragYAnchors = [db.top, db.cy, db.bottom];

  for (const other of others) {
    if (other.id === dragged.id) continue;
    const ob = getNodeBounds(other);
    const otherXAnchors = [ob.left, ob.cx, ob.right];
    const otherYAnchors = [ob.top, ob.cy, ob.bottom];

    for (const dx of dragXAnchors) {
      for (const ox of otherXAnchors) {
        const dist = Math.abs(dx - ox);
        if (dist < bestDistX) {
          bestDistX = dist;
          snapDx = ox - dx;
          hasSnapX = true;
        }
      }
    }

    for (const dy of dragYAnchors) {
      for (const oy of otherYAnchors) {
        const dist = Math.abs(dy - oy);
        if (dist < bestDistY) {
          bestDistY = dist;
          snapDy = oy - dy;
          hasSnapY = true;
        }
      }
    }
  }

  const snappedLeft = db.left + snapDx;
  const snappedRight = db.right + snapDx;
  const snappedCx = db.cx + snapDx;
  const snappedTop = db.top + snapDy;
  const snappedBottom = db.bottom + snapDy;
  const snappedCy = db.cy + snapDy;

  for (const other of others) {
    if (other.id === dragged.id) continue;
    const ob = getNodeBounds(other);

    for (const sx of [snappedLeft, snappedCx, snappedRight]) {
      for (const ox of [ob.left, ob.cx, ob.right]) {
        if (Math.abs(sx - ox) < 0.5) {
          guides.push({ orientation: 'v', pos: ox, from: Math.min(snappedTop, ob.top), to: Math.max(snappedBottom, ob.bottom) });
        }
      }
    }

    for (const sy of [snappedTop, snappedCy, snappedBottom]) {
      for (const oy of [ob.top, ob.cy, ob.bottom]) {
        if (Math.abs(sy - oy) < 0.5) {
          guides.push({ orientation: 'h', pos: oy, from: Math.min(snappedLeft, ob.left), to: Math.max(snappedRight, ob.right) });
        }
      }
    }
  }

  return { guides, snapDx, snapDy, hasSnapX, hasSnapY };
}


export type CanvasSnapOptions = {
  enabled: boolean;
  showGuides: boolean;
  strength: number;
  gridGap: number;
  zoom: number;
};

/** Only drag events may attract nodes; off means a strict, unchanged pass-through. */
export function snapCanvasChanges(changes: NodeChange[], nodes: Node[], options: CanvasSnapOptions): {
  changes: NodeChange[];
  guides: GuideLine[];
} {
  if (!options.enabled) return { changes, guides: [] };
  const primary = changes.find((change): change is NodePositionChange & { position: XYPosition } =>
    change.type === 'position' && change.position != null && typeof change.dragging === 'boolean',
  );
  const node = primary && nodes.find(candidate => candidate.id === primary.id);
  if (!primary || !node) return { changes, guides: [] };

  const zoom = Number.isFinite(options.zoom) && options.zoom > 0 ? options.zoom : 1;
  const strength = Number.isFinite(options.strength) ? Math.min(12, Math.max(1, options.strength)) : 3;
  const threshold = strength / zoom;
  const movingIds = new Set(changes.filter((change): change is NodePositionChange =>
    change.type === 'position' && change.dragging != null,
  ).map(change => change.id));
  const others = nodes.filter(other => !movingIds.has(other.id) && !(node.selected && other.selected));
  const alignment = computeGuides({ ...node, position: primary.position }, others, threshold);
  const position = { ...primary.position };
  for (const axis of ['x', 'y'] as const) {
    const aligned = axis === 'x' ? alignment.hasSnapX : alignment.hasSnapY;
    if (aligned) {
      position[axis] += axis === 'x' ? alignment.snapDx : alignment.snapDy;
    } else if (!primary.dragging && Number.isFinite(options.gridGap) && options.gridGap > 0) {
      // No per-frame grid quantization, and no release jump beyond the chosen radius.
      const grid = Math.round(position[axis] / options.gridGap) * options.gridGap;
      if (Math.abs(grid - position[axis]) < threshold) position[axis] = grid;
    }
  }
  const dx = position.x - primary.position.x, dy = position.y - primary.position.y;
  const guides = primary.dragging && options.showGuides ? alignment.guides : [];
  if (dx === 0 && dy === 0) return { changes, guides };
  return {
    guides,
    changes: changes.map(change => {
      if (change.type !== 'position' || !change.position || !movingIds.has(change.id)) return change;
      return {
        ...change,
        position: { x: change.position.x + dx, y: change.position.y + dy },
        ...(change.positionAbsolute ? { positionAbsolute: { x: change.positionAbsolute.x + dx, y: change.positionAbsolute.y + dy } } : {}),
      };
    }),
  };
}
