import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCheck, Copy, Megaphone, X } from "lucide-react";
import { Link } from "react-router";

import {
  type AdminAlert,
  getUnreadAlertCount,
  listAdminAlerts,
  markAdminAlertRead,
  markAllAdminAlertsRead,
} from "../../api/admin";
import { AdminSidebar } from "./AdminSidebar";
import { useAdminWorkbenchMotion } from "./useAdminWorkbenchMotion";

type AdminShellProps = {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
};

export function AdminShell({ title, description, action, children }: AdminShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [alertCount, setAlertCount] = useState(0);
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);

  useAdminWorkbenchMotion({ rootRef });

  const refreshAlerts = async () => {
    const [{ count }, latest] = await Promise.all([getUnreadAlertCount(), listAdminAlerts("", 20)]);
    setAlertCount(count ?? 0);
    setAlerts(latest);
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [{ count }, latest] = await Promise.all([getUnreadAlertCount(), listAdminAlerts("", 20)]);
        if (alive) {
          setAlertCount(count ?? 0);
          setAlerts(latest);
        }
      } catch {
        if (alive) setAlertCount(0);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div ref={rootRef} className="min-h-screen bg-[#060606] text-neutral-100">
      <div className="relative flex min-h-screen w-full overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,106,31,0.16),transparent_24%),radial-gradient(circle_at_top_right,rgba(93,124,255,0.12),transparent_22%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_28%)]" />
        <AdminSidebar />
        <main className="relative flex min-h-screen min-w-0 flex-1 flex-col bg-[linear-gradient(180deg,rgba(255,255,255,0.025),rgba(255,255,255,0))]">
          <div className="border-b border-white/[0.06] px-6 py-5 lg:px-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div data-admin-hero>
                <Link
                  to="/app"
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.045] px-4 text-xs font-medium uppercase tracking-[0.16em] text-neutral-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition hover:border-[#ff6a1f]/35 hover:bg-white/[0.075] hover:text-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff6a1f]/40"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回工作区
                </Link>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setAlertsOpen(true)}
                  title={alertCount > 0 ? `当前有 ${alertCount} 条未读告警` : "当前暂无未读告警"}
                  className={[
                    "inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff6a1f]/45",
                    alertCount > 0
                      ? "border-rose-400/35 bg-rose-500/12 text-rose-100 hover:border-rose-300/50 hover:bg-rose-500/18"
                      : "border-white/[0.08] bg-white/[0.045] text-neutral-300 hover:border-[#ff6a1f]/35 hover:bg-white/[0.075] hover:text-white",
                  ].join(" ")}
                >
                  <Megaphone className="h-4 w-4" />
                  <span className="hidden sm:inline">告警</span>
                  {alertCount > 0 ? (
                    <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-rose-400 px-1.5 py-0.5 text-[11px] font-semibold text-rose-950">
                      {alertCount}
                    </span>
                  ) : (
                    <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-white/8 px-1.5 py-0.5 text-[11px] text-neutral-400">
                      <AlertTriangle className="h-3 w-3" />
                    </span>
                  )}
                </button>
                {action ? <div data-admin-hero className="shrink-0">{action}</div> : null}
              </div>
            </div>

            <header className="mt-6 flex flex-wrap items-start justify-between gap-6">
              <div data-admin-hero>
                <p className="text-xs uppercase tracking-[0.28em] text-[#ff9b68]">管理员工作台</p>
                <h1 className="mt-3 text-3xl font-semibold text-white lg:text-4xl">{title}</h1>
                <p className="mt-3 max-w-4xl text-sm leading-6 text-neutral-400 lg:text-[15px]">{description}</p>
              </div>
            </header>
          </div>

          <div className="flex-1 px-6 py-6 lg:px-8 lg:py-8">{children}</div>
        </main>

        {alertsOpen ? (
          <AlertDrawer alerts={alerts} onClose={() => setAlertsOpen(false)} onRefresh={refreshAlerts} />
        ) : null}
      </div>
    </div>
  );
}

function AlertDrawer({
  alerts,
  onClose,
  onRefresh,
}: {
  alerts: AdminAlert[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/45 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="h-full w-full max-w-md overflow-y-auto border-l border-white/[0.08] bg-[#101014]/95 p-5 text-neutral-100 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-[#ff9b68]">Channel Alerts</p>
            <h2 className="mt-1 text-lg font-semibold">渠道告警</h2>
          </div>
          <button className="rounded-full p-2 text-neutral-400 transition hover:bg-white/8 hover:text-white" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <button
          className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/[0.08] px-3 py-1.5 text-xs text-neutral-300 transition hover:border-emerald-400/40 hover:text-emerald-200"
          onClick={async () => {
            await markAllAdminAlertsRead();
            await onRefresh();
          }}
        >
          <CheckCheck className="h-3.5 w-3.5" />
          全部标记已读
        </button>
        <div className="mt-5 space-y-3">
          {alerts.length === 0 ? (
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-6 text-sm text-neutral-400">
              暂无告警。渠道失败会只在这里报警，不会自动切换或锁定。
            </div>
          ) : (
            alerts.map((alert) => (
              <div key={alert.id} className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={severityClass(alert.severity)}>{alert.severity}</span>
                      <span className="font-mono text-xs text-neutral-400">{alert.error_code || "upstream_error"}</span>
                    </div>
                    <p className="mt-2 text-sm font-medium text-white">{alert.provider_name || alert.model || "未知渠道"}</p>
                  </div>
                  <button
                    className="rounded-full p-1.5 text-neutral-500 transition hover:bg-white/8 hover:text-white"
                    onClick={() => navigator.clipboard?.writeText(alert.error_message)}
                    title="复制错误"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-3 line-clamp-4 text-xs leading-5 text-neutral-400">{alert.error_message}</p>
                <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-500">
                  <span>{alert.source}</span>
                  <button
                    className="text-[#ff9b68] transition hover:text-white"
                    onClick={async () => {
                      await markAdminAlertRead(alert.id);
                      await onRefresh();
                    }}
                  >
                    标记已读
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

function severityClass(severity: AdminAlert["severity"]) {
  const base = "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase";
  if (severity === "high") return `${base} bg-rose-400/20 text-rose-200 ring-1 ring-rose-400/30`;
  if (severity === "medium") return `${base} bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/30`;
  return `${base} bg-neutral-400/15 text-neutral-300 ring-1 ring-neutral-400/25`;
}
