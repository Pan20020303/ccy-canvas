import type { TaskItem } from './api/tasks';

const listeners = new Set<(task: TaskItem) => void>();
let accountEpoch = 0;

export function taskAccountSession(): number { return accountEpoch; }
export function invalidateTaskAccountSession(): void { accountEpoch += 1; }

/** Shared by the task tray and canvas tracker without importing either UI. */
export function publishTaskUpdate(task: TaskItem): void {
  for (const listener of listeners) {
    try { listener(task); }
    catch (error) { console.error('[tasks] Task update listener failed', error); }
  }
}

export function subscribeTaskUpdates(listener: (task: TaskItem) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function isActiveGenerationTask(status: string): boolean {
  return ['queued', 'pending', 'running', 'retrying', 'persisting'].includes(status.trim().toLowerCase());
}

/** SSE/recovery projections may omit immutable labels and creation time. */
export function mergeTaskUpdate(current: TaskItem, incoming: TaskItem): TaskItem {
  return {
    ...current, ...incoming,
    project_id: incoming.project_id || current.project_id,
    project_name: incoming.project_name || current.project_name,
    created_at: incoming.created_at || current.created_at,
    can_cancel: incoming.status === 'queued' ? (incoming.can_cancel ?? current.can_cancel) : false,
  };
}

export function generationTaskLabel(status: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    queued: ['排队中', 'Queued'], pending: ['等待执行', 'Pending'],
    running: ['生成中', 'Generating'], retrying: ['等待重试', 'Retrying'],
    persisting: ['保存结果中', 'Saving result'],
    success: ['已完成', 'Completed'], error: ['失败', 'Failed'],
    dead: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], canceled: ['已取消', 'Cancelled'],
  };
  return labels[status.trim().toLowerCase()]?.[zh ? 0 : 1] ?? (zh ? '状态待确认' : 'Status unknown');
}
