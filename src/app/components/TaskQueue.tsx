import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle2, Loader2, Megaphone, XCircle } from 'lucide-react';
import clsx from 'clsx';

import { listAnnouncements, type Announcement } from '../api/announcements';
import { cancelTask, listRecentTasks, type TaskItem } from '../api/tasks';
import { generationTaskLabel, isActiveGenerationTask, mergeTaskUpdate, subscribeTaskUpdates } from '../task-events';
import { useAuth } from '../auth/AuthProvider';
import { t } from '../i18n';
import { useStore } from '../store';

// 每用户一份「最后已读公告时间」,存 localStorage,打开公告页签即清红点。
const readKey = (userId: string) => `ccy-announcements-read@${userId}`;

const isAfter = (a: string, b: string) => {
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta > tb : a > b;
};

export const TaskQueue = () => {
  const language = useStore((state) => state.language);
  const { user } = useAuth();
  const dict = t[language];
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'announcements' | 'tasks'>('announcements');
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [annLoading, setAnnLoading] = useState(false);
  const [lastRead, setLastRead] = useState('');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [taskError, setTaskError] = useState('');
  const [taskLoading, setTaskLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [taskRefresh, setTaskRefresh] = useState(0);
  const taskRevision = useRef(0);
  const refreshTasks = useCallback(() => setTaskRefresh(value => value + 1), []);

  // The tray consumes persisted server tasks, not the unused legacy UI array.
  // No fake percent: queued/running/persisting are real backend phases.
  useEffect(() => {
    setTasks([]);
    setTaskError('');
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let stopped = false;
    let pending = false;
    const refresh = async () => {
      if (stopped || pending || (typeof document !== 'undefined' && document.hidden)) return;
      pending = true;
      const revision = taskRevision.current;
      setTaskLoading(true);
      try {
        const next = await listRecentTasks(50);
        if (!stopped && revision === taskRevision.current) { setTasks(next); setTaskError(''); }
      } catch (error) {
        if (!stopped) setTaskError(error instanceof Error ? error.message : (language === 'zh' ? '任务列表暂不可用' : 'Tasks unavailable'));
      } finally {
        pending = false;
        if (!stopped) setTaskLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), open && tab === 'tasks' ? 8000 : 30000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribe = subscribeTaskUpdates(task => {
      if (stopped) return;
      taskRevision.current += 1;
      // Late responses from a previous signed-in user must not inject rows
      // into this user's tray. New rows arrive through the scoped list API.
      setTasks(current => current.map(item => item.id === task.id ? mergeTaskUpdate(item, task) : item));
    });
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); unsubscribe(); };
  }, [user?.id, open, tab, language, taskRefresh]);

  const locateTask = async (task: TaskItem) => {
    const state = useStore.getState();
    if (task.project_id && state.activeBackendProjectId !== task.project_id) {
      if (!await state.switchBackendProject(task.project_id)) return;
    }
    if (!useStore.getState().nodes.some(node => node.id === task.node_id)) {
      setTaskError(language === 'zh' ? '该任务的节点不在当前画布中，任务记录和结果仍保留。' : 'The node is unavailable; the task and result are retained.');
      return;
    }
    useStore.getState().requestCanvasFocus(task.node_id);
    setOpen(false);
  };

  const cancelQueuedTask = async (task: TaskItem) => {
    if (cancelling) return;
    setCancelling(task.id);
    try {
      const result = await cancelTask(task.id);
      setTaskError(result.cancelled ? '' : (result.task.cancel_reason || (language === 'zh' ? '任务未取消，将继续跟踪。' : 'Task continues; tracking remains active.')));
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : (language === 'zh' ? '未能确认取消，任务仍在跟踪' : 'Cancellation unconfirmed; still tracking'));
    } finally { setCancelling(null); }
  };

  const storageKey = readKey(user?.id ?? 'anon');

  useEffect(() => {
    try {
      setLastRead(localStorage.getItem(storageKey) ?? '');
    } catch {
      /* storage 不可用时红点常亮,不影响功能 */
    }
  }, [storageKey]);

  const refreshAnnouncements = useCallback(async () => {
    setAnnLoading(true);
    try {
      setAnnouncements(await listAnnouncements());
    } catch {
      /* 未登录 / 网络失败静默,铃铛仍可看任务 */
    }
    setAnnLoading(false);
  }, []);

  useEffect(() => {
    void refreshAnnouncements();
  }, [refreshAnnouncements]);

  const latest = announcements[0]?.created_at ?? '';
  const unread = isAfter(latest, lastRead);

  // 公告页签展开着就视为已读(含刷新后新到的公告)。
  useEffect(() => {
    if (!open || tab !== 'announcements' || !latest || !isAfter(latest, lastRead)) return;
    setLastRead(latest);
    try {
      localStorage.setItem(storageKey, latest);
    } catch {
      /* 同上 */
    }
  }, [open, tab, latest, lastRead, storageKey]);

  const visibleTasks = tasks;
  const active = visibleTasks.filter((task) => isActiveGenerationTask(task.status)).length;

  const handleToggle = () => {
    setOpen((value) => {
      const next = !value;
      if (next) {
        setTab('announcements');
        void refreshAnnouncements();
      }
      return next;
    });
  };

  return (
    <div className="relative">
      {/* Icon-only bell (reference proportions) — the label lives in the
          tooltip and the dropdown header. */}
      <button
        onClick={handleToggle}
        title={language === 'zh' ? '公告与任务' : 'Announcements & tasks'}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/45 text-neutral-200 shadow-xl backdrop-blur-xl transition hover:bg-black/60"
      >
        <Bell className={clsx('h-4 w-4', active > 0 ? 'text-cyan-300' : 'text-neutral-300')} />
        {unread ? (
          // 未读公告红点:打开公告页签后熄灭。
          <span className="absolute right-1.5 top-1.5 flex h-2 w-2 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[460px] w-80 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15181d]/95 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center gap-1 border-b border-white/10 bg-white/5 px-2 py-2">
              <button
                onClick={() => setTab('announcements')}
                className={clsx(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition',
                  tab === 'announcements' ? 'bg-white/10 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
                )}
              >
                <Megaphone className="h-3.5 w-3.5" />
                {language === 'zh' ? '公告' : 'News'}
              </button>
              <button
                onClick={() => setTab('tasks')}
                className={clsx(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition',
                  tab === 'tasks' ? 'bg-white/10 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
                )}
              >
                {dict.task_queue}
                {active > 0 ? (
                  <span className="flex items-center gap-1 text-[10px] text-cyan-300">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
                    {active}
                  </span>
                ) : null}
              </button>
            </div>

            {tab === 'announcements' ? (
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {annLoading && announcements.length === 0 ? (
                  <div className="py-6 text-center">
                    <Loader2 className="mx-auto h-4 w-4 animate-spin text-neutral-500" />
                  </div>
                ) : announcements.length === 0 ? (
                  <div className="py-6 text-center text-xs text-neutral-500">
                    {language === 'zh' ? '暂无公告' : 'No announcements yet'}
                  </div>
                ) : (
                  announcements.map((item) => (
                    <div key={item.id} className="rounded-xl border border-white/5 bg-white/[0.03] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-xs font-medium text-neutral-100">{item.title}</span>
                        <span className="shrink-0 text-[10px] text-neutral-500">
                          {new Date(item.created_at).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}
                        </span>
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-5 text-neutral-400">{item.content}</p>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {taskError ? <div role="alert" className="text-xs text-rose-300">{taskError}<button type="button" onClick={refreshTasks} className="ml-2 underline">{language === 'zh' ? '重试' : 'Retry'}</button></div> : null}
                {taskLoading && visibleTasks.length === 0 ? <Loader2 className="mx-auto h-4 w-4 animate-spin text-neutral-500" /> : null}
                {!taskLoading && !taskError && visibleTasks.length === 0 ? (
                  <div className="py-6 text-center text-xs text-neutral-500">{dict.empty_queue}</div>
                ) : (
                  visibleTasks.map((task) => (
                    <div
                      key={task.id}
                      className={clsx(
                        'flex flex-col rounded-xl border p-3 transition',
                          ['failed', 'error', 'dead'].includes(task.status)
                          ? 'border-rose-500/20 bg-rose-500/5'
                          : 'border-white/5 bg-white/[0.03]',
                      )}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium capitalize text-neutral-300">
                          {task.model || task.service_type}
                        </span>
                        {isActiveGenerationTask(task.status) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-500" />
                        ) : null}
                        {task.status === 'success' ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        ) : null}
                        {['failed', 'error', 'dead'].includes(task.status) ? (
                          <XCircle className="h-3.5 w-3.5 text-rose-400" />
                        ) : null}
                      </div>

                      <span className="truncate text-[10px] text-neutral-500" title={task.node_id}>{task.project_name || task.project_id || (language === 'zh' ? '未关联项目' : 'No project')} · {task.node_id}</span>
                      <span className="text-[10px] text-neutral-500">{generationTaskLabel(task.status, language === 'zh')}{task.duration_ms > 0 ? ` · ${(task.duration_ms / 1000).toFixed(1)}s` : ''}</span>
                      {task.error_msg ? <span className="break-words text-[10px] text-rose-300">{task.error_msg}</span> : null}
                      <div className="mt-2 flex items-center gap-3 text-[10px] text-neutral-400">
                        <button type="button" onClick={() => void locateTask(task)}>{language === 'zh' ? '定位节点' : 'Locate node'}</button>
                        {task.can_cancel ? <button type="button" disabled={Boolean(cancelling)} onClick={() => void cancelQueuedTask(task)}>{cancelling === task.id ? (language === 'zh' ? '确认取消中…' : 'Cancelling…') : (language === 'zh' ? '取消排队' : 'Cancel queued task')}</button> : null}
                        {isActiveGenerationTask(task.status) && !task.can_cancel ? <span title={task.cancel_reason}>{language === 'zh' ? '继续跟踪' : 'Tracking'}</span> : null}
                      </div>
                    </div>
                  ))
                )}
                {visibleTasks.length >= 50 ? <div className="text-[10px] text-neutral-500">{language === 'zh' ? '显示最近 50 项，进行中的任务优先。' : 'Showing 50 tasks; active tasks first.'}</div> : null}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
};
