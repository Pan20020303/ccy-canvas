import { useEffect, useState } from "react";
import { Users, Boxes, Zap, AlertTriangle, Loader2 } from "lucide-react";

import type { AdminStats } from "../../api/admin";
import { getAdminStats } from "../../api/admin";
import { AdminShell } from "./AdminShell";

function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string | number; sub?: string; icon: any; color: string;
}) {
  return (
    <div className="rounded-[24px] border border-white/[0.08] bg-[#111111] p-5 shadow-[0_25px_70px_-35px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-2">
        <div className={`flex h-8 w-8 items-center justify-center rounded-xl ${color}`}>
          <Icon className="h-4 w-4" />
        </div>
        <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">{label}</p>
      </div>
      <p className="mt-3 text-3xl font-semibold text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-neutral-500">{sub}</p>}
    </div>
  );
}

export function AdminOverviewPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAdminStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <AdminShell title="概览" description="管理后台总览">
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-500" />
        </div>
      </AdminShell>
    );
  }

  const s = stats ?? {
    total_users: 0, admin_users: 0, active_users: 0,
    total_providers: 0, enabled_providers: 0,
    generations_today: 0, success_today: 0, errors_today: 0,
    credits_consumed_today: 0,
  };

  return (
    <AdminShell title="概览" description="管理后台总览 — 用户、模型、生成和积分的实时数据。">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} label="注册用户" value={s.total_users} sub={`${s.admin_users} 管理员 · ${s.active_users} 活跃`} color="bg-blue-500/15 text-blue-400" />
        <StatCard icon={Boxes} label="模型配置" value={s.total_providers} sub={`${s.enabled_providers} 已启用`} color="bg-violet-500/15 text-violet-400" />
        <StatCard icon={Zap} label="今日生成" value={s.generations_today} sub={`${s.success_today} 成功 · ${s.errors_today} 失败`} color="bg-emerald-500/15 text-emerald-400" />
        <StatCard icon={AlertTriangle} label="今日积分消耗" value={s.credits_consumed_today} color="bg-amber-500/15 text-amber-400" />
      </div>
    </AdminShell>
  );
}
