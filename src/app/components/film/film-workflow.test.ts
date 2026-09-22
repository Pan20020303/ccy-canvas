/* @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { filmAssetDescriptionPayload, filmAssetPreparationIssue, filmStepIssue } from './film-workflow';
import { ASSET_PROMPT_TEMPLATES, filmModels, filmPrompt, newFilmProject, type FilmJob } from './film-project';
import { applyFilmResult } from './film-store';
import { adoptScriptRevision, scriptDoctorResult } from './film-script-doctor';
import { filmGenerationValues, filmImageRequest, filmReferences, filmShotVideoRequest } from './film-references';

const models = filmModels([
  { id: 'text', service_type: 'text', name: '编剧', vendor: 'OpenAI', priority: 1, default_model: 'gpt-4.1', model_list: [] },
  { id: 'image', service_type: 'image', name: '生图', vendor: 'OpenAI', priority: 1, default_model: 'gpt-image-1', model_list: [] },
  { id: 'video', service_type: 'video', name: '视频', vendor: 'Volcengine', priority: 1, default_model: 'doubao-seedance-2-5-260628', model_list: [] },
]);
function readyProject() {
  const p = newFilmProject(); p.script = '旅人带着信封走过雨庭，看见守兵。';
  Object.assign(p, scriptDoctorResult(p, { id: 'doctor', kind: 'doctor', nodeId: 'doctor', startedAt: 1, status: 'success', sourceScript: p.script, payload: { service_type: 'text', model: 'test', prompt: '' } }, JSON.stringify({ optimizedScript: p.script })));
  Object.assign(p, adoptScriptRevision(p, 'doctor'));
  p.assets = [ ['person', '旅人', 'character'], ['guard', '守兵', 'character'], ['scene', '雨庭', 'scene'], ['letter', '信封', 'prop'], ['sword', '长剑', 'prop'] ].map(([id, name, type]) => ({ id, name, type: type as 'character' | 'scene' | 'prop', description: name, url: `/${id}.png`, source: 'uploaded', locked: false, history: [] }));
  return p;
}
const jobFor = (p: ReturnType<typeof readyProject>, kind: FilmJob['kind']): FilmJob => ({ id: kind, kind, nodeId: kind, startedAt: 1, status: 'running', sourceScript: p.script, payload: { service_type: 'text', model: 'gpt-4.1', prompt: '测试' } });

describe('connected film production workflow', () => {
  it('requires script and complete reference images before first storyboard, without requiring generated rather than uploaded assets', () => {
    const p = newFilmProject(); expect(filmStepIssue(p, 1)).toContain('剧本');
    p.script = '故事'; expect(filmStepIssue(p, 3)).toContain('剧本医生');
    const ready = readyProject(); expect(filmAssetPreparationIssue(ready)).toBeUndefined();
    ready.assets[0].url = undefined; expect(filmStepIssue(ready, 3)).toContain('旅人');
    ready.assets[0].url = '/person.png'; ready.jobs.push(jobFor(ready, 'describe'));
    expect(filmAssetPreparationIssue(ready)).toContain('处理中');
  });
  it('uses separate description templates with the configured LLM, script and real skill body', () => {
    const p = readyProject(); p.settings.extractModel = 'text:gpt-4.1'; p.settings.extractSkillId = 's';
    p.settings.assetPromptTemplates = { character: '固定正面全身，保持服装细节。', scene: '' };
    const request = filmAssetDescriptionPayload(p, p.assets[0], models, [{ id: 's', name: '资产专家', enabled: true, kind: 'prompt', scope: 'personal', spec: { content_md: '不要改变角色年龄。' }, description: '', category: '', icon: '', input_schema: {}, output_schema: {}, created_at: '', updated_at: '' }]);
    expect(request).toMatchObject({ provider_config_id: 'text', service_type: 'text', model: 'gpt-4.1' });
    expect(request.prompt).toContain('固定正面全身'); expect(request.prompt).toContain('不要改变角色年龄'); expect(request.prompt).toContain(p.script);
    expect(filmPrompt(p, 'extract')).toContain(ASSET_PROMPT_TEMPLATES.scene);
    expect(() => filmAssetDescriptionPayload(p, p.assets[0], models, [])).toThrow('技能不可用');
  });
  it('auto-binds every mentioned or explicit asset at split time, including names in video prompts and more than four references', () => {
    const p = readyProject();
    const result = applyFilmResult(p, jobFor(p, 'split'), JSON.stringify({ shots: [
      { title: '雨庭交锋', description: '两人对视', characters: ['旅人', '守兵'], scene: '雨庭', props: ['信封'], videoPrompt: '守兵握紧长剑。' },
      { title: '空镜', description: '雨庭的积水' },
    ] }));
    p.shots = result.shots!;
    expect(new Set(p.shots[0].assetIds)).toEqual(new Set(p.assets.map(a => a.id)));
    expect(p.shots[0].autoBindReferences).toBe(true);
    expect(filmReferences(p, p.shots[0].id, 'video')).toHaveLength(5);
    expect(filmReferences(p, p.shots[1].id, 'video').map(r => r.assetId)).toEqual(['scene']);
    const request = filmShotVideoRequest(p, p.shots[0], models);
    expect(request.reference_images).toHaveLength(5); expect(request.prompt).toContain('人物「守兵」'); expect(request.prompt).toContain('道具「长剑」');
  });
  it('keeps optional positioning per shot, rejects missing assets and never uses a character sheet as an image-to-video first frame', () => {
    const p = readyProject(); p.shots = applyFilmResult(p, jobFor(p, 'split'), '{"shots":[{"description":"旅人在雨庭"},{"description":"雨庭空镜"}]}').shots!;
    const shot = p.shots[0]; shot.references = [{ id: 'pose', name: '站位', kind: 'image', layer: 'position', url: '/pose.png', duration: 0 }];
    expect(filmReferences(p, shot.id, 'image').map(r => r.url)).toContain('/pose.png');
    expect(filmReferences(p, p.shots[1].id, 'image').map(r => r.url)).not.toContain('/pose.png');
    p.assets[0].url = undefined; expect(() => filmShotVideoRequest(p, shot, models)).toThrow('旅人');
    p.settings.method = 'image'; expect(filmStepIssue(p, 4)).toContain('先完成');
    expect(() => filmShotVideoRequest(p, shot, models)).toThrow('先生成');
    shot.imageUrl = '/approved.png'; shot.generation = { video: { mode: 'all-in-one' } };
    expect(filmShotVideoRequest(p, shot, models).reference_images).toEqual(['/approved.png']);
    expect(filmGenerationValues(models.find(m => m.type === 'video'), p, shot.generation.video!, shot).mode).toBe('first-last');
  });
  it('adds grid instructions to manual image and video prompts and gates preview on complete videos', () => {
    const p = readyProject(); p.settings.method = 'grid'; p.shots = applyFilmResult(p, jobFor(p, 'split'), '{"shots":[{"description":"雨庭空镜"}]}').shots!;
    expect(filmImageRequest(p, p.shots[0].id, 'image', models).prompt).toContain('2x2四宫格');
    p.shots[0].imageUrl = '/grid.png'; expect(filmStepIssue(p, 4)).toBeUndefined();
    expect(filmShotVideoRequest(p, p.shots[0], models).prompt).toContain('不保留宫格边框');
    expect(filmStepIssue(p, 5)).toContain('分镜视频'); p.shots[0].videoUrl = '/video.mp4'; expect(filmStepIssue(p, 5)).toBeUndefined();
  });
  it('persists asynchronous LLM descriptions without changing images or overwriting manual prompt edits', () => {
    const p = readyProject(), job = { ...jobFor(p, 'describe'), targetId: 'person', sourceAssetPrompt: '' };
    const result = applyFilmResult(p, job, '新的角色参考图描述');
    expect(result.assets?.[0]).toMatchObject({ generationPrompt: '新的角色参考图描述', url: '/person.png' });
    p.assets[0].generationPrompt = '手工内容'; expect(() => applyFilmResult(p, job, '旧描述')).toThrow('未覆盖');
    expect(p.assets[0].generationPrompt).toBe('手工内容');
  });
});
