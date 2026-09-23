// Immutable canvas arrays are document versions. This lets the drag/selection
// hot path check dirtiness without walking or serializing the entire canvas.
// Weak keys do not retain old canvases/history. Only explicitly transient
// React Flow changes may carry the preceding array's document token forward.
const tokens = new WeakMap<object, number>();
let nextToken = 0;

function token(value: object): number {
  let existing = tokens.get(value);
  if (existing === undefined) { existing = ++nextToken; tokens.set(value, existing); }
  return existing;
}

export function retainCanvasArrayToken(previous: object, next: object): void {
  tokens.set(next, token(previous));
}

export function canvasDocumentToken(projectId: string, nodes: object, edges: object, groups: object): string {
  return `${projectId}:${token(nodes)}:${token(edges)}:${token(groups)}`;
}
