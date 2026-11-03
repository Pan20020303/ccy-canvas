import { describe, expect, it } from 'vitest';
import { buildZImageParams } from './zimage-params';
import { getModelTemplate } from './model-templates';

describe('Z-Image local parameters', () => {
  it('matches ComfyUI defaults and preserves a disabled strength', () => {
    expect(buildZImageParams()).toEqual({ steps: 8, sampler: 'res_multistep', scheduler: 'simple', lora: 'none', lora_strength: 0.8 });
    expect(buildZImageParams({ steps: 12, lora: 'pixel-art', loraStrength: 0 })).toMatchObject({ steps: 12, lora: 'pixel-art', lora_strength: 0 });
  });
  it('exposes parameters on both local checkpoints only', () => {
    for (const model of ['z-image-turbo-local', 'z-image-turbo-v60-local']) {
      const template = getModelTemplate(model);
      expect(template?.supportsZImageParams).toBe(true);
      expect(template?.supportsSeed).toBe(true);
      expect(template?.defaults).toEqual({ resolution: '768px', aspectRatio: '1:1' });
      expect(template?.resolutionOptions).toEqual(['512px','768px','1024px']);
      expect(template?.referenceImageRange?.max).toBe(0);
    }
    expect(getModelTemplate('gpt-image-2')?.supportsZImageParams).toBeUndefined();
  });
});
