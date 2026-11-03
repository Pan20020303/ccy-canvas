import { create } from 'zustand';
import { toast } from 'sonner';
import { generate, type GeneratePayload } from '../../api/providerConfigs';
import { createProject } from '../../api/projects';
import { batchTasksByNodeIds, getTask } from '../../api/tasks';
import { ApiClientError, apiClient } from '../../api/client';
import { parseExtractedAssetsResponse, parseStoryboardResponse } from '../../automation-workflow';
import { editorId, editorExportPayload, validateEditorProject, type VideoEditProject } from '../../video-editor-project';
import { newFilmProject, SCRIPT_LIMIT, type FilmProject, type FilmJob, type FilmJobPhase } from './film-project';
import { prepareFilmResult } from './film-result';
import type { LocalVideoTrimResult } from '../../api/video-edit';
import { scriptDoctorIssue, scriptDoctorResult } from './film-script-doctor';

type State = { project: FilmProject; saved: boolean; syncStatus?: 'saved' | 'saving' | 'error' | 'conflict'; syncError?: string; flush?: () => Promise<void>; patch: (change: Partial<FilmProject> | ((p: FilmProject) => Partial<FilmProject>)) => void; reset: () => void };
const stores = new Map<string, ReturnType<typeof createFilmStore>>();
export const filmStorageKey = (userId: string) => `ccy-one-click-film-v1:${userId || 'preview'}`;
function createFilmStore(userId: string, cloudId?: string) {
  let project = newFilmProject();
  try {
    const raw = cloudId ? null : JSON.parse(localStorage.getItem(filmStorageKey(userId)) || 'null') as FilmProject | null;
    if (raw?.version === 1 && Array.isArray(raw.assets) && Array.isArray(raw.shots) && Array.isArray(raw.jobs)) {
      project = { ...project, ...raw, settings: { ...project.settings, ...raw.settings }, exporting: false,
        jobs: raw.jobs.map(j => j.status === 'submitting' ? { ...j, status: 'unknown' } : j) };
    }
  } catch { /* An unavailable local draft does not prevent opening the editor. */ }
  return create<State>((set, get) => ({ project, saved: true,
    patch: change => {
      const current = get().project;
      const next = { ...current, ...(typeof change === 'function' ? change(current) : change), updatedAt: Date.now() };
      let saved = true;
      // Cloud projects are journaled separately with their server revision.
      if (!cloudId) try { localStorage.setItem(filmStorageKey(userId), JSON.stringify(next)); } catch { saved = false; }
      set({ project: next, saved });
    },
    reset: () => get().patch({ ...newFilmProject(), scriptDoctor: undefined, backendId: undefined, editProject: undefined, exportUrl: undefined, exportError: undefined, exporting: false }),
  }));
}
export function filmStore(userId: string, cloudId?: string) {
  const key = cloudId ? `${userId}/${cloudId}` : userId;
  if (!stores.has(key)) stores.set(key, createFilmStore(userId, cloudId));
  return stores.get(key)!;
}
export const activeFilmJob = (j: FilmJob) => ['submitting', 'running', 'unknown'].includes(j.status);
export const filmError = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
const projectCreations = new Map<string, Promise<string>>();
async function ensureProject(userId: string, cloudId?: string) {
  const store = filmStore(userId, cloudId), p = store.getState().project;
  if (p.backendId) return p.backendId;
  const key = `${userId}:${p.id}`;
  if (!projectCreations.has(key)) projectCreations.set(key, createProject(`一键成片 · ${p.name}`).then(result => {
    if (store.getState().project.id === p.id) store.getState().patch({ backendId: result.id });
    return result.id;
  }).finally(() => { projectCreations.delete(key); }));
  return projectCreations.get(key)!;
}
export function applyFilmResult(project: FilmProject, job: FilmJob, content: string): Partial<FilmProject> {
  if (!content.trim()) throw new Error('任务已结束，但模型没有返回有效内容。');
  if (['extract', 'split', 'write'].includes(job.kind) && project.script !== job.sourceScript) throw new Error('剧本已修改，旧任务结果未覆盖当前内容。请按新剧本重新生成。');
  if (job.kind === 'write') return { script: content.slice(0, SCRIPT_LIMIT), scriptHistory: [...project.scriptHistory, { text: project.script, at: job.startedAt }].slice(-20) };
  if (job.kind === 'doctor') return scriptDoctorResult(project, job, content);
  if (job.kind === 'describe') {
    const asset = project.assets.find(a => a.id === job.targetId);
    if (!asset) throw new Error('资产已移除，描述结果保留在任务记录中。');
    if (project.script !== job.sourceScript || (asset.generationPrompt || '') !== (job.sourceAssetPrompt || '')) throw new Error('剧本或资产提示词已修改，未覆盖手工内容。可在任务中下载原始返回。');
    return { assets: project.assets.map(a => a.id === job.targetId ? { ...a, generationPrompt: content.trim() } : a) };
  }
  if (job.kind === 'extract') {
    const assets = parseExtractedAssetsResponse(content).filter(a => a.type !== 'audio');
    if (!assets.length) throw new Error('模型没有提取出场景、角色或道具。可以手动添加后继续。');
    // Preserve existing media and stable IDs so current shots keep valid references.
    const merged = [...project.assets];
    for (const [number, asset] of assets.entries()) {
      const index = merged.findIndex(a => a.name === asset.name && a.type === asset.type);
      if (index >= 0) merged[index] = { ...merged[index], description: asset.description, generationPrompt: asset.generationPrompt };
      else merged.push({ ...asset, id: `film-${job.id}-asset-${number}`, history: [] });
    }
    return { assets: merged };
  }
  if (job.kind === 'split') {
    const shots = parseStoryboardResponse(content, project.assets);
    if (!shots.length) throw new Error('模型没有返回可用分镜。');
    if (shots.length + project.shots.length > 32) throw new Error('当前工程最多支持32个分镜，请减少分镜数量后重试，已有内容已保留。');
    return { shots: [...project.shots, ...shots.map((s, number) => ({ ...s, id: `film-${job.id}-shot-${number}`, autoBindReferences: true, history: [] }))] };
  }
  const version = { id: job.id, url: content, createdAt: job.startedAt, label: job.payload.model, kind: job.kind === 'video' ? 'video' as const : 'image' as const };
  if (job.kind === 'asset') return { assets: project.assets.map(a => a.id === job.targetId ? { ...a, url: content, history: [...a.history, version] } : a) };
  return { shots: project.shots.map(s => s.id === job.targetId ? { ...s, ...(job.kind === 'video' ? { videoUrl: content, videoDuration: undefined } : { imageUrl: content, status: 'generated' as const }), history: [...s.history, version] } : s) };
}
function jobPhase(job: FilmJob, phase: FilmJobPhase): FilmJob {
  return { ...job, phase, steps: job.phase === phase ? job.steps : [...(job.steps || []), { phase, at: Date.now() }].slice(-30) };
}
function updateJob(userId: string, projectId: string, jobId: string, change: Partial<FilmJob>, phase?: FilmJobPhase, cloudId?: string) {
  const state = filmStore(userId, cloudId).getState();
  if (state.project.id !== projectId) return;
  state.patch(p => ({ jobs: p.jobs.map(j => j.id === jobId && activeFilmJob(j) ? (phase ? jobPhase({ ...j, ...change }, phase) : { ...j, ...change }) : j) }));
}
function finish(userId: string, projectId: string, jobId: string, content?: string, error?: string, cloudId?: string, recover = false) {
  const state = filmStore(userId, cloudId).getState();
  if (state.project.id !== projectId) return;
  const job = state.project.jobs.find(j => j.id === jobId);
  if (!job || job.appliedAt || (!activeFilmJob(job) && !(recover && job.status === 'error'))) return;
  let completed: FilmJob = { ...job, rawResult: content ?? job.rawResult, connectionLostAt: undefined, lastSyncedAt: Date.now() };
  if (content) completed = jobPhase(jobPhase(completed, 'received'), 'parsing');
  try {
    const prepared = !error && (job.kind === 'split' || job.kind === 'extract') ? prepareFilmResult(job.kind, content || '', state.project.assets) : undefined;
    const changes = error ? {} : applyFilmResult(state.project, job, prepared?.content ?? content ?? '');
    // Keep imported records and the application marker in the same durable update.
    completed = jobPhase({ ...completed, status: error ? 'error' : prepared?.warning ? 'partial' : 'success', error,
      resultCount: prepared?.count, warning: prepared?.warning, appliedAt: error ? undefined : Date.now() }, error ? 'error' : 'applied');
    state.patch(p => ({ ...changes, jobs: p.jobs.map(j => j.id === jobId ? completed : j) }));
  } catch (e) {
    completed = jobPhase({ ...completed, status: 'error', error: filmError(e) }, 'error');
    state.patch(p => ({ jobs: p.jobs.map(j => j.id === jobId ? completed : j) }));
  }
}
// Re-read a finished server task. This path must never submit generation or charge.
export async function recoverFilmJob(userId: string, id: string, cloudId?: string) {
  const store = filmStore(userId, cloudId), p = store.getState().project, job = p.jobs.find(j => j.id === id);
  if (!job || job.status !== 'error' || job.appliedAt || !['split', 'extract', 'doctor'].includes(job.kind)) return;
  let raw = job.rawResult;
  if (!raw) {
    const task = job.taskId ? await getTask(job.taskId) : (await batchTasksByNodeIds([job.nodeId])).find(t => t.node_id === job.nodeId);
    if (!task || task.node_id !== job.nodeId || task.status !== 'success' || !task.result_url?.trim()) throw new Error('后台没有可恢复的模型结果；不会自动重新生成。');
    raw = task.result_url;
  }
  finish(userId, p.id, id, raw, undefined, cloudId, true);
  await store.getState().flush?.();
}
export async function startFilmJob(userId: string, kind: FilmJob['kind'], payload: GeneratePayload, targetId?: string, cloudId?: string) {
  if (!userId) throw new Error('请先登录后使用生成服务。');
  const store = filmStore(userId, cloudId), p = store.getState().project;
  if (kind === 'split') { const issue = scriptDoctorIssue(p); if (issue) throw new Error(issue); }
  if (p.jobs.some(j => activeFilmJob(j) && j.kind === kind && j.targetId === targetId)) throw new Error('这个任务正在处理中，请等待完成。');
  const id = editorId();
  const nodeId = `automation-film-${kind}-${p.id}-${id}`;
  const job: FilmJob = { id, kind, targetId, nodeId, startedAt: Date.now(), status: 'submitting', phase: 'preparing', steps: [{ phase: 'preparing', at: Date.now() }], sourceScript: p.script,
    sourceAssetPrompt: kind === 'describe' ? p.assets.find(a => a.id === targetId)?.generationPrompt || '' : undefined,
    payload: { ...payload, node_id: nodeId, request_id: id } };
  store.getState().patch(current => ({ jobs: [...current.jobs, job] }));
  try {
    const backendId = await ensureProject(userId, cloudId);
    if (store.getState().project.id !== p.id) return;
    job.payload.project_id = backendId;
    store.getState().patch(current => ({ jobs: current.jobs.map(j => j.id === id ? { ...j, payload: job.payload } : j) }));
    // Persist request/node IDs before any billable request. Refresh can recover it.
    await store.getState().flush?.();
    if (kind === 'doctor' && store.getState().project.script !== job.sourceScript) throw new Error('剧本在准备期间已修改，未提交旧优化任务。请重新点击优化。');
    await submitFilmJob(userId, p.id, job, cloudId);
  } catch (error) {
    finish(userId, p.id, id, undefined, filmError(error), cloudId);
    throw error;
  }
}
async function submitFilmJob(userId: string, projectId: string, job: FilmJob, cloudId?: string) {
  const store = filmStore(userId, cloudId);
  try {
    updateJob(userId, projectId, job.id, {}, 'submitted', cloudId);
    const result = await generate(job.payload);
    if (store.getState().project.id !== projectId) return;
    if (result.type === 'queued') {
      updateJob(userId, projectId, job.id, { taskId: result.task_id, status: result.task_id ? 'running' : 'unknown', error: undefined, connectionLostAt: undefined, lastSyncedAt: Date.now() }, 'queued', cloudId);
    } else finish(userId, projectId, job.id, result.content, undefined, cloudId);
  } catch (error) {
    if (store.getState().project.id !== projectId) return;
    // Transport failure is not proof that the provider rejected a billable request.
    const uncertain = error instanceof ApiClientError && (error.status === 0 || error.status >= 500);
    if (uncertain) updateJob(userId, projectId, job.id, { status: 'unknown', connectionLostAt: Date.now(), error: '提交响应中断，正在查找后台任务；不会自动重复生成。' }, undefined, cloudId);
    else finish(userId, projectId, job.id, undefined, filmError(error), cloudId);
  }
}
const polling = new Set<string>();
export async function pollFilmJobs(userId: string, cloudId?: string) {
  const pollKey = `${userId}/${cloudId || ''}`;
  if (!userId || polling.has(pollKey)) return;
  const store = filmStore(userId, cloudId), p = store.getState().project;
  const jobs = p.jobs.filter(j => activeFilmJob(j) && j.status !== 'submitting');
  if (!jobs.length) return;
  polling.add(pollKey);
  try {
    const missing = jobs.filter(j => !j.taskId);
    const recovered = missing.length ? await batchTasksByNodeIds(missing.map(j => j.nodeId)) : [];
    for (const job of jobs) {
      let task;
      try { task = job.taskId ? await getTask(job.taskId) : recovered.find(t => t.node_id === job.nodeId); }
      catch { if (!job.connectionLostAt) updateJob(userId, p.id, job.id, { connectionLostAt: Date.now() }, undefined, cloudId); continue; }
      if (!task || task.node_id !== job.nodeId || store.getState().project.id !== p.id) continue;
      if (task.status === 'success') finish(userId, p.id, job.id, task.result_url, undefined, cloudId);
      else if (['error', 'failed', 'dead', 'cancelled', 'canceled'].includes(task.status)) finish(userId, p.id, job.id, undefined, task.error_msg || '任务执行失败。', cloudId);
      else {
        const phase = task.status === 'running' ? 'generating' : 'queued';
        if (job.phase !== phase || job.connectionLostAt || !job.taskId || Date.now() - (job.lastSyncedAt || 0) > 30000)
          updateJob(userId, p.id, job.id, { taskId: task.id, status: 'running', connectionLostAt: undefined, error: undefined, lastSyncedAt: Date.now() }, phase, cloudId);
      }
    }
  } catch {
    for (const job of jobs) if (!job.connectionLostAt) updateJob(userId, p.id, job.id, { connectionLostAt: Date.now() }, undefined, cloudId);
  } finally { polling.delete(pollKey); }
}
export async function retryFilmJob(userId: string, id: string, replacementPayload?: GeneratePayload, cloudId?: string) {
  const p = filmStore(userId, cloudId).getState().project, job = p.jobs.find(j => j.id === id);
  if (!job) return;
  if (job.status === 'unknown') {
    await pollFilmJobs(userId, cloudId);
    const current = filmStore(userId, cloudId).getState().project.jobs.find(j => j.id === id);
    if (current?.status === 'unknown') await submitFilmJob(userId, p.id, current, cloudId);
  } else if (job.status === 'error') {
    if (['write', 'doctor', 'extract', 'split'].includes(job.kind) && p.script !== job.sourceScript) throw new Error('剧本已经修改，请在对应步骤重新生成，避免沿用旧剧本。');
    await startFilmJob(userId, job.kind, replacementPayload ?? job.payload, job.targetId, cloudId);
  }
}
export async function exportFilm(userId: string, edit: VideoEditProject, cloudId?: string) {
  if (!userId) throw new Error('请先登录后导出视频。');
  const error = validateEditorProject(edit);
  if (error) throw new Error(error);
  const store = filmStore(userId, cloudId), p = store.getState().project;
  if (p.exporting) return;
  store.getState().patch({ exporting: true, exportError: undefined, editProject: edit });
  try {
    const result = await apiClient.post<LocalVideoTrimResult>('/api/app/video/edit', editorExportPayload(edit, `film-export-${p.id}-${editorId()}`), AbortSignal.timeout(510000));
    if (store.getState().project.id === p.id) store.getState().patch({ exportUrl: result.url, exporting: false });
    toast.success('成片已导出，可下载视频。');
  } catch (e) {
    if (store.getState().project.id === p.id) store.getState().patch({ exporting: false, exportError: filmError(e) });
    throw e;
  }
}
