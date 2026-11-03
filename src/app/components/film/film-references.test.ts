import { describe, expect, it } from 'vitest';
import { filmGenerationValues, filmReferenceLabels, filmReferencePrompt, filmReferences, filmRefToken, filmShotVideoRequest } from './film-references';
import { filmMediaPayload, filmModels, filmShotPrompt, newFilmProject, type FilmReference } from './film-project';
const models = filmModels([{ id: 'v', name: '官方', vendor: 'Volcengine', service_type: 'video', priority: 1, default_model: 'doubao-seedance-2-5-260628', model_list: [] }]);
function project() {
  const p = newFilmProject();
  p.assets = [{ id: 'person', type: 'character', name: '旅人', url: '/person.png', description: '旅人', source: 'uploaded', locked: false, history: [] }, { id: 'scene', type: 'scene', name: '车站', url: '/scene.png', description: '车站', source: 'uploaded', locked: false, history: [] }, { id: 'prop', type: 'prop', name: '信件', description: '信件', source: 'uploaded', locked: false, history: [] }];
  p.shots = [{ id: 's1', title: '镜头1', description: '旅人进入车站', shot: '全景', duration: '4s', status: 'draft', assetIds: ['person', 'scene', 'prop'], history: [] }, { id: 's2', title: '镜头2', description: '车站空镜', shot: '全景', duration: '5s', status: 'draft', assetIds: ['scene'], history: [] }];
  return p;
}
describe('per-shot reference layers and output parameters', () => {
  it('binds only this shot assets and fills in a newly available asset image automatically', () => {
    const p = project();
    expect(filmReferences(p, 's1', 'video').map(r => r.name)).toEqual(['旅人', '车站']);
    expect(filmReferences(p, 's2', 'video').map(r => r.name)).toEqual(['车站']);
    p.assets[2].url = '/letter.png'; expect(filmReferences(p, 's1', 'video')).toHaveLength(3);
    p.assets[0].url = '/new-person.png'; expect(filmReferences(p, 's1', 'video')[0].url).toBe('/new-person.png');
  });
  it('preserves explicit legacy references and supports excluding an automatic asset', () => {
    const p = project(); p.shots[0].references = [];
    expect(filmReferences(p, 's1', 'video')).toEqual([]);
    p.shots[0].autoBindReferences = true; p.shots[0].excludedReferenceIds = ['asset:person'];
    expect(filmReferences(p, 's1', 'video').map(r => r.name)).toEqual(['车站']);
  });
  it('keeps stable token identity when another reference is removed and numbers each media type separately', () => {
    const refs: FilmReference[] = [{ id: 'a', name: 'A', kind: 'image', url: '/a.png', duration: 0 }, { id: 'b', name: 'B', kind: 'image', url: '/b.png', duration: 0 }, { id: 'v', name: 'V', kind: 'video', url: '/v.mp4', duration: 4 }];
    const text = '动作参考' + filmRefToken(refs[1]);
    expect(filmReferencePrompt(text, refs)).toContain('动作参考@图像2');
    expect(filmReferencePrompt(text, refs.slice(1))).toContain('动作参考@图像1');
    expect(filmReferenceLabels(refs).map(r => r.label)).toEqual(['@image1', '@image2', '@video1']);
    expect(() => filmReferencePrompt(text, refs.slice(0, 1))).toThrow('已移除');
  });
  it('uses the identical per-shot model, references, prompt and parameters for batch and individual generation', () => {
    const p = project(); p.shots[0].assetIds = ['person', 'scene']; p.shots[0].generation = { video: { modelKey: models[0].key, ratio: '16:9', resolution: '1080p', duration: 8, mode: 'all-in-one', outputFormat: 'mov', audio: true } };
    const shot = p.shots[0], refs = filmReferences(p, shot.id, 'video'), values = filmGenerationValues(models[0], p, shot.generation!.video!, shot);
    const individual = filmMediaPayload(models[0], p, filmReferencePrompt(filmShotPrompt(shot, true), refs), 'video', refs, values);
    expect(filmShotVideoRequest(p, shot, models)).toEqual(individual);
    expect(individual).toMatchObject({ aspect_ratio: '16:9', resolution: '1080p', duration: 8, output_format: 'mov', reference_images: ['/person.png', '/scene.png'] });
    const second = filmShotVideoRequest(p, p.shots[1], models);
    expect(second.reference_images).toEqual(['/scene.png']); expect(second.aspect_ratio).toBe('9:16'); expect(second.duration).toBe(5);
  });
  it('does not silently send a batch through a replacement for a removed model', () => {
    const p = project(); p.shots[0].generation = { video: { modelKey: 'removed' } };
    expect(() => filmShotVideoRequest(p, p.shots[0], models)).toThrow('模型不可用');
  });
  it('never treats an auto-filled reference legend as a prompt for an empty shot', () => {
    const p = project(); p.shots[0].description = '';
    expect(() => filmShotVideoRequest(p, p.shots[0], models)).toThrow('填写生成描述');
  });
});
