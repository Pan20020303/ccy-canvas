/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TryOnStudio } from './TryOnStudio';
import { ApiClientError } from '../../api/client';
import type { AppProviderConfig } from '../../api/providerConfigs';
import type { HistoryItem } from '../../store';
import { DEFAULT_FILTER, buildTryOnPayload, filterLibrary, mergeLibrary, readPreferences, preferencesKey, studioModels, validateUpload, type StudioAsset } from './studio-library';
import { assetsFromJob, jobsKey, readJobs, type TryOnJob } from './useTryOnJobs';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ assets: vi.fn(), history: vi.fn(), folders: vi.fn(), configs: vi.fn(), saveAsset: vi.fn(), saveFolder: vi.fn(), deleteFolder: vi.fn(), upload: vi.fn(), generate: vi.fn(), task: vi.fn(), batch: vi.fn(), credits: vi.fn() }));
vi.mock('../../api/assets', () => ({ listAssetsFromServer: api.assets, listAssetFoldersFromServer: api.folders, saveAssetToServer: api.saveAsset, saveAssetFolderToServer: api.saveFolder, deleteAssetFolderFromServer: api.deleteFolder }));
vi.mock('../../api/history', () => ({ listHistoryFromServer: api.history }));
vi.mock('../../api/projects', () => ({ uploadFile: api.upload }));
vi.mock('../../api/tasks', () => ({ getTask: api.task, batchTasksByNodeIds: api.batch }));
vi.mock('../../api/providerConfigs', async () => ({ ...await vi.importActual('../../api/providerConfigs'), listAppProviderConfigs: api.configs, generate: api.generate }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ refreshCredits: api.credits }) }));
vi.mock('../MediaThumb', () => ({ MediaThumb: ({ src, alt, className }: { src: string; alt?: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));

const provider: AppProviderConfig = { id: 'provider-1', name: '图像服务', service_type: 'image', vendor: 'OpenAI', model_list: ['gpt-image-2'], default_model: 'gpt-image-2', priority: 0, parameter_schema: { credit_cost: 4 } };
const assets: StudioAsset[] = [
  { id: 'person', name: '人物A', kind: 'image', category: 'character', url: '/api/assets/person.png', thumbnail: '/api/assets/person.png', createdAt: 300, source: 'library' },
  { id: 'garment', name: '白色衬衫', kind: 'image', category: 'object', url: '/api/assets/shirt.png', thumbnail: '/api/assets/shirt.png', createdAt: 200, source: 'library', folderId: 'f1' },
  { id: 'scene', name: '摄影棚', kind: 'image', category: 'scene', url: '/api/assets/studio.png', thumbnail: '/api/assets/studio.png', createdAt: 100, source: 'library' },
  { id: 'video', name: '穿搭视频', kind: 'video', category: 'other', url: '/api/assets/clip.mp4', thumbnail: '', createdAt: 400, source: 'library' },
  { id: 'audio', name: '背景音乐', kind: 'audio', category: 'sound', url: '/api/assets/music.mp3', thumbnail: '', createdAt: 500, source: 'library' },
];
const job: TryOnJob = { id: 'job-1', nodeId: 'tryon-job-1', status: 'pending', taskId: 'task-1', prompt: '我的试衣效果', createdAt: 500, folderId: 'f1' };

describe('try-on data contracts', () => {
  beforeEach(() => localStorage.clear());
  it('filters by type, favorite, labels, search, folder and source without changing input', () => {
    const metadata = { garment: { favorite: true, tags: ['夏日'] } };
    expect(filterLibrary(assets, metadata, { ...DEFAULT_FILTER, kind: 'video' }).map(a => a.id)).toEqual(['video']);
    expect(filterLibrary(assets, metadata, { ...DEFAULT_FILTER, kind: 'audio' }).map(a => a.id)).toEqual(['audio']);
    expect(filterLibrary(assets, metadata, { ...DEFAULT_FILTER, favorite: true, tag: '夏日', search: '夏', folder: 'f1', source: 'library' }).map(a => a.id)).toEqual(['garment']);
    expect(filterLibrary(assets, metadata, { ...DEFAULT_FILTER, folder: '' })).not.toContain(assets[1]);
    expect(filterLibrary(assets, metadata, { ...DEFAULT_FILTER, date: '7' }, 99 * 86400000)).toHaveLength(0);
    expect(filterLibrary(assets, {}, { ...DEFAULT_FILTER, sort: 'oldest' })[0].id).toBe('scene');
    expect(assets[0].id).toBe('person');
  });
  it('merges real history, deduplicates URLs and uses video content instead of a still thumbnail', () => {
    const history = [{ id: 'h1', title: '重复图片', mediaType: 'image', thumbnail: assets[0].url, timestamp: 1 }, { id: 'h2', title: '视频历史', mediaType: 'video', thumbnail: '/api/poster.jpg', content: '/api/movie.mp4', timestamp: 2 }, { id: 'h3', mediaType: 'text', content: 'not media' }] as HistoryItem[];
    const merged = mergeLibrary(assets, history);
    expect(merged).toHaveLength(6); expect(merged.find(a => a.id === 'history-h2')?.url).toBe('/api/movie.mp4');
  });
  it('isolates preferences by account and handles damaged local storage', () => {
    localStorage.setItem(preferencesKey('u1'), JSON.stringify({ metadata: { person: { favorite: true, tags: ['test', 2] } }, size: 999, layout: 'list' }));
    expect(readPreferences('u1').metadata.person.tags).toEqual(['test']); expect(readPreferences('u1').size).toBe(360);
    expect(readPreferences('u2').metadata).toEqual({});
    localStorage.setItem(preferencesKey('u1'), 'broken'); expect(readPreferences('u1').layout).toBe('grid');
  });
  it('uses per-model pricing and schema; does not show hidden or text-only models', () => {
    const configured = { ...provider, model_list: ['gpt-image-2', 'hidden', 'dall-e-3'], parameter_schema: { credit_cost: 4, vendor_models: [{ modelName: 'hidden', hidden: true }], models: { 'gpt-image-2': { credit_cost: 9, quality_options: ['high'], size_options: ['1:1'] } } } };
    const models = studioModels([configured, { ...provider, id: 'text', service_type: 'text', model_list: ['text-only'], default_model: 'text-only' }]);
    expect(models).toHaveLength(1); expect(models[0].cost).toBe(9); expect(models[0].sizes).toEqual(['1:1']);
  });
  it('validates distinct person and garment references before building a paid request', () => {
    const model = studioModels([provider])[0];
    expect(() => buildTryOnPayload(model, [], '', '3:4', 'Auto', true)).toThrow('人物');
    expect(() => buildTryOnPayload(model, [{ ...assets[0], role: 'model' }], '', '3:4', 'Auto', true)).toThrow('服装');
    expect(() => buildTryOnPayload(model, [{ ...assets[0], role: 'model' }, { ...assets[0], role: 'garment' }], '', '3:4', 'Auto', true)).toThrow('不同的图片');
    const payload = buildTryOnPayload(model, [{ ...assets[0], role: 'model' }, { ...assets[1], role: 'garment' }], '白色背景', '3:4', 'Auto', true);
    expect(payload.reference_images).toEqual([assets[0].url, assets[1].url]); expect(payload.prompt).toContain('参考图 1：模特'); expect(payload.prompt).toContain('参考图 2：服装'); expect(payload.prompt).toContain('白色背景'); expect(payload.prompt).toContain('补充要求'); expect(payload.quality).toBe('auto');
  });
  it('rejects unsupported uploads before contacting the server', () => {
    expect(() => validateUpload(new File(['x'], 'x.svg', { type: 'image/svg+xml' }))).toThrow('JPG');
    expect(() => validateUpload(new File([], 'empty.png', { type: 'image/png' }))).toThrow('不能为空');
    expect(() => validateUpload(new File(['x'], 'ok.png', { type: 'image/png' }))).not.toThrow();
  });
  it('recovers interrupted submissions as unknown and rejects non-media result URLs', () => {
    localStorage.setItem(jobsKey('u1'), JSON.stringify([{ ...job, status: 'submitting' }]));
    expect(readJobs('u1')[0].status).toBe('unknown'); expect(readJobs('u2')).toEqual([]);
    expect(assetsFromJob(job, ['javascript:alert(1)', '/api/result.png', '/api/result.png'])).toHaveLength(1);
    expect(assetsFromJob(job, ['/api/result.png'])[0].folderId).toBe('f1');
  });
});

describe('try-on studio interactions', () => {
  let host: HTMLDivElement; let root: Root;
  const button = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)!;
  const click = async (name: string) => { const target = button(name); expect(target, name).toBeTruthy(); await act(async () => target.click()); };
  const clickPrefix = async (name: string) => { const target = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.startsWith(name)); expect(target, name).toBeTruthy(); await act(async () => target!.click()); };
  const fill = async (label: string, value: string) => { const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; expect(input, label).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); };
  const select = async (label: string, value: string) => { const el = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; expect(el, label).toBeTruthy(); await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }); };
  const render = async (userId = 'user-1') => { await act(async () => root.render(<TryOnStudio key={userId} userId={userId} zh />)); };
  const references = async () => { await clickPrefix('选择人物 / 模特'); await click('选择素材：人物A'); await click('使用所选素材'); await clickPrefix('选择试穿服装'); await click('选择素材：白色衬衫'); await click('使用所选素材'); };
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    api.assets.mockResolvedValue(assets); api.history.mockResolvedValue([]); api.folders.mockResolvedValue([{ id: 'f1', name: '春夏系列', createdAt: 100 }]); api.configs.mockResolvedValue([provider]);
    api.saveAsset.mockResolvedValue(undefined); api.saveFolder.mockResolvedValue(undefined); api.deleteFolder.mockResolvedValue(undefined); api.credits.mockResolvedValue(undefined);
    api.generate.mockResolvedValue({ type: 'url', content: '/api/assets/result.png' }); api.task.mockResolvedValue({ id: 'task-1', node_id: job.nodeId, status: 'pending' }); api.batch.mockResolvedValue([]);
    api.upload.mockResolvedValue({ url: '/api/assets/upload.png' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
  it('shows the full toolbar and real images without submitting any generation', async () => {
    await render(); expect(host.querySelectorAll('.studio-asset')).toHaveLength(3); expect(api.generate).not.toHaveBeenCalled();
    for (const label of ['标签', '文件夹', '模板', '仅看收藏', '切换列表布局', '筛选素材', '搜索素材']) expect(button(label), label).toBeTruthy();
    expect(host.querySelector('[aria-label="缩略图大小"]')).toBeTruthy(); expect(host.textContent).not.toContain('全自动');
  });
  it('switches media types, search, sorting and layouts', async () => {
    await render(); await click('视频'); expect(host.querySelectorAll('.studio-asset')).toHaveLength(1); expect(host.querySelector('.studio-asset')?.textContent).toContain('穿搭视频');
    await click('音频'); expect(host.querySelector('.studio-asset')?.textContent).toContain('背景音乐'); await click('全部'); expect(host.querySelectorAll('.studio-asset')).toHaveLength(5);
    await click('搜索素材'); await fill('搜索素材名称或标签', '白色'); expect(host.querySelectorAll('.studio-asset')).toHaveLength(1);
    await click('清除搜索'); await select('素材排序', 'oldest'); expect(host.querySelector('.studio-asset')?.textContent).toContain('摄影棚');
    await click('切换列表布局'); expect(host.querySelector('.studio-assets.is-list')).toBeTruthy(); expect(readPreferences('user-1').layout).toBe('list');
  });
  it('persists favorites and labels per user, then filters by them', async () => {
    await render(); await click('收藏：人物A'); await click('仅看收藏'); expect(host.querySelectorAll('.studio-asset')).toHaveLength(1);
    await click('预览素材：人物A'); await fill('添加标签', '夏日'); await click('确认添加标签'); await click('关闭弹窗 / Close dialog');
    await click('标签'); await click('夏日'); expect(host.querySelectorAll('.studio-asset')).toHaveLength(1); expect(readPreferences('user-1').metadata.person.tags).toEqual(['夏日']);
    await render('user-2'); expect(readPreferences('user-2').metadata).toEqual({}); expect(button('收藏：人物A')).toBeTruthy();
  });
  it('opens person/model picker, filters by category, assigns roles, and restores focus on Escape', async () => {
    await render(); await clickPrefix('选择人物 / 模特'); expect(document.querySelector('[role="dialog"]')).toBeTruthy(); expect(button('选择素材：人物A')).toBeTruthy(); expect(button('选择素材：摄影棚')).toBeUndefined();
    await click('选择素材：人物A'); await select('参考用途：人物A', 'person'); await click('使用所选素材');
    await clickPrefix('添加参考图片'); await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(api.generate).not.toHaveBeenCalled();
  });
  it('blocks missing references with actionable validation and no paid request', async () => {
    await render(); await clickPrefix('生成试衣效果'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('人物'); expect(api.generate).not.toHaveBeenCalled();
  });
  it('uploads an image and saves its role and backend asset before confirming', async () => {
    await render(); await clickPrefix('选择人物 / 模特');
    const input = document.querySelector<HTMLInputElement>('[aria-label="上传参考图片"]')!;
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'model.png', { type: 'image/png' })] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(api.upload).toHaveBeenCalledOnce(); expect(api.saveAsset).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', category: 'character', url: '/api/assets/upload.png' }));
    await click('使用所选素材'); expect(host.querySelector('.studio-reference-slots')?.textContent).toContain('model');
  });
  it('creates and deletes folders only after confirmation, without deleting assets', async () => {
    await render(); await click('文件夹'); await fill('新文件夹名称', '秋冬系列'); await click('创建'); expect(api.saveFolder).toHaveBeenCalledWith(expect.objectContaining({ name: '秋冬系列' }));
    await click('删除文件夹：春夏系列'); expect(api.deleteFolder).not.toHaveBeenCalled(); await click('确认删除文件夹'); expect(api.deleteFolder).toHaveBeenCalledWith('f1');
    expect(host.textContent).toContain('白色衬衫');
  });
  it('moves an asset through the existing persistence API and reports failure without faking a move', async () => {
    api.saveAsset.mockRejectedValueOnce(new Error('offline')); await render(); await click('预览素材：人物A'); await select('移动到文件夹', 'f1');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('移动失败'); expect(document.querySelector<HTMLSelectElement>('[aria-label="移动到文件夹"]')?.value).toBe('');
    await select('移动到文件夹', 'f1'); expect(api.saveAsset).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'person', folderId: 'f1' }));
  });
  it('applies and saves a reusable try-on preset without generation', async () => {
    await render(); await fill('试衣提示词', '自然光，全身正面'); await click('模板'); await fill('试衣模板名称', '我的穿搭'); await click('保存模板');
    expect(readPreferences('user-1').templates[0].prompt).toBe('自然光，全身正面'); await click('关闭弹窗 / Close dialog'); await fill('试衣提示词', '临时内容'); await click('模板'); await clickPrefix('我的穿搭');
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="试衣提示词"]')?.value).toBe('自然光，全身正面'); expect(api.generate).not.toHaveBeenCalled();
  });
  it('submits real reference payloads with idempotency keys and persists successful results', async () => {
    await render(); await references(); await fill('试衣提示词', '白色背景'); await clickPrefix('生成试衣效果');
    expect(api.generate).toHaveBeenCalledOnce(); expect(api.generate).toHaveBeenCalledWith(expect.objectContaining({ provider_config_id: 'provider-1', service_type: 'image', reference_images: [assets[0].url, assets[1].url], request_id: expect.any(String), node_id: expect.stringMatching(/^tryon-/) }));
    expect(api.saveAsset).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/assets/result.png', id: expect.stringMatching(/^tryon-/) })); expect(api.credits).toHaveBeenCalled(); expect(host.querySelectorAll('.studio-asset')).toHaveLength(4);
  });
  it('does not regenerate when saving a successful result fails', async () => {
    api.saveAsset.mockRejectedValueOnce(new Error('offline')); await render(); await references(); await clickPrefix('生成试衣效果'); expect(host.textContent).toContain('结果待保存');
    await click('重试保存'); expect(api.saveAsset).toHaveBeenCalledTimes(2); expect(api.generate).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('结果待保存');
  });
  it('recovers queued jobs from local state and saves results without creating another request', async () => {
    localStorage.setItem(jobsKey('user-1'), JSON.stringify([job])); api.task.mockResolvedValue({ id: 'task-1', node_id: job.nodeId, status: 'success', result_url: '/api/assets/recovered.png' }); await render();
    expect(api.task).toHaveBeenCalledWith('task-1'); expect(api.generate).not.toHaveBeenCalled(); expect(api.saveAsset).toHaveBeenCalledWith(expect.objectContaining({ id: 'tryon-job-1-0', url: '/api/assets/recovered.png' }));
  });
  it('stops the rest of a batch on insufficient credits and reports the real category of error', async () => {
    api.generate.mockRejectedValue(new ApiClientError({ code: 'INSUFFICIENT_CREDITS', status: 402, message: 'credits' })); await render(); await references(); await click('增加生成数量'); await clickPrefix('生成试衣效果');
    expect(api.generate).toHaveBeenCalledOnce(); expect(host.textContent).toContain('可用积分不足'); expect(api.saveAsset).not.toHaveBeenCalled();
  });
  it('does not retry uncertain paid submissions and uses read-only status recovery', async () => {
    api.generate.mockRejectedValue(new TypeError('network')); await render(); await references(); await clickPrefix('生成试衣效果'); expect(host.textContent).toContain('任务状态待确认');
    await click('检查状态'); expect(api.batch).toHaveBeenCalledOnce(); expect(api.generate).toHaveBeenCalledOnce(); expect(host.textContent).toContain('不会自动重新生成');
  });
  it('reports partial library failures and retries without blocking the whole interface', async () => {
    api.history.mockRejectedValueOnce(new Error('offline')); await render(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('生成历史加载失败'); expect(host.querySelectorAll('.studio-asset')).toHaveLength(3);
    await click('重试'); expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it('does not write an old account result into a newly signed-in account', async () => {
    let resolveTask!: (value: unknown) => void;
    api.task.mockImplementation(() => new Promise(resolve => { resolveTask = resolve; }));
    localStorage.setItem(jobsKey('user-1'), JSON.stringify([job]));
    await render(); await render('user-2');
    await act(async () => resolveTask({ id: 'task-1', node_id: job.nodeId, status: 'success', result_url: '/api/assets/private.png' }));
    expect(api.saveAsset).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('我的试衣效果');
    expect(readJobs('user-1')[0].status).toBe('unsaved'); expect(readJobs('user-2')).toEqual([]);
  });
  it('polls a queued request to completion without another generation call', async () => {
    vi.useFakeTimers(); api.generate.mockResolvedValue({ type: 'queued', task_id: 'task-1' });
    api.task.mockResolvedValue({ id: 'task-1', status: 'success', result_url: '/api/assets/queued.png' });
    await render(); await references(); await clickPrefix('生成试衣效果'); expect(host.textContent).toContain('试衣效果生成中');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api.generate).toHaveBeenCalledOnce(); expect(api.saveAsset).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/assets/queued.png' }));
  });
  it('uses unique requests for the requested batch size and ignores same-turn double clicks', async () => {
    await render(); await references(); await click('增加生成数量');
    const submit = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.startsWith('生成试衣效果'))!;
    await act(async () => { submit.click(); submit.click(); });
    expect(api.generate).toHaveBeenCalledTimes(2);
    expect(api.generate.mock.calls[0][0].request_id).not.toBe(api.generate.mock.calls[1][0].request_id);
  });
});
