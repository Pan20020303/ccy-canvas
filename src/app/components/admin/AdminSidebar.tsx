import { NavLink } from "react-router";
import { BarChart3, BookKey, Boxes, Logs, ShieldCheck, Users } from "lucide-react";

import logoUrl from "../../../imports/logo.png";

const items = [
  { to: "/admin/overview", label: "概览", icon: BarChart3 },
  { to: "/admin/members", label: "成员", icon: Users },
  { to: "/admin/invitations", label: "邀请码", icon: BookKey },
  { to: "/admin", label: "模型配置", icon: Boxes },
  { to: "/admin/logs", label: "日志", icon: Logs },
];

export function AdminSidebar() {
  return (
    <aside className="flex w-[260px] flex-col border-r border-white/[0.08] bg-[#111111] px-5 py-6">
      <div className="flex items-center gap-3 border-b border-white/[0.06] pb-5">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#ff6a1f]/12 ring-1 ring-[#ff6a1f]/25">
          <img src={logoUrl} alt="CCY Canvas" className="h-7 w-7 object-contain" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">CCY Canvas</p>
          <p className="text-xs uppercase tracking-[0.24em] text-[#ff9b68]">管理后台</p>
        </div>
      </div>

      <nav className="mt-6 space-y-1.5">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/admin"}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 rounded-2xl border px-3.5 py-3 text-sm transition",
                  isActive
                    ? "border-[#ff6a1f]/20 bg-[#ff6a1f]/12 text-[#ff9b68]"
                    : "border-transparent text-neutral-400 hover:border-white/[0.06] hover:bg-white/[0.03] hover:text-white",
                ].join(" ")
              }
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto rounded-3xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,106,31,0.10),rgba(255,106,31,0.02))] p-4">
        <div className="flex items-center gap-2 text-[#ff9b68]">
          <ShieldCheck className="h-4 w-4" />
          <span className="text-xs uppercase tracking-[0.18em]">受保护</span>
        </div>
        <p className="mt-3 text-sm leading-6 text-neutral-300">
          在统一的管理员界面中管理团队空间、成员权限、邀请码以及工作区默认模型。
        </p>
      </div>
    </aside>
  );
}
