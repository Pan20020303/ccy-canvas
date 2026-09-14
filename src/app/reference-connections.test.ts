import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { hasNumberedReferenceToken, orderedReferenceConnections, reconcileReferenceConnectionEdits, replaceReferenceTags, seedanceReferenceIndexIssues, usesConnectedReferenceInputs } from './reference-connections';

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (source: string, id = source): Edge => ({ id, source, target: 'target' });
const target = (extra: Record<string, unknown> = {}) => node('target', 'videoNode', {
  generationParams: { model: 'dreamina-seedance-2-5-260628', referenceImages: ['/old.png'], referenceAudio: '/old.mp3', referenceAudios: ['/older.mp3'] },
  ...extra,
});

describe('numbered reference mentions', () => {
  it('recognizes typed audio/image references without registered mention objects', () => {
    expect(hasNumberedReferenceToken('使用@音频1声线和@图片 2形象', 'audio', 1)).toBe(true);
    expect(hasNumberedReferenceToken('使用@音频1声线和@图片 2形象', 'image', 2)).toBe(true);
    expect(hasNumberedReferenceToken('@音频10', 'audio', 1)).toBe(false);
    expect(hasNumberedReferenceToken('@音频1', 'image', 1)).toBe(false);
    expect(hasNumberedReferenceToken('音频1', 'audio', 1)).toBe(false);
  });
  it('replaces every bound mention once without cascading after an input is removed', () => {
    expect(replaceReferenceTags('[@图片1] + [@图片2] + [@图片2] + [@音频3]', new Map([
      ['[@图片1]', ''], ['[@图片2]', '[@图片1]'], ['[@音频3]', '[@音频1]'],
    ]))).toBe(' + [@图片1] + [@图片1] + [@音频1]');
  });

  it('rejects only out-of-range ordinary Seedance media tokens and leaves other providers alone', () => {
    const counts = { images: 2, videos: 1, audios: 1 };
    const prompt = '@图片2 和 @音频1；@图片3、@图片3、@音频0、@视频2。普通图片9不改写。';
    expect(seedanceReferenceIndexIssues('dreamina-seedance-2-5-260628', prompt, counts)).toEqual([
      { token: '@图片3', available: 2 }, { token: '@音频0', available: 1 }, { token: '@视频2', available: 1 },
    ]);
    expect(seedanceReferenceIndexIssues('seedance-2.0', prompt, counts)).toEqual([]);
    expect(seedanceReferenceIndexIssues('sora-v3-fast', prompt, counts)).toEqual([]);
    expect(seedanceReferenceIndexIssues('dreamina-seedance-2-5-260628', '@音频1', { ...counts, audios: 0 }))
      .toEqual([{ token: '@音频1', available: 0 }]);
  });
});

describe('orderedReferenceConnections', () => {
  it('matches connection order regardless of node storage order and numbers each media kind independently', () => {
    const nodes = [target(), node('image-b', 'referenceImageNode'), node('audio-b', 'audioNode'), node('text', 'textNode'), node('image-a', 'imageNode'), node('audio-a', 'referenceAudioNode'), node('video', 'referenceVideoNode')];
    const edges = ['audio-a', 'image-a', 'text', 'video', 'image-b', 'audio-b'].map(id => edge(id));
    expect(orderedReferenceConnections(nodes, edges, 'target').map(ref => [ref.node.id, ref.kind, ref.index])).toEqual([
      ['audio-a', 'audio', 1], ['image-a', 'image', 1], ['text', 'text', 1], ['video', 'video', 1], ['image-b', 'image', 2], ['audio-b', 'audio', 2],
    ]);
  });

  it('ignores duplicate sources, missing nodes, self connections and other targets', () => {
    const nodes = [target(), node('image', 'layerEditorNode'), node('video', 'videoEditorNode')];
    const edges = [edge('missing'), edge('target'), edge('image'), edge('image', 'duplicate'), edge('video'), { ...edge('video', 'other'), target: 'elsewhere' }];
    expect(orderedReferenceConnections(nodes, edges, 'target').map(ref => [ref.edgeId, ref.kind, ref.index])).toEqual([['image', 'image', 1], ['video', 'video', 1]]);
  });
});

describe('Seedance 2.5 connected reference ownership', () => {
  const refs = [node('image', 'referenceImageNode'), node('audio', 'referenceAudioNode')];

  it('uses an existing graph even when imported generation params carry stale references', () => {
    const current = target();
    expect(usesConnectedReferenceInputs(current, [...refs, current], [edge('audio')])).toBe(true);
    expect(usesConnectedReferenceInputs(current, [...refs, current], [])).toBe(false);
  });

  it('clears snapshots on addition and preserves graph ownership after the last disconnection', () => {
    const initial = [...refs, target()];
    const connected = reconcileReferenceConnectionEdits(initial, [], [edge('image')]);
    const connectedTarget = connected.find(n => n.id === 'target')!;
    expect(connectedTarget.data.generationParams).toEqual({ model: 'dreamina-seedance-2-5-260628', referenceInputSource: 'connections' });
    const disconnected = reconcileReferenceConnectionEdits(connected, [edge('image')], []);
    expect(usesConnectedReferenceInputs(disconnected.find(n => n.id === 'target'), disconnected, [])).toBe(true);
    expect(initial[2].data.generationParams).toHaveProperty('referenceImages');
  });

  it('clears imported snapshots when deleting the source node', () => {
    const initial = [...refs, target()];
    const remaining = initial.filter(n => n.id !== 'audio');
    const result = reconcileReferenceConnectionEdits(remaining, [edge('audio')], [], initial);
    expect(result.find(n => n.id === 'target')!.data.generationParams).toEqual({ model: 'dreamina-seedance-2-5-260628', referenceInputSource: 'connections' });
  });

  it('preserves explicit-only requests, derived snapshots, other models and non-media edge changes', () => {
    for (const current of [target({ sourceKind: 'derived' }), target({ generationParams: { model: 'seedance-2.0', referenceImages: ['/keep.png'] } })]) {
      const nodes = [...refs, current];
      expect(reconcileReferenceConnectionEdits(nodes, [], [edge('image')])[2]).toBe(current);
      expect(usesConnectedReferenceInputs(current, nodes, [edge('image')])).toBe(false);
    }
    const current = target();
    const nodes = [...refs, current, node('text', 'textNode')];
    expect(reconcileReferenceConnectionEdits(nodes, [], [edge('text')])[2]).toBe(current);
    expect(reconcileReferenceConnectionEdits(nodes, [], [])[2]).toBe(current);
  });
});
