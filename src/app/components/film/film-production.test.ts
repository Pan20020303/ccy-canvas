import { describe, expect, it } from 'vitest';
import type { Skill } from '../../api/skills';
import { filmModels, filmPromptSkills, filmSkillBody, filmTextPayload, newFilmProject } from './film-project';

const models = filmModels([{ id: 'writing', name: '文字渠道', vendor: 'OpenAI', service_type: 'text', priority: 1, default_model: 'writer', model_list: ['writer', 'director'] }]);
const skill = (id: string, overrides: Partial<Skill> = {}): Skill => ({ id, name: id, description: '', category: '故事创作', icon: '', scope: 'personal', kind: 'prompt', enabled: true, spec: { content_md: `${id} 的技能指令` }, input_schema: {}, output_schema: {}, created_at: '', updated_at: '', ...overrides });

describe('film production configuration', () => {
  it('selects extraction and storyboard models and skills independently', () => {
    const p = newFilmProject(); p.script = '旅人在车站捡到一封信。';
    p.settings.extractModel = 'writing:writer'; p.settings.extractSkillId = '资产专家';
    p.settings.splitModel = 'writing:director'; p.settings.splitSkillId = '分镜导演';
    const skills = [skill('资产专家'), skill('分镜导演')];
    const extract = filmTextPayload(p, 'extract', models, skills);
    const split = filmTextPayload(p, 'split', models, skills);
    expect(extract).toMatchObject({ model: 'writer', provider_config_id: 'writing', service_type: 'text' });
    expect(extract.prompt).toContain('资产专家 的技能指令'); expect(extract.prompt).not.toContain('分镜导演');
    expect(extract.prompt).toContain('assetsList'); expect(extract.prompt).toContain(p.script);
    expect(split.model).toBe('director'); expect(split.prompt).toContain('分镜导演 的技能指令');
    expect(split.prompt).toContain('"assetIds"'); expect(split.prompt).not.toContain('资产专家');
  });
  it('inherits the default model and keeps built-in output contracts without a skill', () => {
    const p = newFilmProject(); p.settings.textModel = 'writing:director';
    for (const kind of ['write', 'extract', 'split'] as const) expect(filmTextPayload(p, kind, models, []).model).toBe('director');
    p.settings.textModel = '';
    expect(filmTextPayload(p, 'extract', models, []).model).toBe('writer');
    expect(filmTextPayload(p, 'extract', models, []).prompt).not.toContain('<skill>');
  });
  it('refuses missing or disabled selections instead of silently falling back', () => {
    const p = newFilmProject(); p.settings.extractModel = 'removed';
    expect(() => filmTextPayload(p, 'extract', models, [])).toThrow('模型不可用');
    p.settings.extractModel = ''; p.settings.extractSkillId = 'disabled';
    expect(() => filmTextPayload(p, 'extract', models, [skill('disabled', { enabled: false })])).toThrow('技能已停用');
    expect(() => filmTextPayload(p, 'extract', models, [])).toThrow('技能已停用');
    p.settings.extractSkillId = ''; p.settings.textModel = 'removed';
    expect(() => filmTextPayload(p, 'split', models, [])).toThrow('模型不可用');
    p.settings.splitModel = 'writing:director';
    expect(filmTextPayload(p, 'split', models, []).model).toBe('director');
  });
  it('uses real prompt content only, including system instructions and legacy templates', () => {
    const s = skill('legacy', { spec: { system_prompt: '镜头连续性专家', user_template: '锁定角色和场景' } });
    expect(filmSkillBody(s)).toBe('镜头连续性专家\n\n锁定角色和场景');
    expect(filmPromptSkills([s, skill('http', { kind: 'http' }), skill('off', { enabled: false }), skill('empty', { spec: {} })])).toEqual([s]);
    expect(filmSkillBody(skill('modern', { spec: { content_md: '新指令', user_template: '旧指令' } }))).toBe('新指令');
  });
});
