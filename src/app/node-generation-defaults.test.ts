/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindCanvasPreferences, useCanvasPreferences } from './canvas-preferences';
import { flushPendingPersist, useStore } from './store';
import { reusableGenerationParams } from './node-generation-defaults';

const original = useStore.getState();
const preferences = useCanvasPreferences.getState();
const video = { model: 'doubao-seedance-2-5-260628', resolution: '1080p', aspectRatio: '9:16', durationSeconds: 12, audioSetting: 'off', seed: 42 };
const image = { model: 'gpt-image-2', resolution: '2k', aspectRatio: '1:1', outputCount: 4 };
const add = (id: string, type = 'videoNode', data: Record<string, unknown> = {}) => {
  useStore.getState().addNode({ id, type, position: { x: 0, y: 0 }, data });
  return useStore.getState().nodes.find(node => node.id === id)!;
};
beforeEach(() => {
  localStorage.clear(); bindCanvasPreferences('generation-defaults-test');
  useStore.setState({ ...original, nodes: [], edges: [], groups: [], activeBackendProjectId: null, backendProjects: [],
    backendModels: [
      { id: 'video', vendor: 'HopBase', name: 'Video', service_type: 'video', model_list: [video.model], default_model: video.model, priority: 1 },
      { id: 'image', vendor: 'OpenAI', name: 'Image', service_type: 'image', model_list: [image.model], default_model: image.model, priority: 1 },
    ],
  });
});
afterEach(() => { flushPendingPersist(); useStore.setState(original); useCanvasPreferences.setState(preferences); });

describe('new node generation defaults', () => {
  it('applies the last chosen model and parameters independently by media type, excluding source-specific inputs', () => {
    useCanvasPreferences.getState().setPreference('reuseLastGenerationParams', true);
    add('source');
    useStore.getState().updateNodeGenerationParams('source', { ...video, referenceImages: ['/private.png'], maskImage: 'mask', editOperation: 'crop', deriveFromNodeId: 'ref' });
    add('image-source', 'imageNode');
    useStore.getState().updateNodeGenerationParams('image-source', image);
    expect(add('next-video').data.generationParams).toEqual({ ...video, vendor: 'HopBase' });
    expect(add('next-image', 'imageNode').data.generationParams).toEqual({ ...image, vendor: 'OpenAI' });
    expect(add('reference', 'referenceImageNode').data).toEqual({});
  });

  it('only affects new nodes while enabled and never replaces an explicit or imported configuration', () => {
    useCanvasPreferences.getState().rememberGenerationParams('video', video);
    expect(add('off').data.generationParams).toBeUndefined();
    useCanvasPreferences.getState().setPreference('reuseLastGenerationParams', true);
    expect(add('on').data.generationParams).toMatchObject(video);
    const explicit = { model: 'tool-model', aspectRatio: '16:9' };
    expect(add('explicit', 'videoNode', { generationParams: explicit }).data.generationParams).toEqual(explicit);
    expect(add('imported', 'videoNode', { url: '/existing.mp4' }).data.generationParams).toBeUndefined();
    useCanvasPreferences.getState().setPreference('reuseLastGenerationParams', false);
    expect(add('off-again').data.generationParams).toBeUndefined();
    expect(useStore.getState().nodes.find(node => node.id === 'on')!.data.generationParams).toMatchObject(video);
  });

  it('does not treat opening an old node and automatic model fallback as a new user selection', () => {
    useCanvasPreferences.getState().rememberGenerationParams('video', video);
    add('old', 'videoNode', { generationParams: { model: 'old-model', aspectRatio: '16:9' } });
    useStore.getState().updateNodeGenerationParams('old', { durationSeconds: 5 }, { remember: false });
    expect(useCanvasPreferences.getState().lastGenerationParams.video).toEqual(video);
  });

  it('persists choices across rebinding and isolates different accounts', () => {
    useCanvasPreferences.getState().setPreference('reuseLastGenerationParams', true);
    useCanvasPreferences.getState().rememberGenerationParams('video', video);
    bindCanvasPreferences('another-user');
    expect(useCanvasPreferences.getState().lastGenerationParams).toEqual({});
    expect(add('other-user').data.generationParams).toBeUndefined();
    bindCanvasPreferences('generation-defaults-test');
    expect(add('reloaded').data.generationParams).toMatchObject(video);
    useCanvasPreferences.getState().restoreDefaults();
    bindCanvasPreferences('generation-defaults-test');
    expect(useCanvasPreferences.getState().lastGenerationParams).toEqual({});
  });

  it('falls back to normal defaults when the remembered model is no longer available', () => {
    useCanvasPreferences.getState().setPreference('reuseLastGenerationParams', true);
    useCanvasPreferences.getState().rememberGenerationParams('video', { ...video, model: 'disabled-model' });
    expect(add('fallback').data.generationParams).toBeUndefined();
  });

  it('retains local model controls without copying references or malformed storage entries', () => {
    expect(reusableGenerationParams({ model: 'local', zImage: { steps: 8, lora: 'pixel-art', mask: 'private' }, localImage: { klein: { steps: 20, cfg: 5 } }, durationSeconds: Infinity, referenceVideo: '/private.mp4' }))
      .toEqual({ model: 'local', zImage: { steps: 8, lora: 'pixel-art' }, localImage: { klein: { steps: 20, cfg: 5 } } });
  });
});
