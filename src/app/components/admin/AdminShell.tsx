import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Megaphone } from "lucide-react";
import { Link } from "react-router";

import { getAdminStats } from "../../api/admin";
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
  const [errorCount, setErrorCount] = useState(0);

  useAdminWorkbenchMotion({ rootRef });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const stats = await getAdminStats();
        if (alive) setErrorCount(stats.errors_today ?? 0);
      } catch {
        if (alive) setErrorCount(0);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 30000);
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
                  className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs uppercase tracking-[0.18em] text-neutral-300 transition hover:border-[#ff6a1f]/25 hover:bg-white/[0.07] hover:text-white"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回工作区
                </Link>
              </div>
              <div className="flex items-center gap-3">
                <Link
                  to="/admin"
                  title={errorCount > 0 ? `今日有 ${errorCount} 次生成异常` : "当前暂无生成异常"}
                  className={[
                    "inline-flex h-11 items-center gap-2 rounded-full border px-4 text-sm transition",
                    errorCount > 0
                      ? "border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15"
                      : "border-white/[0.08] bg-white/[0.04] text-neutral-300 hover:border-[#ff6a1f]/25 hover:bg-white/[0.07] hover:text-white",
                  ].join(" ")}
                >
                  <Megaphone className="h-4 w-4" />
                  <span className="hidden sm:inline">告警</span>
                  {errorCount > 0 ? (
                    <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-rose-400 px-1.5 py-0.5 text-[11px] font-semibold text-rose-950">
                      {errorCount}
                    </span>
                  ) : (
                    <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-white/8 px-1.5 py-0.5 text-[11px] text-neutral-400">
                      <AlertTriangle className="h-3 w-3" />
                    </span>
                  )}
                </Link>
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
      </div>
    </div>
  );
}
