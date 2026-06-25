import { useState } from 'react';
import { Bell, CheckCircle2, ChevronDown, Loader2, XCircle } from 'lucide-react';
import clsx from 'clsx';

import { useAuth } from '../auth/AuthProvider';
import { t } from '../i18n';
import { useStore } from '../store';

export const TaskQueue = () => {
  const { language, tasks } = useStore();
  const { user } = useAuth();
  const dict = t[language];
  const [open, setOpen] = useState(false);

  const visibleTasks = tasks;
  const active = visibleTasks.filter((task) => task.status === 'generating').length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        title={dict.task_queue}
        className="relative flex items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1.5 text-xs text-neutral-200 shadow-xl backdrop-blur-xl transition hover:bg-black/60"
      >
        <Bell className={clsx('h-3.5 w-3.5', active > 0 ? 'text-cyan-300' : 'text-neutral-300')} />
        <span>{dict.task_queue}</span>
        {active > 0 ? (
          // Unread badge: small pulsing red dot like a notification bell.
          // Sits over the bell icon's top-right corner.
          <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
          </span>
        ) : null}
        <ChevronDown className={clsx('h-3.5 w-3.5 text-neutral-500 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[420px] w-80 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15181d]/95 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-3">
              <div>
                <div className="text-sm font-medium text-neutral-100">{dict.task_queue}</div>
                <div className="mt-1 text-[10px] text-neutral-500">
                  {language === 'zh'
                    ? `${user?.name ?? '当前用户'} 的任务`
                    : `${user?.name ?? 'Current user'} tasks`}
                </div>
              </div>
              {active > 0 ? (
                <div className="flex items-center gap-1 text-[10px] text-cyan-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  {language === 'zh' ? `${active} 进行中` : `${active} active`}
                </div>
              ) : (
                <div className="text-[10px] text-neutral-500">
                  {language === 'zh' ? `${visibleTasks.length} 条记录` : `${visibleTasks.length} items`}
                </div>
              )}
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {visibleTasks.length === 0 ? (
                <div className="py-6 text-center text-xs text-neutral-500">{dict.empty_queue}</div>
              ) : (
                visibleTasks.map((task) => (
                  <div
                    key={task.id}
                    className={clsx(
                      'flex flex-col rounded-xl border p-3 transition',
                      task.status === 'failed'
                        ? 'border-rose-500/20 bg-rose-500/5'
                        : 'border-white/5 bg-white/[0.03]',
                    )}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium capitalize text-neutral-300">
                        {task.type} {language === 'zh' ? '生成' : 'Generation'}
                      </span>
                      {task.status === 'generating' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-500" />
                      ) : null}
                      {task.status === 'completed' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      ) : null}
                      {task.status === 'failed' ? (
                        <XCircle className="h-3.5 w-3.5 text-rose-400" />
                      ) : null}
                    </div>

                    {task.status === 'generating' ? (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/40">
                        <div
                          className="h-1.5 rounded-full bg-cyan-500 transition-all duration-300 ease-out"
                          style={{ width: `${task.progress}%` }}
                        />
                      </div>
                    ) : (
                      <span className="text-[10px] text-neutral-500">
                        {task.status === 'completed' ? dict.completed : dict.failed}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
};
