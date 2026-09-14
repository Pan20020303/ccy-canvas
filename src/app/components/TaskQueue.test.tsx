// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskQueue } from './TaskQueue';
import type { TaskItem } from '../api/tasks';
import { t } from '../i18n';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), announcements: vi.fn(), state: {} as Record<string, any> }));
vi.mock('../api/client', () => ({ apiClient: { get: mocks.get, post: mocks.post } }));
vi.mock('../api/announcements', () => ({ listAnnouncements: mocks.announcements }));
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'user' } }) }));
vi.mock('../store', () => ({ useStore: Object.assign((select: (state: any) => any) => select(mocks.state), { getState: () => mocks.state }) }));

const queued: TaskItem = { id: 'task-1', node_id: 'node-1', project_id: 'project-1', project_name: '真实项目', service_type: 'video', model: '本地模型', status: 'queued', result_url: '', error_msg: '', duration_ms: 0, created_at: '2026-09-06T00:00:00Z', can_cancel: true };
let root: Root;
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label)!;
const click = async (target: HTMLElement) => { await act(async () => target.click()); };
const openTasks = async () => {
  await act(async () => root.render(<TaskQueue />));
  await click(document.querySelector('[title="公告与任务"]') as HTMLElement);
  const tab = [...document.querySelectorAll('button')].find(item => item.textContent?.startsWith(t.zh.task_queue))!;
  await click(tab);
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No network or generation in UI tests')));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  mocks.get.mockReset().mockResolvedValue([queued]); mocks.post.mockReset();
  mocks.announcements.mockReset().mockResolvedValue([]);
  mocks.state = { language: 'zh', tasks: [{ id: 'obsolete-ui-row', type: '假的任务' }], nodes: [{ id: 'node-1' }], activeBackendProjectId: 'project-1', requestCanvasFocus: vi.fn(), switchBackendProject: vi.fn().mockResolvedValue(true) };
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); document.body.innerHTML = '';
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('durable task tray', () => {
  it('uses server status and location instead of the old UI array or fake progress', async () => {
    mocks.get.mockResolvedValue([queued, { ...queued, id: 'failed', node_id: 'n2', status: 'error', can_cancel: false, error_msg: '参考文件不可用', duration_ms: 2000 }]);
    await openTasks();
    expect(mocks.get).toHaveBeenCalledWith('/api/app/tasks/recent?limit=50');
    expect(document.body.textContent).toContain('真实项目');
    expect(document.body.textContent).toContain('排队中');
    expect(document.body.textContent).toContain('参考文件不可用');
    expect(document.body.textContent).not.toContain('假的任务');
    expect(document.querySelector('[style*="width:"]')).toBeNull();
    await click(button('定位节点'));
    expect(mocks.state.requestCanvasFocus).toHaveBeenCalledWith('node-1');
  });

  it('waits for server confirmation and publishes the cancelled terminal state', async () => {
    let resolve!: (value: unknown) => void;
    mocks.post.mockImplementation(() => new Promise(done => { resolve = done; }));
    await openTasks(); await click(button('取消排队'));
    expect(document.body.textContent).toContain('确认取消中');
    expect(document.body.textContent).toContain('排队中');
    expect(document.body.textContent).not.toContain('已取消');
    await act(async () => resolve({ task: { ...queued, status: 'cancelled', can_cancel: false }, cancelled: true, reason: 'cancelled' }));
    expect(document.body.textContent).toContain('已取消');
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/app/tasks/task-1/cancel', {});
  });

  it('keeps tracking a task that started while cancellation was requested', async () => {
    mocks.post.mockResolvedValue({ task: { ...queued, status: 'running', can_cancel: false, cancel_reason: '任务已开始执行，当前不能取消；结果将继续返回。' }, cancelled: false, reason: 'already_started' });
    await openTasks(); await click(button('取消排队'));
    expect(document.body.textContent).toContain('生成中');
    expect(document.body.textContent).toContain('继续跟踪');
    expect(document.body.textContent).not.toContain('已取消');
    expect(button('取消排队')).toBeUndefined();
  });

  it('retains queued status after a failed cancellation request', async () => {
    mocks.post.mockRejectedValue(new Error('未能确认取消'));
    await openTasks(); await click(button('取消排队'));
    expect(document.body.textContent).toContain('未能确认取消');
    expect(document.body.textContent).toContain('排队中');
    expect(button('取消排队')).toBeDefined();
    expect(document.body.textContent).not.toContain('已取消');
  });

  it('shows a list failure as unavailable, never a false empty queue', async () => {
    mocks.get.mockRejectedValue(new Error('任务列表暂不可用'));
    await openTasks();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('任务列表暂不可用');
    expect(document.body.textContent).not.toContain(t.zh.empty_queue);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
