import { useEffect, useRef, useState } from 'react';
import { generate, type GeneratePayload } from '../../api/providerConfigs';
import { getTask, batchTasksByNodeIds, type TaskItem } from '../../api/tasks';
import { ApiClientError } from '../../api/client';
import { saveAssetToServer } from '../../api/assets';
import type { StudioAsset } from './studio-library';

export type TryOnJob = { id: string; nodeId: string; taskId?: string; status: 'submitting' | 'pending' | 'unknown' | 'success' | 'error' | 'unsaved'; createdAt: number; prompt: string; message?: string; assets?: StudioAsset[]; folderId: string };
export const jobsKey = (userId: string) => `ccy-tryon-jobs:${userId}`;
export function readJobs(userId: string): TryOnJob[] {
  try {
    const value = JSON.parse(localStorage.getItem(jobsKey(userId)) || '[]');
    return Array.isArray(value) ? value.filter((j: TryOnJob) => j && typeof j.id === 'string' && typeof j.nodeId === 'string' && j.nodeId.startsWith('tryon-') && typeof j.prompt === 'string' && typeof j.createdAt === 'number' && ['submitting', 'pending', 'unknown', 'success', 'error', 'unsaved'].includes(j.status)).map(j => ({ ...j, status: j.status === 'submitting' ? 'unknown' : j.status })) : [];
  } catch { return []; }
}
export function assetsFromJob(job: TryOnJob, urls: string[]): StudioAsset[] {
  return Array.from(new Set(urls.filter(url => /^(https?:\/\/|\/(?!\/))/i.test(url)))).map((url, index) => ({ id: `tryon-${job.id}-${index}`, name: `试衣效果 · ${new Date(job.createdAt).toLocaleString('zh-CN')} · ${index + 1}`, kind: 'image', category: 'other', url, thumbnail: url, text: job.prompt, createdAt: job.createdAt, folderId: job.folderId, source: 'generated' }));
}
export function generationError(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return '登录已失效，请重新登录后继续。';
    if (error.status === 402 || /credit|balance|quota/i.test(error.code)) return '可用积分不足，请检查账户余额。';
    if (error.status === 429) return '生成请求较多，请稍后再试。';
    if (error.status === 403) return '当前账户没有使用此模型的权限。';
    if (error.status === 400 || error.status === 422) return '模型未接受这些参数或参考图片，请调整后重试。';
  }
  return '请求状态暂时无法确认，请检查任务状态，避免重复提交。';
}

/** Generation is only submitted by start(). Mounting, retrying status, and saving never generate or bill. */
export function useTryOnJobs(userId: string, onAsset: (asset: StudioAsset) => void, onCredits: () => void) {
  const [jobs, setJobs] = useState(() => readJobs(userId));
  const [submitting, setSubmitting] = useState(false);
  const [storageError, setStorageError] = useState('');
  const current = useRef(jobs);
  const alive = useRef(false);
  const locked = useRef(false);
  const checking = useRef(new Set<string>());
  const callbacks = useRef({ onAsset, onCredits });
  callbacks.current = { onAsset, onCredits };
  const write = (next: TryOnJob[], required = false) => {
    // Keep unfinished tasks; only prune old completed entries.
    const unfinished = next.filter(j => !['success', 'error'].includes(j.status));
    next = [...unfinished, ...next.filter(j => ['success', 'error'].includes(j.status)).slice(0, 60)].sort((a, b) => b.createdAt - a.createdAt);
    try { localStorage.setItem(jobsKey(userId), JSON.stringify(next)); }
    catch { if (alive.current) setStorageError('浏览器存储不可用，请释放存储空间后重试。'); if (required) throw new Error('无法保存任务记录，本次未提交生成。请释放浏览器存储空间后重试。'); }
    current.current = next;
    if (alive.current) setJobs(next);
  };
  const update = (id: string, patch: Partial<TryOnJob>) => write(current.current.map(j => j.id === id ? { ...j, ...patch } : j));
  const saveResult = async (job: TryOnJob, assets: StudioAsset[]) => {
    update(job.id, { status: 'unsaved', assets, message: '图片已生成，正在保存到素材库。' });
    if (alive.current) assets.forEach(a => callbacks.current.onAsset(a));
    // A route/account change may have happened while the paid request was in
    // flight. Keep the result under the original account's local key, but do
    // not issue a new cookie-authenticated write after that component unmounts.
    if (!alive.current) return;
    try {
      for (const { source: _source, ...asset } of assets) {
        if (!alive.current) return;
        await saveAssetToServer(asset);
      }
      update(job.id, { status: 'success', assets, message: undefined });
    } catch { update(job.id, { status: 'unsaved', message: '图片已生成，但保存失败。请重试保存，不会再次扣费。' }); }
    if (alive.current) callbacks.current.onCredits();
  };
  const consume = async (job: TryOnJob, task: TaskItem) => {
    if (task.status === 'error') {
      update(job.id, { taskId: task.id, status: 'error', message: '模型生成失败，请检查参考图片或更换模型。积分变化以账户账单为准。' });
      if (alive.current) callbacks.current.onCredits();
    } else if (task.status === 'success') {
      const assets = assetsFromJob(job, task.result_urls?.length ? task.result_urls : [task.result_url]);
      if (!assets.length) update(job.id, { taskId: task.id, status: 'error', message: '任务已结束，但没有返回可用的图片。请联系管理员核查任务。' });
      else await saveResult(job, assets);
    } else update(job.id, { status: 'pending', taskId: task.id, message: undefined });
  };
  const check = async (id: string) => {
    const job = current.current.find(j => j.id === id);
    if (!job || checking.current.has(id)) return;
    checking.current.add(id);
    try {
      if (job.status === 'unsaved' && job.assets?.length) { await saveResult(job, job.assets); return; }
      const task = job.taskId ? await getTask(job.taskId) : (await batchTasksByNodeIds([job.nodeId])).find(t => t.node_id === job.nodeId);
      if (task) await consume(job, task);
      else update(id, { status: 'unknown', message: '暂未查到任务记录。请稍后检查状态，不会自动重新生成。' });
    } catch { update(id, { status: 'unknown', message: '任务状态查询失败，请检查网络后重试；不要重复提交生成。' }); }
    finally { checking.current.delete(id); }
  };
  const checkRef = useRef(check); checkRef.current = check;
  useEffect(() => {
    alive.current = true;
    current.current.forEach(j => { if (['pending', 'unknown', 'unsaved'].includes(j.status)) void checkRef.current(j.id); });
    const timer = window.setInterval(() => { current.current.filter(j => j.status === 'pending').forEach(j => void checkRef.current(j.id)); }, 3000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [userId]);
  const start = async (payload: Omit<GeneratePayload, 'node_id' | 'request_id'>, count: number, folderId: string) => {
    if (locked.current || !userId) return;
    locked.current = true; setSubmitting(true);
    try {
      for (let i = 0; i < Math.max(1, Math.min(8, Math.trunc(count))); i++) {
        if (!alive.current) break;
        const id = crypto.randomUUID();
        const job: TryOnJob = { id, nodeId: `tryon-${id}`, status: 'submitting', prompt: payload.prompt, createdAt: Date.now(), folderId };
        write([job, ...current.current], true);
        try {
          const result = await generate({ ...payload, node_id: job.nodeId, request_id: id });
          if (result.type === 'queued' && result.task_id) update(id, { taskId: result.task_id, status: 'pending' });
          else if (result.type === 'url') {
            const assets = assetsFromJob(job, result.content_list?.length ? result.content_list : [result.content]);
            if (!assets.length) { update(id, { status: 'error', message: '模型没有返回可用图片，请联系管理员核查任务。' }); break; }
            await saveResult(job, assets);
          } else { update(id, { status: 'unknown', message: '响应中缺少图片或任务编号，请检查任务状态。' }); break; }
        } catch (error) {
          const rejected = error instanceof ApiClientError && error.status >= 400 && error.status < 500 && error.status !== 408;
          update(id, { status: rejected ? 'error' : 'unknown', message: generationError(error) });
          break; // Never retry a billable request or submit the rest of a failed batch.
        }
      }
    } finally { locked.current = false; if (alive.current) { setSubmitting(false); callbacks.current.onCredits(); } }
  };
  return { jobs, submitting, storageError, start, check, dismiss: (id: string) => write(current.current.filter(j => j.id !== id || !['success', 'error'].includes(j.status))) };
}
