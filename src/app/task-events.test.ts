import { describe, expect, it, vi } from 'vitest';
import type { TaskItem } from './api/tasks';
import { generationTaskLabel, isActiveGenerationTask, mergeTaskUpdate, publishTaskUpdate, subscribeTaskUpdates } from './task-events';

const queued: TaskItem = { id: 't1', node_id: 'n1', project_id: 'p1', project_name: 'Project', service_type: 'video', model: 'm1', status: 'queued', result_url: '', error_msg: '', duration_ms: 0, created_at: '2026-09-06T00:00:00Z', can_cancel: true };

describe('task updates', () => {
  it('keeps labels from the list when an SSE event supplies only status', () => {
    const event = { ...queued, status: 'running', project_id: undefined, project_name: undefined, created_at: '', can_cancel: undefined };
    const merged = mergeTaskUpdate(queued, event);
    expect(merged).toMatchObject({ status: 'running', project_name: 'Project', project_id: 'p1', created_at: queued.created_at, can_cancel: false });
  });

  it('does not turn a committed API result into failure when one subscriber fails', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unsubscribeBad = subscribeTaskUpdates(() => { throw new Error('bad consumer'); });
    const good = vi.fn(); const unsubscribeGood = subscribeTaskUpdates(good);
    expect(() => publishTaskUpdate(queued)).not.toThrow();
    expect(good).toHaveBeenCalledWith(queued);
    unsubscribeBad(); unsubscribeGood(); quiet.mockRestore();
  });

  it('treats cancellation as terminal rather than failure or a running task', () => {
    expect(isActiveGenerationTask('cancelled')).toBe(false);
    expect(generationTaskLabel('cancelled', true)).toBe('已取消');
    expect(generationTaskLabel('persisting', true)).toBe('保存结果中');
    expect(generationTaskLabel('mystery', true)).toBe('状态待确认');
  });
});
