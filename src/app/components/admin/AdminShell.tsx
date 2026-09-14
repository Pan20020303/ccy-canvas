import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bell, CheckCheck, ChevronRight, Copy, X } from "lucide-react";
import { Link, useLocation } from "react-router";
import * as Dialog from "@radix-ui/react-dialog";

import {
  type AdminAlert,
  getUnreadAlertCount,
  listAdminAlerts,
  markAdminAlertRead,
  markAllAdminAlertsRead,
} from "../../api/admin";
import { AdminSidebar } from "./AdminSidebar";
import { ADMIN_COLLAPSED_KEY, getAdminNavGroup, readAdminCollapsed } from "./admin-navigation";
import "./admin.css";
import { useAdminWorkbenchMotion } from "./useAdminWorkbenchMotion";

type AdminShellProps = {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
};

export function AdminShell({ title, description, action, children }: AdminShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const group = getAdminNavGroup(pathname);
  const [mobile, setMobile] = useState(() => window.matchMedia?.("(max-width: 760px)").matches ?? false);
  const [collapsed, setCollapsed] = useState(() => (window.matchMedia?.("(max-width: 760px)").matches ?? false) || readAdminCollapsed());
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 760px)");
    if (!query) return;
    const update = () => { setMobile(query.matches); setCollapsed(query.matches || readAdminCollapsed()); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (!mobile) {
      try { localStorage.setItem(ADMIN_COLLAPSED_KEY, String(next)); } catch { /* Optional preference. */ }
    }
  };
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
    <div ref={rootRef} className="admin-workbench dark" data-collapsed={collapsed}>
      <a href="#admin-page-content" className="admin-skip-link">跳到页面内容</a>
      <AdminSidebar collapsed={collapsed} mobile={mobile} onToggle={toggleSidebar} onClose={() => setCollapsed(true)} />
      <main className="admin-main" inert={mobile && !collapsed}>
        <div className="admin-topbar">
          <nav aria-label="当前位置" className="admin-breadcrumb">
            <Link to="/admin/overview">管理后台</Link>
            <ChevronRight size={13} />
            {group && <><span className="admin-breadcrumb-group">{group.label}</span><ChevronRight className="admin-breadcrumb-group" size={13} /></>}
            <span aria-current="page">{title}</span>
          </nav>
          <div className="admin-topbar-actions">
            <Link to="/app" className="admin-toolbar-button admin-back-workspace"><ArrowLeft size={15} /><span>返回工作区</span></Link>
            <button type="button" className={`admin-toolbar-button admin-alert-trigger${alertCount > 0 ? ' has-alerts' : ''}`}
              onClick={() => setAlertsOpen(true)} aria-label={alertCount > 0 ? `渠道告警，${alertCount} 条未读` : "渠道告警"}
              title={alertCount > 0 ? `当前有 ${alertCount} 条未读告警` : "当前暂无未读告警"}>
              <Bell size={16} /><span>告警</span>{alertCount > 0 && <b>{alertCount}</b>}
            </button>
          </div>
        </div>
        <header className="admin-page-header">
          <div data-admin-hero className="admin-page-heading">
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {action && <div data-admin-hero className="admin-page-actions">{action}</div>}
        </header>
        <div id="admin-page-content" tabIndex={-1} className="admin-page-content">{children}</div>
      </main>
      {alertsOpen && <AlertDrawer alerts={alerts} onClose={() => setAlertsOpen(false)} onRefresh={refreshAlerts} />}
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
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm" />
      <Dialog.Content
        aria-describedby={undefined}
        className="admin-alert-drawer fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-white/[0.08] bg-[#1c1c1c] p-5 text-neutral-100 shadow-2xl"
        onCloseAutoFocus={(event) => { event.preventDefault(); document.querySelector<HTMLButtonElement>('.admin-alert-trigger')?.focus(); }}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-neutral-500">运行监控</p>
            <Dialog.Title className="mt-1 text-lg font-semibold">渠道告警</Dialog.Title>
          </div>
          <button aria-label="关闭渠道告警" className="rounded-full p-2 text-neutral-400 transition hover:bg-white/8 hover:text-white" onClick={onClose}>
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
      </Dialog.Content>
    </Dialog.Root>
  );
}

function severityClass(severity: AdminAlert["severity"]) {
  const base = "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase";
  if (severity === "high") return `${base} bg-rose-400/20 text-rose-200 ring-1 ring-rose-400/30`;
  if (severity === "medium") return `${base} bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/30`;
  return `${base} bg-neutral-400/15 text-neutral-300 ring-1 ring-neutral-400/25`;
}
