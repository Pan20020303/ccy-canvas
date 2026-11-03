import { describe, expect, it } from 'vitest';
import { VENDOR_TEMPLATES } from './api/providerConfigs';
import { buildModelRequestBody, getModelTemplate } from './model-templates';
import { isModeSatisfied } from './reference-modes';
import { filmMediaPayload, filmModels, newFilmProject, type FilmReference } from './components/film/film-project';
import { filmGenerationValues } from './components/film/film-references';

const vendor = VENDOR_TEMPLATES.video.find(t => t.models.includes('wan3.0-video'))!;
const provider = { id: 'wan3', name: '万相官方直连', vendor: 'HopBase', service_type: 'video' as const, priority: 1, default_model: 'wan3.0-video', model_list: ['wan3.0-video'], parameter_schema: vendor.parameterSchema };
const template = getModelTemplate('wan3.0-video', provider)!;

describe('HopBase Wan 3.0', () => {
  it('uses the dedicated DashScope paths and exact model ID', () => {
    expect(vendor).toMatchObject({ models: ['wan3.0-video'], apiSpec: 'custom', protocol: 'native', baseURL: 'https://api.hop-base.com', submitEndpoint: '/api/v1/services/aigc/video-generation/video-synthesis', queryEndpoint: '/api/v1/tasks/{taskId}' });
    expect(template).toMatchObject({ supportsAutoDuration: true, supportsAutoAspect: true, supportsSeed: true, audioSettingOptions: ['on', 'off'], durationRange: { min: 2, max: 30, step: 1, defaultValue: 5 }, defaults: { resolution: '1080P' } });
    expect(template.resolutionOptions).toEqual(['480P', '720P', '1080P']);
    expect(template.aspectRatioOptions).not.toContain('21:9');
    expect(buildModelRequestBody(template, '雨庭交锋', { model: 'wan3.0-video', durationSeconds: -1 })).toMatchObject({ duration: -1 });
  });

  it('uses model-specific image/video/audio bounds and rejects mixed frame mode', () => {
    const mixed = template.referenceRequirements!['all-in-one'];
    expect(isModeSatisfied('all-in-one', { images: 10, videos: 5, audios: 5 }, mixed)).toBe(true);
    for (const counts of [{ images: 11, videos: 0, audios: 0 }, { images: 1, videos: 6, audios: 0 }, { images: 1, videos: 0, audios: 6 }]) {
      expect(isModeSatisfied('all-in-one', counts, mixed)).toBe(false);
    }
    expect(isModeSatisfied('first-last', { images: 2, videos: 0, audios: 0 }, template.referenceRequirements!['first-last'])).toBe(true);
    expect(isModeSatisfied('first-last', { images: 2, videos: 0, audios: 1 }, template.referenceRequirements!['first-last'])).toBe(false);
  });

  it.each([-1, 2, 30])('preserves duration %s and references through film generation', duration => {
    const p = newFilmProject();
    const model = filmModels([provider])[0];
    const saved = { duration, mode: 'all-in-one' as const, audio: false };
    const values = filmGenerationValues(model, p, saved);
    expect(values.duration).toBe(duration);
    const refs: FilmReference[] = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `图${i}`, kind: 'image', url: `https://cdn.example.com/${i}.png`, duration: 0 }));
    const payload = filmMediaPayload(model, p, '雨庭交锋', 'video', refs, values);
    expect(payload).toMatchObject({ provider_config_id: 'wan3', model: 'wan3.0-video', duration, resolution: '1080P', audio_setting: 'off', reference_mode: 'image_reference' });
    expect(payload.reference_images).toHaveLength(10);
    expect(() => filmMediaPayload(model, p, '雨庭交锋', 'video', refs, { ...values, duration: 31 })).toThrow('时长');
  });
});
