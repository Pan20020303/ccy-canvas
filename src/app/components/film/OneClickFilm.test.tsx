/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FilmWorkspace } from './OneClickFilm';
import { filmStore } from './film-store';
import type { AppProviderConfig } from '../../api/providerConfigs';
import { adoptScriptRevision, scriptDoctorResult } from './film-script-doctor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ user: '', configs: vi.fn(), skills: vi.fn(), createSkill: vi.fn(), generate: vi.fn(), navigate: vi.fn() }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: state.user } }) }));
vi.mock('react-router', async () => ({ ...await vi.importActual('react-router'), useNavigate: () => state.navigate }));
vi.mock('../../api/providerConfigs', async () => ({ ...await vi.importActual('../../api/providerConfigs'), listAppProviderConfigs: state.configs, generate: state.generate }));
vi.mock('../../api/skills', () => ({ listSkills: state.skills, createSkill: state.createSkill }));
vi.mock('../../api/projects', async () => ({ ...await vi.importActual('../../api/projects'), createProject: vi.fn().mockResolvedValue({ id: 'film-project' }) }));
vi.mock('./FilmPreview', () => ({ FilmPreview: () => <div className="preview-test">成片预览</div> }));
const configs: AppProviderConfig[] = [
  { id: 'text-channel', service_type: 'text', vendor: 'OpenAI', name: '编剧渠道', default_model: 'gpt-4.1', model_list: ['gpt-4.1', 'gpt-4.1-mini'], priority: 1 },
  { id: 'video-channel', service_type: 'video', vendor: 'Volcengine', name: '官方渠道', default_model: 'doubao-seedance-2-5-260628', model_list: ['doubao-seedance-2-5-260628'], priority: 1 },
];
describe('film workspace interactions', () => {
  let host: HTMLDivElement, root: Root;
  const render = () => act(async () => { root.render(<MemoryRouter><FilmWorkspace userId={state.user} /></MemoryRouter>); });
  const click = async (name: string) => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.trim() === name || b.getAttribute('aria-label') === name || b.title === name);
    expect(b, name).toBeTruthy(); await act(async () => b!.click());
  };
  const fill = async (selector: string, text: string) => {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!; expect(input).toBeTruthy();
    await act(async () => { if (input.getAttribute('contenteditable') === 'true') input.textContent = text; else Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const select = async (label: string, value: string) => {
    const field = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; expect(field).toBeTruthy();
    await act(async () => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  const approveScript = () => {
    const store = filmStore(state.user), p = store.getState().project;
    const reviewed = { ...p, ...scriptDoctorResult(p, { id: 'reviewed', kind: 'doctor', sourceScript: p.script, nodeId: 'reviewed', startedAt: 1, status: 'success', payload: { service_type: 'text', model: 'test', prompt: '' } }, JSON.stringify({ optimizedScript: p.script })) };
    store.getState().patch({ ...reviewed, ...adoptScriptRevision(reviewed, 'reviewed') });
  };
  beforeEach(() => {
    state.user = crypto.randomUUID(); state.configs.mockResolvedValue(configs);
    state.skills.mockResolvedValue([
      { id: 'extract-skill', name: '资产提取专家', scope: 'personal', enabled: true, kind: 'prompt', spec: { content_md: '锁定角色的外貌和场景细节' } },
      { id: 'split-skill', name: '电影分镜导演', scope: 'global', enabled: true, kind: 'prompt', spec: { user_template: '规划景别和连续运镜' } },
      { id: 'disabled', name: '停用技能', enabled: false, kind: 'prompt', spec: { content_md: '不要出现' } },
      { id: 'http', name: '网络技能', enabled: true, kind: 'http', spec: {} },
    ]);
    state.generate.mockResolvedValue({ type: 'text', content: '{"assetsList":[{"name":"车站","type":"scene","desc":"清晨的车站","prompt":"云中的车站参考图"}]}' });
    state.createSkill.mockImplementation(async payload => ({ ...payload, id: 'imported-skill', scope: 'personal' }));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });
  it('automatically opens real task steps after extraction and persists the result', async () => {
    filmStore(state.user).getState().patch({ script: '旅人来到车站', step: 2 });
    await render(); await click('提取场景角色道具');
    expect(document.querySelector('[aria-label="生成任务与执行步骤"]')).toBeTruthy();
    await act(async () => { await vi.waitFor(() => expect(filmStore(state.user).getState().project.jobs.some(j => j.status === 'success')).toBe(true)); });
    expect(document.querySelector('.film-job-steps')?.textContent).toContain('解析与校验内容');
    expect(document.querySelector('.film-job-result')?.textContent).toContain('已写入 1 个资产');
    expect(state.generate.mock.calls[0][0].prompt).toContain('【创作工作台 v2.5.2');
    expect(document.querySelector('.film-job')?.textContent).toContain('个技能章节');
  });
  it('reviews and edits an independently saved doctor draft, explicitly adopts it and requires asset rechecking before splitting', async () => {
    const store = filmStore(state.user);
    store.getState().patch(p => ({ script: '旅人来到车站。', step: 2, settings: { ...p.settings, doctorModel: 'text-channel:gpt-4.1-mini', creativeSkills: { enabled: false } }, assets: [{ id: 'scene', name: '车站', type: 'scene', description: '站台', url: '/scene.png', source: 'uploaded', locked: false, history: [] }] }));
    state.generate.mockResolvedValue({ type: 'text', content: JSON.stringify({ optimizedScript: '旅人提着行李，走上车站台阶。', summary: '动作更清楚', changes: ['明确持物和移动'], questions: [], assetNotes: ['行李需核对'] }) });
    await render(); await click('剧本医生优化');
    expect(state.generate).not.toHaveBeenCalled(); await click('开始诊断并优化');
    await act(async () => { await vi.waitFor(() => expect(store.getState().project.scriptDoctor?.revisions).toHaveLength(1)); });
    expect(store.getState().project.script).toBe('旅人来到车站。');
    expect(state.generate.mock.calls[0][0]).toMatchObject({ model: 'gpt-4.1-mini', prompt: expect.stringContaining('【技能资料：剧情、情绪与动作诊断】') });
    await fill('[aria-label="剧本医生优化稿"]', '旅人握住行李把手，走上车站台阶。');
    await click('暂不采用，保留草稿'); await click('查看剧本优化稿');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="剧本医生优化稿"]')?.value).toContain('握住');
    await click('确认采用优化稿');
    expect(store.getState().project.script).toContain('握住'); expect(store.getState().project.scriptHistory.at(-1)?.text).toBe('旅人来到车站。');
    expect(store.getState().project.assets[0].url).toBe('/scene.png');
    await click('下一步·分镜脚本'); expect(store.getState().project.step).toBe(2);
    expect(document.querySelector('[aria-label="优化后资产核对"]')).toBeTruthy();
    await click('已核对资产，继续使用'); await click('下一步·分镜脚本'); expect(store.getState().project.step).toBe(3);
    state.generate.mockResolvedValue({ type: 'text', content: '{"shots":[{"description":"旅人进入车站"}]}' });
    await click('生成分镜脚本');
    await act(async () => { await vi.waitFor(() => expect(store.getState().project.shots).toHaveLength(1)); });
    expect(state.generate.mock.calls[1][0].prompt).toContain('旅人握住行李把手，走上车站台阶。');
    expect(state.generate).toHaveBeenCalledTimes(2);
  });
  it('lets old storyboards remain editable but opens the doctor before append, without a paid call', async () => {
    const store = filmStore(state.user); store.getState().patch({ script: '原稿', step: 3, shots: [{ id: 'old', title: '旧镜', description: '旧描述', shot: '全景', duration: '4s', assetIds: [], history: [], status: 'draft' }] });
    await render(); await fill('[aria-label="当前分镜脚本"]', '手工修改的旧镜');
    await click('追加分镜'); expect(document.querySelector('.film-doctor-dialog')).toBeTruthy(); expect(state.generate).not.toHaveBeenCalled();
    expect(store.getState().project.shots[0].description).toBe('手工修改的旧镜');
  });
  it('keeps generation parameters independent across shots, close/reopen and saves', async () => {
    const store = filmStore(state.user);
    store.getState().patch({ step: 4, shots: ['s1', 's2'].map((id, index) => ({ id, title: `镜头${index + 1}`, description: '车站', shot: '全景', duration: '4s', status: 'draft', assetIds: [], history: [] })) });
    await render(); await click('点击编辑'); await click('输出参数'); await click('分辨率 1080p'); await click('输出格式 mov'); await click('关闭输出参数'); await click('下一项');
    expect(document.querySelector('.film-output-summary')?.textContent).not.toContain('1080p');
    expect(store.getState().project.shots[1].generation).toBeUndefined();
    await click('上一项'); expect(document.querySelector('.film-output-summary')?.textContent).toContain('1080p');
    await click('返回'); await click('点击编辑'); expect(document.querySelector('.film-output-summary')?.textContent).toContain('1080p');
    expect(store.getState().project.shots[0].generation?.video).toMatchObject({ resolution: '1080p', outputFormat: 'mov' });
  });
  it('exposes Wan 3 auto duration and keeps it when reopening the shot', async () => {
    state.configs.mockResolvedValue([{ id: 'wan3', service_type: 'video', vendor: 'HopBase', name: '万相官方直连', default_model: 'wan3.0-video', model_list: ['wan3.0-video'], priority: 1 }]);
    const store = filmStore(state.user);
    store.getState().patch(p => ({ step: 4, settings: { ...p.settings, videoModel: 'wan3:wan3.0-video' }, shots: [{ id: 'wan-shot', title: '雨庭', description: '雨庭交锋', shot: '全景', duration: '30s', assetIds: [], status: 'draft', history: [] }] }));
    await render(); await click('点击编辑'); await click('输出参数');
    expect(document.querySelector<HTMLInputElement>('[aria-label="视频时长"]')?.max).toBe('30');
    expect(document.querySelector('[aria-label="分辨率 1080P"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="生成音频"]')).toBeTruthy();
    await click('自动时长'); await click('关闭输出参数');
    expect(document.querySelector('.film-output-summary')?.textContent).toContain('自动');
    expect(store.getState().project.shots[0].generation?.video?.duration).toBe(-1);
    await click('返回'); await click('点击编辑');
    expect(document.querySelector('.film-output-summary')?.textContent).toContain('自动');
    expect(state.generate).not.toHaveBeenCalled();
  });
  it('renders per-shot asset layers and inserts a real inline thumbnail mention without generating', async () => {
    const store = filmStore(state.user);
    store.getState().patch({ step: 4, assets: [{ id: 'a', name: '旅人', type: 'character', description: '', source: 'uploaded', locked: false, url: '/person.png', history: [] }, { id: 'b', name: '信封', type: 'prop', description: '', source: 'uploaded', locked: false, history: [] }], shots: [{ id: 's', title: '镜头', description: '走来', shot: '全景', duration: '4s', assetIds: ['a','b'], status: 'draft', history: [] }] });
    await render(); await click('点击编辑');
    expect(document.querySelector('[aria-label="人物参考层"] img')?.getAttribute('src')).toContain('/person.png');
    expect(document.querySelector('[aria-label="道具参考层"]')?.textContent).toContain('待上传参考图');
    await fill('[aria-label="生成描述"]', '@');
    await act(async () => { const el = document.querySelector('[aria-label="生成描述"]')!; const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('旅人');
    await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(document.querySelector('.film-inline-reference img')?.getAttribute('src')).toContain('/person.png');
    expect(store.getState().project.shots[0].videoPrompt).toContain('@{asset:a}');
    await click('移除旅人'); expect(store.getState().project.shots[0].videoPrompt).not.toContain('@{asset:a}');
    expect(document.querySelector('.film-reference-tile')).toBeNull(); expect(state.generate).not.toHaveBeenCalled();
  });
  it('imports the full Markdown body as a personal prompt skill and selects it for storyboards', async () => {
    const body = '# 草帽与梦\n\n每镜写时间码、光影与现场声。\n视频提示词保持自然语言。';
    await render(); await click('制作设置'); await click('导入分镜技能');
    await fill('[aria-label="分镜技能 Markdown 内容"]', `---\nname: 草帽与梦\ndescription: 电影分镜\n---\n\n${body}`);
    await click('导入并选用');
    expect(state.createSkill).toHaveBeenCalledWith(expect.objectContaining({ name: '草帽与梦', category: 'director_skills', enabled: true, kind: 'prompt', spec: expect.objectContaining({ content_md: body, user_template: body, slash_command: '草帽与梦' }) }));
    expect(document.querySelector<HTMLSelectElement>('[aria-label="分镜脚本技能"]')?.value).toBe('imported-skill');
    await click('保存设置'); expect(filmStore(state.user).getState().project.settings.splitSkillId).toBe('imported-skill');
    expect(state.generate).not.toHaveBeenCalled();
  });
  it('reuses an identical skill instead of creating a duplicate', async () => {
    await render(); await click('制作设置'); await click('导入分镜技能');
    await fill('[aria-label="分镜技能 Markdown 内容"]', '---\nname: 电影分镜导演\n---\n规划景别和连续运镜');
    await click('导入并选用');
    expect(state.createSkill).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLSelectElement>('[aria-label="分镜脚本技能"]')?.value).toBe('split-skill');
  });
  it('does not overwrite a different same-named skill', async () => {
    await render(); await click('制作设置'); await click('导入分镜技能');
    await fill('[aria-label="分镜技能 Markdown 内容"]', '---\nname: 电影分镜导演\n---\n另一版本');
    await click('导入并选用');
    expect(document.body.textContent).toContain('已有同名技能但内容不同');
    expect(state.createSkill).not.toHaveBeenCalled();
  });
  it('saves separate skills/models, restores them on reopening, and supports cancelling edits', async () => {
    await render(); await click('制作设置');
    expect(document.querySelector('.film-production-dialog')?.textContent).not.toContain('停用技能');
    expect(document.querySelector('.film-production-dialog')?.textContent).not.toContain('网络技能');
    await select('场景角色道具提取模型', 'text-channel:gpt-4.1-mini');
    await select('场景角色道具提取技能', 'extract-skill'); await select('分镜脚本技能', 'split-skill');
    await click('保存设置');
    expect(filmStore(state.user).getState().project.settings).toMatchObject({ extractModel: 'text-channel:gpt-4.1-mini', extractSkillId: 'extract-skill', splitSkillId: 'split-skill' });
    await click('制作设置');
    expect(document.querySelector<HTMLSelectElement>('[aria-label="场景角色道具提取技能"]')?.value).toBe('extract-skill');
    await select('场景角色道具提取技能', ''); await click('取消');
    expect(filmStore(state.user).getState().project.settings.extractSkillId).toBe('extract-skill');
    expect(state.generate).not.toHaveBeenCalled();
  });
  it('submits the configured model and actual skill instructions, including when retrying a failed task', async () => {
    const store = filmStore(state.user); store.getState().patch(p => ({ step: 2, script: '旅人来到车站。', settings: { ...p.settings, extractModel: 'text-channel:gpt-4.1-mini', extractSkillId: 'extract-skill' }, jobs: [{ id: 'failed', kind: 'extract', status: 'error', error: '旧模型出错', nodeId: 'old', startedAt: 1, sourceScript: '旅人来到车站。', payload: { service_type: 'text', model: 'old-model', prompt: '旧指令' } }] }));
    await render(); await act(async () => host.querySelector<HTMLButtonElement>('.film-task-button')!.click()); await click('重试');
    expect(state.skills).toHaveBeenCalledWith(true);
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4.1-mini', provider_config_id: 'text-channel', prompt: expect.stringContaining('锁定角色的外貌和场景细节') }));
    expect(store.getState().project.jobs[1].status).toBe('success');
    expect(store.getState().project.assets[0].name).toBe('车站');
  });
  it('persists workbench switches per project and cancellation leaves settings untouched', async () => {
    await render(); await click('制作设置');
    const enabled = () => document.querySelector<HTMLInputElement>('.film-creative-heading input')!;
    expect(enabled().checked).toBe(true);
    await select('打斗上下文', 'off'); await act(async () => enabled().click()); await click('保存设置');
    expect(filmStore(state.user).getState().project.settings.creativeSkills).toMatchObject({ enabled: false, fightMode: 'off' });
    await click('制作设置'); expect(enabled().checked).toBe(false);
    await act(async () => enabled().click()); await click('取消');
    expect(filmStore(state.user).getState().project.settings.creativeSkills?.enabled).toBe(false);
    expect(state.generate).not.toHaveBeenCalled();
  });
  it('does not append workbench content when disabled and keeps a manually selected skill', async () => {
    filmStore(state.user).getState().patch(p => ({ step: 2, script: '旅人来到车站', settings: { ...p.settings, extractSkillId: 'extract-skill', creativeSkills: { enabled: false } } }));
    await render(); await click('提取场景角色道具');
    await act(async () => { await vi.waitFor(() => expect(state.generate).toHaveBeenCalledOnce()); });
    expect(state.generate.mock.calls[0][0].prompt).not.toContain('【创作工作台');
    expect(state.generate.mock.calls[0][0].prompt).toContain('锁定角色的外貌和场景细节');
  });
  it('shows unavailable saved skills, blocks saving, and lets the user recover with built-in rules', async () => {
    filmStore(state.user).getState().patch(p => ({ settings: { ...p.settings, extractSkillId: 'deleted' } }));
    await render(); await click('制作设置');
    expect(document.querySelector<HTMLSelectElement>('[aria-label="场景角色道具提取技能"]')?.selectedOptions[0].textContent).toContain('不可用');
    const save = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === '保存设置')!;
    expect(save().disabled).toBe(true);
    await select('场景角色道具提取技能', ''); expect(save().disabled).toBe(false);
    await click('保存设置'); expect(filmStore(state.user).getState().project.settings.extractSkillId).toBe('');
  });
  it('reports skill loading errors and refreshes without losing unsaved model selections', async () => {
    state.skills.mockRejectedValueOnce(new Error('网络中断'));
    await render(); await click('制作设置');
    expect(document.querySelector('.film-production-dialog')?.textContent).toContain('技能加载失败：网络中断');
    await select('分镜脚本模型', 'text-channel:gpt-4.1-mini'); await click('刷新选项');
    expect(document.querySelector<HTMLSelectElement>('[aria-label="分镜脚本技能"]')?.textContent).toContain('电影分镜导演');
    expect(document.querySelector<HTMLSelectElement>('[aria-label="分镜脚本模型"]')?.value).toBe('text-channel:gpt-4.1-mini');
  });
  it('distinguishes failed jobs from completed jobs instead of showing success checks for both', async () => {
    const base = { kind: 'extract' as const, nodeId: 'extract-node', sourceScript: '', startedAt: Date.now(), payload: { service_type: 'text' as const, model: 'gpt-4.1', prompt: '提取资产' } };
    filmStore(state.user).getState().patch({ jobs: [
      { ...base, id: 'success', status: 'success' },
      { ...base, id: 'failed', status: 'error', error: '模型渠道鉴权失败' },
    ] });
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('.film-task-button')!.click());
    const failed = host.querySelectorAll('.film-job')[0];
    expect(failed.querySelector('[aria-label="生成失败"]')).not.toBeNull();
    expect(failed.querySelector('[aria-label="生成成功"]')).toBeNull();
    expect(failed.querySelector('.film-error')?.textContent).toBe('模型渠道鉴权失败');
    expect(host.querySelectorAll('[aria-label="生成成功"]')).toHaveLength(1);
  });
  it('opens the six-step workspace and persists the actual draft, style and last step', async () => {
    await render(); expect(host.querySelectorAll('.film-step')).toHaveLength(6);
    await act(async () => host.querySelector<HTMLButtonElement>('.film-script-option')!.click());
    await fill('[aria-label="剧本正文"]', '旅人来到车站。');
    await click('下一步·视频设定');
    expect(host.textContent).toContain('选择画面风格');
    await click('更多 →'); await click('2D');
    expect(document.querySelectorAll('.film-style-grid .film-style-card').length).toBeGreaterThan(1);
    await act(async () => document.querySelector<HTMLButtonElement>('.film-style-grid .film-style-card')!.click());
    await click('确认');
    expect(filmStore(state.user).getState().project.settings.style).toBe('anime');
    await act(async () => root.unmount()); root = createRoot(host); await render();
    expect(host.textContent).toContain('选择画面风格'); expect(filmStore(state.user).getState().project.script).toBe('旅人来到车站。');
  });
  it('supports manual assets without pretending that a generated image exists', async () => {
    filmStore(state.user).getState().patch({ script: '旅人来到车站。' });
    await render(); await click('场景角色道具'); await click('添加资产');
    await fill('.film-dialog input', '云上车站'); await click('添加并编辑');
    expect(document.querySelector('.film-media-editor')).toBeTruthy();
    expect(document.querySelector('.film-result-image')).toBeNull();
    await fill('[aria-label="生成描述"]', '白色浮云中的古老车站'); await click('返回');
    expect(filmStore(state.user).getState().project.assets[0]).toMatchObject({ name: '云上车站', generationPrompt: '白色浮云中的古老车站' });
    expect(filmStore(state.user).getState().project.assets[0].url).toBeUndefined();
  });
  it('never starts a paid task merely by advancing steps and blocks incomplete asset preparation', async () => {
    await render(); await click('视频设定');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('剧本');
    await act(async () => filmStore(state.user).getState().patch({ script: '旅人来到车站。' }));
    await click('下一步·视频设定'); await click('下一步·场景角色道具');
    expect(filmStore(state.user).getState().project.step).toBe(2);
    expect(state.generate).not.toHaveBeenCalled();
    await click('下一步·分镜脚本'); expect(filmStore(state.user).getState().project.step).toBe(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('剧本医生');
    expect(document.querySelector('.film-doctor-dialog')).toBeTruthy(); expect(state.generate).not.toHaveBeenCalled();
  });
  it('fills split prompts and asset groups immediately and edits bindings independently per shot', async () => {
    const store = filmStore(state.user);
    store.getState().patch({ script: '旅人走入车站，手持信封。', step: 2, assets: [
      { id: 'person', name: '旅人', type: 'character', description: '旅人', url: '/person.png', source: 'uploaded', locked: false, history: [] },
      { id: 'scene', name: '车站', type: 'scene', description: '车站', url: '/scene.png', source: 'uploaded', locked: false, history: [] },
      { id: 'letter', name: '信封', type: 'prop', description: '信封', url: '/letter.png', source: 'uploaded', locked: false, history: [] },
    ] });
    state.generate.mockResolvedValue({ type: 'text', content: JSON.stringify({ shots: [ { title: '进站', description: '旅人走入车站', videoPrompt: '旅人举起信封' }, { title: '站台', description: '车站空镜' } ] }) });
    approveScript();
    await render(); await click('下一步·分镜脚本'); await click('生成分镜脚本');
    await act(async () => { await vi.waitFor(() => expect(filmStore(state.user).getState().project.shots).toHaveLength(2)); });
    expect(document.querySelector('[aria-label="本镜头的人物"] img')?.getAttribute('src')).toContain('/person.png');
    expect(document.querySelector('[aria-label="本镜头的场景"] img')?.getAttribute('src')).toContain('/scene.png');
    expect(document.querySelector('[aria-label="本镜头的道具"] img')?.getAttribute('src')).toContain('/letter.png');
    expect(document.querySelector('[aria-label="生成描述"]')?.textContent).toContain('旅人举起信封');
    await click('取消关联信封'); expect(store.getState().project.shots[0].assetIds).not.toContain('letter');
    await click('选择站台'); expect(document.querySelector('[aria-label="本镜头的人物"] img')).toBeNull();
    await fill('[aria-label="生成描述"]', '车站的阳光');
    expect(store.getState().project.shots[0].videoPrompt).toBe('旅人举起信封');
    expect(store.getState().project.shots[1].videoPrompt).toBe('车站的阳光');
    await click('选择进站'); await click('添加道具参考'); await click('信封参考图已就绪'); await click('完成选择');
    expect(store.getState().project.shots[0].assetIds).toContain('letter');
    expect(store.getState().project.shots[1].assetIds).toEqual(['scene']);
    expect(state.generate).toHaveBeenCalledTimes(1);
  });
  it('uses saved templates for asset descriptions and updates the open editor after completion', async () => {
    const store = filmStore(state.user);
    store.getState().patch(p => ({ script: '旅人来到车站', step: 2, settings: { ...p.settings, assetPromptTemplates: { scene: '表现站台空间层次' } }, assets: [{ id: 'scene', name: '车站', type: 'scene', description: '早晨', source: 'uploaded', locked: false, history: [] }] }));
    state.generate.mockResolvedValue({ type: 'text', content: '清晨站台，雾中铁轨，明亮的纵深空间。' });
    await render(); await click('编辑素材'); await click('AI完善描述');
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ service_type: 'text', prompt: expect.stringContaining('表现站台空间层次') }));
    expect(document.querySelector('[aria-label="生成描述"]')?.textContent).toContain('雾中铁轨');
    expect(store.getState().project.assets[0].url).toBeUndefined();
  });
  it('does not overwrite a newly completed video when editing the inline storyboard', async () => {
    filmStore(state.user).getState().patch({ script: '旅人来到车站。', step: 3 });
    approveScript();
    await render(); await click('新增分镜');
    await fill('[aria-label="当前分镜脚本"]', '列车缓缓驶来。');
    await act(async () => filmStore(state.user).getState().patch(p => ({ shots: p.shots.map(s => ({ ...s, videoUrl: '/completed.mp4', history: [{ id: 'completed', url: '/completed.mp4', kind: 'video', label: '新视频', createdAt: Date.now() }] })) })));
    await fill('[aria-label="当前镜头名称"]', '列车到站'); const shot = filmStore(state.user).getState().project.shots[0];
    expect(shot.description).toBe('列车缓缓驶来。'); expect(shot.videoUrl).toBe('/completed.mp4'); expect(shot.history).toHaveLength(1);
  });
  it('offers live-model 1080p and MOV controls in the video editor', async () => {
    filmStore(state.user).getState().patch({ script: '旅人来到车站。', step: 3 });
    approveScript();
    await render(); await click('新增分镜'); await fill('[aria-label="当前分镜脚本"]', '一个镜头'); await click('分镜视频'); await click('点击编辑');
    await click('输出参数');
    expect(document.querySelector('[aria-label="分辨率 1080p"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="输出格式 mov"]')).toBeTruthy();
    await click('分辨率 1080p'); await click('输出格式 mov'); await click('关闭输出参数');
    expect(filmStore(state.user).getState().project.shots[0].generation?.video).toMatchObject({ resolution: '1080p', outputFormat: 'mov' });
    expect(document.querySelector('.film-media-tabs')?.textContent).toContain('全能参考');
  });
});
