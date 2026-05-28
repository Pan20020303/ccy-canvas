import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { AdminSidebar } from "./AdminSidebar";

type AdminShellProps = {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
};

export function AdminShell({ title, description, action, children }: AdminShellProps) {
  return (
    <div className="min-h-screen bg-[#090909] text-neutral-100">
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <AdminSidebar />
        <main className="flex flex-1 flex-col px-8 py-8">
          <div className="mb-6 flex items-center justify-between">
            <Link
              to="/app"
              className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs uppercase tracking-[0.18em] text-neutral-300 transition hover:border-[#ff6a1f]/25 hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回工作区
            </Link>
          </div>

          <header className="mb-8 flex flex-wrap items-start justify-between gap-6 border-b border-white/[0.08] pb-8">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-[#ff9b68]">管理员</p>
              <h1 className="mt-3 text-3xl font-semibold text-white">{title}</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-400">{description}</p>
            </div>
            {action}
          </header>

          <div className="flex-1">{children}</div>
        </main>
      </div>
    </div>
  );
}
