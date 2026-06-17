import { NavLink } from "react-router";
import { BarChart3, BookKey, Bot, BrainCircuit, FileText, Logs, Monitor, ShieldCheck, Sparkles, UserCog, Users } from "lucide-react";

import logoUrl from "../../../imports/logo.png";

const items = [
  { to: "/admin/overview", label: "概览", icon: BarChart3 },
  { to: "/admin/members", label: "成员", icon: Users },
  { to: "/admin/invitations", label: "邀请码", icon: BookKey },
  { to: "/admin", label: "模型服务", icon: Monitor },
  { to: "/admin/agents", label: "Agent配置", icon: UserCog },
  { to: "/admin/prompts", label: "提示词管理", icon: FileText },
  { to: "/admin/skills", label: "Skills技能管理", icon: Sparkles },
  { to: "/admin/memory", label: "Agent记忆配置", icon: BrainCircuit },
  { to: "/admin/agent-runs", label: "智能体记录", icon: Bot },
  { to: "/admin/logs", label: "日志", icon: Logs },
];

export function AdminSidebar() {
  return (
    <aside className="relative z-10 flex min-h-screen w-[280px] shrink-0 flex-col border-r border-white/[0.08] bg-[linear-gradient(180deg,#121212_0%,#0c0c0c_100%)] px-5 py-6">
      <div data-admin-hero className="flex items-center gap-3 border-b border-white/[0.06] pb-5">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#ff6a1f]/12 ring-1 ring-[#ff6a1f]/25 shadow-[0_18px_38px_-26px_rgba(255,106,31,0.9)]">
          <img src={logoUrl} alt="CCY Canvas" className="h-7 w-7 object-contain" />
        </div>
        <div>
          <p className="text-sm font-semibold text-white">CCY Canvas</p>
          <p className="text-xs uppercase tracking-[0.24em] text-[#ff9b68]">管理后台</p>
        </div>
      </div>

      <nav data-admin-card className="mt-6 space-y-1.5 rounded-[28px] border border-white/[0.04] bg-white/[0.02] p-2.5">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/admin"}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 rounded-2xl border px-3.5 py-3 text-sm transition duration-300",
                  isActive
                    ? "border-[#ff6a1f]/25 bg-[linear-gradient(90deg,rgba(255,106,31,0.20),rgba(255,106,31,0.05))] text-[#ffb183] shadow-[0_18px_40px_-28px_rgba(255,106,31,0.95)]"
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

      <div
        data-admin-card
        className="mt-auto rounded-3xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,106,31,0.14),rgba(255,106,31,0.03))] p-4 shadow-[0_26px_60px_-38px_rgba(255,106,31,0.9)] transition duration-300 hover:-translate-y-0.5 hover:border-[#ff6a1f]/20"
      >
        <div className="flex items-center gap-2 text-[#ff9b68]">
          <ShieldCheck className="h-4 w-4" />
          <span className="text-xs uppercase tracking-[0.18em]">安全守护</span>
        </div>
        <p className="mt-3 text-sm leading-6 text-neutral-300">
          在统一的管理员工作台中管理团队空间、成员权限、邀请码和默认模型，让日常运营与模型治理保持在同一条工作流里。
        </p>
      </div>
    </aside>
  );
}
