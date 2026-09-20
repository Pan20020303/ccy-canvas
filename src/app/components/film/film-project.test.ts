import { describe, expect, it } from 'vitest';
import { getModelTemplate } from '../../model-templates';
import { projectDuration, type EditorAsset } from '../../video-editor-project';
import type { AppProviderConfig } from '../../api/providerConfigs';
import { buildFilmTimeline, filmMediaPayload, filmModels, filmPrompt, filmShotPrompt, newFilmProject, type FilmModel, type FilmShot } from './film-project';

export const filmTestProvider: AppProviderConfig = { id: 'ark-test', vendor: 'Volcengine', name: '官方渠道', service_type: 'video', model_list: ['doubao-seedance-2-5-260628'], default_model: 'doubao-seedance-2-5-260628', priority: 1 };
const model = (): FilmModel => ({ key: 'ark', model: filmTestProvider.default_model, name: 'Seedance 2.5', provider: filmTestProvider, type: 'video', template: getModelTemplate(filmTestProvider.default_model, filmTestProvider) });
const ref = (kind: EditorAsset['kind'], i: number): EditorAsset => ({ id: `${kind}-${i}`, name: `${kind}-${i}`, kind, url: `https://media.example/${kind}-${i}`, duration: kind === 'image' ? 0 : 3 });
const params = { mode: 'all-in-one' as const, duration: 15, resolution: '1080p', audio: true, outputFormat: 'mov' };
const shot = (id: string, extra: Partial<FilmShot> = {}): FilmShot => ({ id, title: id, description: '旅人抬头看向列车', shot: '中景', duration: '4s', status: 'draft', assetIds: [], history: [], ...extra });

describe('one-click film model and timeline contracts', () => {
  it('uses actual provider IDs and model IDs while respecting hidden model entries', () => {
    const configured = { ...filmTestProvider, model_list: ['doubao-seedance-2-5-260628', 'hidden'], parameter_schema: { vendor_models: [{ modelName: 'hidden', hidden: true }, { modelName: filmTestProvider.default_model, name: '即梦官方2.5' }] } };
    const models = filmModels([configured]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model: filmTestProvider.default_model, name: '即梦官方2.5', type: 'video' });
  });
  it('preserves Seedance 2.5 1080p, MOV, audio and all 50 model-declared reference slots', () => {
    const refs = [...Array.from({ length: 30 }, (_, i) => ref('image', i)), ...Array.from({ length: 10 }, (_, i) => ref('video', i)), ...Array.from({ length: 10 }, (_, i) => ref('audio', i))];
    const payload = filmMediaPayload(model(), newFilmProject(), '明亮的饼干广告', 'video', refs, params);
    expect(payload).toMatchObject({ provider_config_id: 'ark-test', model: filmTestProvider.default_model, resolution: '1080p', duration: 15, audio_setting: 'on', output_format: 'mov', parameters: { output_format: 'mov' }, aspect_ratio: '9:16' });
    expect(payload.reference_images).toHaveLength(30);
    expect(payload.reference_videos).toHaveLength(10);
    expect(payload.reference_audios).toHaveLength(10);
    expect(payload.prompt).toContain('统一画面风格');
    expect(() => filmMediaPayload(model(), newFilmProject(), '广告', 'video', [...refs, ref('image', 31)], params)).toThrow('数量');
  });
  it('validates resolution, duration, mode, aspect ratio and audio before sending billable requests', () => {
    const p = newFilmProject(), m = model();
    expect(() => filmMediaPayload(m, p, '视频', 'video', [], { ...params, resolution: '4k' })).toThrow('分辨率');
    expect(() => filmMediaPayload(m, p, '视频', 'video', [], { ...params, duration: 31 })).toThrow('时长');
    expect(() => filmMediaPayload(m, p, '视频', 'video', [ref('audio', 0)], { ...params, mode: 'text-to-video' })).toThrow('音频');
    expect(() => filmMediaPayload(m, p, ' ', 'video', [], params)).toThrow('描述');
    const wideOnly = { ...m, template: { ...m.template!, aspectRatioOptions: ['16:9'] } };
    expect(() => filmMediaPayload(wideOnly, p, '视频', 'video', [], params)).toThrow('画幅');
  });
  it('uses the single-media fields for one video/audio like existing canvas requests', () => {
    const payload = filmMediaPayload(model(), newFilmProject(), '动作参考', 'video', [ref('video', 0), ref('audio', 0)], params);
    expect(payload.reference_video).toBe('https://media.example/video-0');
    expect(payload.reference_audio).toBe('https://media.example/audio-0');
    expect(payload.reference_videos).toBeUndefined();
  });
  it('builds a continuous timeline using real video duration, not the requested generation length', () => {
    const p = newFilmProject();
    p.shots = [shot('a', { videoUrl: '/a.mp4', videoDuration: 6.7 }), shot('b', { imageUrl: '/b.png', duration: '3s' }), shot('missing')];
    const timeline = buildFilmTimeline(p);
    expect(timeline.ratio).toBe('9:16');
    expect(timeline.clips).toHaveLength(2);
    expect(timeline.clips[0]).toMatchObject({ start: 0, end: 6.7, at: 0 });
    expect(timeline.clips[1]).toMatchObject({ start: 0, end: 3, at: 6.7 });
    expect(projectDuration(timeline)).toBeCloseTo(9.7);
    expect(buildFilmTimeline(newFilmProject()).clips).toEqual([]);
    p.shots = [shot('unknown', { videoUrl: '/unknown.mp4' })];
    expect(() => buildFilmTimeline(p)).toThrow('真实时长');
  });
  it('keeps motion prompts separate from still-image prompts and carries actual asset IDs to the model', () => {
    const s = shot('a', { prompt: '静态构图', camera: '缓慢推进', action: '抬头', continuity: '保持同一服饰' });
    expect(filmShotPrompt(s, false)).toBe('静态构图');
    expect(filmShotPrompt(s, true)).toContain('运镜：缓慢推进');
    expect(filmShotPrompt({ ...s, videoPrompt: '用户的视频描述' }, true)).toBe('用户的视频描述');
    const p = newFilmProject(); p.script = '真实剧本'; p.settings.shotCount = 8; p.settings.method = 'grid';
    const prompt = filmPrompt(p, 'split');
    expect(prompt).toContain('8 个镜头'); expect(prompt).toContain('2x2'); expect(prompt).toContain('真实剧本');
  });
});
