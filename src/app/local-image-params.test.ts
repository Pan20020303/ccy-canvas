import { describe, expect, it } from 'vitest';
import { buildLocalImageParams } from './local-image-params';
import { getModelTemplate } from './model-templates';

describe('local FLUX/Krea parameters', () => {
  it('keeps model defaults and LoRAs isolated', () => {
    expect(buildLocalImageParams('klein')).toEqual({ steps: 20, cfg: 5 });
    expect(buildLocalImageParams('krea2')).toEqual({ steps: 8, lora: 'none', lora_strength: 1 });
    expect(buildLocalImageParams('klein', { krea2: { steps: 4, lora: 'darkbrush' } })).toEqual({ steps: 20, cfg: 5 });
    expect(buildLocalImageParams('krea2', { krea2: { steps: 12, lora: 'darkbrush', loraStrength: 0 } })).toEqual({ steps: 12, lora: 'darkbrush', lora_strength: 0 });
  });
  it('declares only supported reference ranges', () => {
    for (const model of ['flux2-klein-base-4b-local', 'flux2-klein-base-9b-local']) {
      expect(getModelTemplate(model)?.referenceImageRange).toEqual({ min: 0, max: 4 });
      expect(getModelTemplate(model)?.localImageKind).toBe('klein');
    }
    expect(getModelTemplate('krea2-turbo-local')?.referenceImageRange).toEqual({ min: 0, max: 0 });
    expect(getModelTemplate('z-image-turbo-local')?.localImageKind).toBeUndefined();
  });
});
