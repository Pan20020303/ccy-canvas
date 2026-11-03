import type { Edge, Node } from '@xyflow/react';

export type ReferenceKind = 'image' | 'video' | 'audio' | 'text' | 'other';

export function isSeedance25Model(model: unknown): boolean {
  return /seedance[-_.]2[-_.]5/i.test(String(model ?? ''));
}

/** Typed numbered references also count as mentions; image 1 must not match image 10. */
export function hasNumberedReferenceToken(prompt: string, kind: ReferenceKind, index: number): boolean {
  const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '';
  return Boolean(label) && Number.isInteger(index) && index > 0
    && new RegExp(`@${label}\\s*${index}(?!\\d)`).test(prompt);
}

/** Replace all bound tags simultaneously so renumbering cannot cascade. */
export function replaceReferenceTags(text: string, replacements: Map<string, string>): string {
  const tags = [...replacements.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!tags.length) return text;
  const escaped = tags.map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(escaped.join('|'), 'g'), tag => replacements.get(tag) ?? tag);
}

/** Validate only explicit Seedance numbered media tokens, without rewriting prose. */
export function seedanceReferenceIndexIssues(model: unknown, prompt: string, counts: { images: number; videos: number; audios: number }) {
  if (!isSeedance25Model(model)) return [];
  const keys = { 图片: 'images', 视频: 'videos', 音频: 'audios' } as const;
  const seen = new Set<string>();
  return [...prompt.matchAll(/@(图片|视频|音频)\s*(\d+)/g)].flatMap(match => {
    const kind = match[1] as keyof typeof keys;
    const index = Number(match[2]);
    const available = counts[keys[kind]];
    const token = `@${kind}${match[2]}`;
    if ((index >= 1 && index <= available) || seen.has(token)) return [];
    seen.add(token);
    return [{ token, available }];
  });
}

export function referenceKind(type?: string): ReferenceKind {
  if (['imageNode', 'referenceImageNode', 'layerEditorNode', 'directorStageNode', 'compositionPreviewNode'].includes(type ?? '')) return 'image';
  if (['videoNode', 'referenceVideoNode', 'videoEditorNode'].includes(type ?? '')) return 'video';
  if (['audioNode', 'referenceAudioNode'].includes(type ?? '')) return 'audio';
  return type === 'textNode' ? 'text' : 'other';
}

/** Connection order is also request order. Text/audio never consume image indices. */
export function orderedReferenceConnections(nodes: Node[], edges: Edge[], targetId: string) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const seen = new Set<string>();
  const counts: Record<ReferenceKind, number> = { image: 0, video: 0, audio: 0, text: 0, other: 0 };
  return edges.flatMap(edge => {
    if (edge.target !== targetId || edge.source === targetId || seen.has(edge.source)) return [];
    const node = byId.get(edge.source);
    if (!node) return [];
    seen.add(node.id);
    const kind = referenceKind(node.type);
    return [{ node, edgeId: edge.id, kind, index: ++counts[kind] }];
  });
}

function usesSeedance25Connections(node?: Node): boolean {
  if (!node || node.type !== 'videoNode') return false;
  const data = node.data ?? {};
  const params = (data.generationParams ?? {}) as Record<string, unknown>;
  // Derived editors may carry deliberate snapshot references and a lineage edge.
  if (data.sourceKind === 'derived' || data.derivationAction || params.editOperation) return false;
  return params.referenceInputSource === 'connections'
    || isSeedance25Model(params.model ?? data.model);
}

export function usesConnectedReferenceInputs(node: Node | undefined, nodes: Node[], edges: Edge[]): boolean {
  if (!usesSeedance25Connections(node)) return false;
  const params = (node!.data.generationParams ?? {}) as Record<string, unknown>;
  return params.referenceInputSource === 'connections'
    || orderedReferenceConnections(nodes, edges, node!.id).some(ref => ['image', 'video', 'audio'].includes(ref.kind));
}

/** Remember graph ownership even after its last input is disconnected. Keep
 * explicit-only/derived requests intact, and make graph edits undoable with
 * the same store snapshot as the edge change. */
export function reconcileReferenceConnectionEdits(
  nodes: Node[], before: Edge[], after: Edge[], previousNodes: Node[] = nodes,
): Node[] {
  const signatures = (sourceNodes: Node[], edges: Edge[], targetId: string) =>
    orderedReferenceConnections(sourceNodes, edges, targetId)
      .filter(ref => ['image', 'video', 'audio'].includes(ref.kind))
      .map(ref => ref.node.id).join('\n');
  return nodes.map(node => {
    if (!usesSeedance25Connections(node)) return node;
    if (signatures(previousNodes, before, node.id) === signatures(nodes, after, node.id)) return node;
    const params = { ...((node.data.generationParams ?? {}) as Record<string, unknown>) };
    for (const key of ['referenceImages', 'referenceVideo', 'referenceVideos', 'referenceAudio', 'referenceAudios']) delete params[key];
    return { ...node, data: { ...node.data, generationParams: { ...params, referenceInputSource: 'connections' } } };
  });
}
