/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratePayload } from '../../api/providerConfigs';
import { ApiClientError } from '../../api/client';
import { applyFilmResult, filmStore, filmStorageKey, pollFilmJobs, recoverFilmJob, retryFilmJob, startFilmJob, exportFilm } from './film-store';
import { newFilmProject, type FilmJob } from './film-project';
import { emptyVideoProject } from '../../video-editor-project';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), create: vi.fn(), get: vi.fn(), batch: vi.fn(), export: vi.fn() }));
vi.mock('../../api/providerConfigs', async () => ({ ...await vi.importActual('../../api/providerConfigs'), generate: mocks.generate }));
vi.mock('../../api/projects', () => ({ createProject: mocks.create }));
vi.mock('../../api/tasks', () => ({ getTask: mocks.get, batchTasksByNodeIds: mocks.batch }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual('../../api/client'), apiClient: { post: mocks.export } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const payload: GeneratePayload = { service_type: 'text', model: 'writer', prompt: '编写剧本', provider_config_id: 'real-provider' };
let user = '';
beforeEach(() => { vi.clearAllMocks(); user = crypto.randomUUID(); mocks.create.mockResolvedValue({ id: 'backend-project' }); mocks.batch.mockResolvedValue([]); mocks.generate.mockResolvedValue({ type: 'queued', task_id: 'task1', content: '' }); });
const latest = () => filmStore(user).getState().project;

describe('one-click film durable task workflow', () => {
  it('persists real phases, survives disconnection and applies cached output once after reconnection', async () => {
    await startFilmJob(user, 'split', payload);
    const id = latest().jobs[0].id, node = latest().jobs[0].nodeId;
    expect(latest().jobs[0].phase).toBe('queued');
    mocks.get.mockResolvedValueOnce({ id: 'task1', node_id: node, status: 'running' });
    await pollFilmJobs(user); expect(latest().jobs[0].phase).toBe('generating');
    mocks.get.mockRejectedValueOnce(new Error('断线'));
    await pollFilmJobs(user); expect(latest().jobs[0].connectionLostAt).toBeDefined();
    const raw = '{"shots":[{"description":"完整镜头","videoPrompt":"4秒，列车驶来"},{"description":"中断';
    mocks.get.mockResolvedValueOnce({ id: 'task1', node_id: node, status: 'success', result_url: raw });
    await pollFilmJobs(user); await pollFilmJobs(user); await recoverFilmJob(user, id);
    expect(latest().shots).toHaveLength(1);
    expect(latest().jobs[0]).toMatchObject({ status: 'partial', phase: 'applied', rawResult: raw, resultCount: 1, warning: expect.stringContaining('截断') });
    expect(latest().jobs[0].connectionLostAt).toBeUndefined();
    expect(latest().jobs[0].steps?.map(s => s.phase)).toEqual(['preparing', 'submitted', 'queued', 'generating', 'received', 'parsing', 'applied']);
    expect(JSON.parse(localStorage.getItem(filmStorageKey(user))!).jobs[0].rawResult).toBe(raw);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it('recovers an older parse failure from the server without a second generation or duplicate imports', async () => {
    filmStore(user).getState().patch({ jobs: [{ id: 'old', nodeId: 'old-node', taskId: 'old-task', kind: 'split', status: 'error', error: '无法解析', startedAt: 1, sourceScript: '', payload }] });
    const raw = '{"shots":[{"description":"可恢复的镜头"},{"description":"被截断';
    mocks.get.mockResolvedValue({ id: 'old-task', node_id: 'old-node', status: 'success', result_url: raw });
    await Promise.all([recoverFilmJob(user, 'old'), recoverFilmJob(user, 'old')]);
    expect(latest().shots).toHaveLength(1); expect(latest().jobs[0].status).toBe('partial');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('retains raw parse failures and refuses stale or unrelated cached results', async () => {
    filmStore(user).getState().patch({ jobs: [{ id: 'old', nodeId: 'old-node', taskId: 'old-task', kind: 'split', status: 'error', startedAt: 1, sourceScript: '', payload }] });
    mocks.get.mockResolvedValueOnce({ id: 'old-task', node_id: 'other-node', status: 'success', result_url: '{"shots":[]}' });
    await expect(recoverFilmJob(user, 'old')).rejects.toThrow('没有可恢复');
    mocks.get.mockResolvedValueOnce({ id: 'old-task', node_id: 'old-node', status: 'success', result_url: 'not JSON' });
    await recoverFilmJob(user, 'old'); expect(latest().jobs[0].rawResult).toBe('not JSON');
    expect(latest().shots).toHaveLength(0); expect(latest().jobs[0].status).toBe('error');
    filmStore(user).getState().patch(p => ({ script: '新剧本', jobs: p.jobs.map(j => ({ ...j, rawResult: '{"shots":[{"description":"旧结果"}]}' })) }));
    await recoverFilmJob(user, 'old'); expect(latest().jobs[0].error).toContain('剧本已修改');
    expect(latest().shots).toHaveLength(0); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('restores interrupted submits as queryable tasks without automatically resubmitting', () => {
    const p = newFilmProject(); p.step = 4; p.script = '上次的剧本';
    p.jobs = [{ id: 'saved', nodeId: 'saved-node', kind: 'write', status: 'submitting', startedAt: 1, sourceScript: p.script, payload }];
    localStorage.setItem(filmStorageKey(user), JSON.stringify(p));
    expect(latest().step).toBe(4); expect(latest().script).toBe('上次的剧本'); expect(latest().jobs[0].status).toBe('unknown'); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('saves before submit, uses the backend project, prevents duplicate tasks and applies a completed task only once', async () => {
    filmStore(user).getState().patch({ script: '故事' });
    await startFilmJob(user, 'extract', payload);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'backend-project', provider_config_id: 'real-provider', request_id: expect.any(String), node_id: expect.stringContaining('automation-film-extract-') }));
    expect(JSON.parse(localStorage.getItem(filmStorageKey(user))!).jobs[0].status).toBe('running');
    await expect(startFilmJob(user, 'extract', payload)).rejects.toThrow('正在处理');
    mocks.get.mockResolvedValue({ id: 'task1', node_id: latest().jobs[0].nodeId, status: 'success', result_url: JSON.stringify({ assetsList: [{ name: '车站', desc: '云上的车站', prompt: '车站参考图', type: 'scene' }] }) });
    await pollFilmJobs(user); await pollFilmJobs(user);
    expect(latest().assets).toHaveLength(1); expect(latest().assets[0].name).toBe('车站'); expect(latest().jobs[0].status).toBe('success');
  });
  it('recovers a queued task after a lost submit response without sending a second generation request', async () => {
    mocks.generate.mockRejectedValueOnce(new ApiClientError({ code: 'NETWORK_ERROR', status: 0, message: '网络中断' }));
    await startFilmJob(user, 'write', payload);
    expect(latest().jobs[0].status).toBe('unknown');
    mocks.batch.mockResolvedValue([{ id: 'recovered', node_id: latest().jobs[0].nodeId, status: 'success', result_url: '恢复的剧本' }]);
    await retryFilmJob(user, latest().jobs[0].id);
    expect(latest().script).toBe('恢复的剧本'); expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it('reuses the exact idempotency key when retrying an unconfirmed submission', async () => {
    mocks.generate.mockRejectedValueOnce(new ApiClientError({ code: 'GATEWAY', status: 502, message: '网关异常' }));
    await startFilmJob(user, 'write', payload);
    const first = mocks.generate.mock.calls[0][0];
    await retryFilmJob(user, latest().jobs[0].id);
    expect(mocks.generate.mock.calls[1][0]).toEqual(first);
    expect(latest().jobs).toHaveLength(1); expect(latest().jobs[0].status).toBe('running');
  });
  it('does not replace a changed script with an old generation result', async () => {
    await startFilmJob(user, 'write', payload);
    filmStore(user).getState().patch({ script: '用户的新编辑' });
    mocks.get.mockResolvedValue({ id: 'task1', node_id: latest().jobs[0].nodeId, status: 'success', result_url: '旧生成结果' });
    await pollFilmJobs(user);
    expect(latest().script).toBe('用户的新编辑'); expect(latest().jobs[0].status).toBe('error');
    await expect(retryFilmJob(user, latest().jobs[0].id)).rejects.toThrow('剧本已经修改');
  });
  it('isolates users and clears all old project identity/media when starting a new draft', () => {
    const store = filmStore(user); const other = filmStore(user + '-other');
    store.getState().patch({ script: '私有剧本', backendId: 'old', exportUrl: '/old.mp4', editProject: emptyVideoProject(), exporting: true });
    expect(other.getState().project.script).toBe('');
    store.getState().reset();
    expect(latest().backendId).toBeUndefined(); expect(latest().exportUrl).toBeUndefined(); expect(latest().editProject).toBeUndefined(); expect(latest().exporting).toBe(false);
  });
  it('surfaces storage failures and does not pretend the draft is saved', () => {
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    filmStore(user).getState().patch({ script: '未丢失的内存草稿' });
    expect(filmStore(user).getState().saved).toBe(false); expect(latest().script).toBe('未丢失的内存草稿'); fail.mockRestore();
  });
  it('preserves media history and asset IDs on repeated extraction', () => {
    const p = newFilmProject(); p.assets = [{ id: 'existing', type: 'scene', name: '车站', description: '旧', source: 'uploaded', locked: false, url: '/station.png', history: [] }];
    const job: FilmJob = { id: 'job', nodeId: 'node', kind: 'extract', status: 'running', startedAt: 1, sourceScript: '', payload };
    const changes = applyFilmResult(p, job, JSON.stringify({ assetsList: [{ name: '车站', type: 'scene', desc: '新描述', prompt: '新提示词' }] }));
    expect(changes.assets?.[0]).toMatchObject({ id: 'existing', url: '/station.png', description: '新描述' });
    const image = applyFilmResult(p, { ...job, kind: 'asset', targetId: 'existing' }, '/new.png');
    expect(image.assets?.[0].history).toHaveLength(1); expect(image.assets?.[0].url).toBe('/new.png');
  });
  it('records terminal provider errors without fabricating outputs', async () => {
    mocks.generate.mockRejectedValueOnce(new ApiClientError({ code: 'INSUFFICIENT_CREDIT', status: 402, message: '积分不足' }));
    await startFilmJob(user, 'write', payload);
    expect(latest().jobs[0]).toMatchObject({ status: 'error', error: '积分不足' }); expect(latest().script).toBe('');
  });
  it('preserves the skill-authored natural-language video prompt independently from the image prompt', () => {
    const p = newFilmProject();
    const videoPrompt = '镜头1（0:00–0:04，4秒）\n35mm，旅人走入车站。光影：列车反光划过墙面。现场声：脚步声。';
    const job: FilmJob = { id: 'split', kind: 'split', status: 'running', nodeId: 'split-node', startedAt: 1, sourceScript: '', payload };
    const result = applyFilmResult(p, job, JSON.stringify({ shots: [{ title: '镜头1', description: '旅人进入车站', imagePrompt: '车站门口的静态画面', videoPrompt }] }));
    expect(result.shots?.[0].videoPrompt).toBe(videoPrompt);
    expect(result.shots?.[0].prompt).toBe('车站门口的静态画面');
  });
  it('uses updated settings for a failed retry with a fresh request ID, retaining the original job', async () => {
    mocks.generate.mockResolvedValueOnce({ type: 'text', content: '' });
    await startFilmJob(user, 'extract', payload);
    const first = latest().jobs[0];
    expect(first.status).toBe('error');
    const updated = { ...payload, model: 'new-model', provider_config_id: 'new-provider', prompt: '新的技能指令' };
    await retryFilmJob(user, first.id, updated);
    expect(mocks.generate).toHaveBeenLastCalledWith(expect.objectContaining(updated));
    expect(latest().jobs).toHaveLength(2);
    expect(latest().jobs[1].payload.request_id).not.toBe(first.payload.request_id);
    expect(latest().jobs[0]).toEqual(first);
  });
  it('never replaces an uncertain submission payload even when new settings are supplied', async () => {
    mocks.generate.mockRejectedValueOnce(new ApiClientError({ code: 'GATEWAY', status: 502, message: '网关异常' }));
    await startFilmJob(user, 'extract', payload);
    const first = mocks.generate.mock.calls[0][0];
    await retryFilmJob(user, latest().jobs[0].id, { ...payload, model: 'changed' });
    expect(mocks.generate.mock.calls[1][0]).toEqual(first);
  });
  it('migrates older project settings and keeps production settings isolated between users', () => {
    const p = newFilmProject();
    const { extractModel, extractSkillId, splitModel, splitSkillId, ...legacy } = p.settings;
    localStorage.setItem(filmStorageKey(user), JSON.stringify({ ...p, settings: legacy }));
    expect(latest().settings).toMatchObject({ extractModel: '', extractSkillId: '', splitModel: '', splitSkillId: '' });
    filmStore(user).getState().patch({ settings: { ...latest().settings, extractSkillId: 'my-skill', splitModel: 'my-model' } });
    expect(JSON.parse(localStorage.getItem(filmStorageKey(user))!).settings.splitModel).toBe('my-model');
    expect(filmStore(user + '-other').getState().project.settings.splitModel).toBe('');
  });
  it('exports the actual timeline through the existing FFmpeg endpoint', async () => {
    const edit = emptyVideoProject(); edit.assets = [{ id: 'v', name: '镜头', kind: 'video', url: 'https://example.test/v.mp4', duration: 4 }]; edit.clips = [{ id: 'c', assetId: 'v', start: 0, end: 4, at: 0, speed: 1, volume: 1 }];
    mocks.export.mockResolvedValue({ url: '/final.mp4', engine: 'ffmpeg' });
    await exportFilm(user, edit);
    expect(mocks.export).toHaveBeenCalledWith('/api/app/video/edit', expect.objectContaining({ clips: expect.any(Array) }), expect.any(AbortSignal));
    expect(latest().exportUrl).toBe('/final.mp4'); expect(latest().exporting).toBe(false);
  });
});
