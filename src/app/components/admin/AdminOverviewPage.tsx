import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CreditCard,
  Loader2,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import { gsap } from "gsap";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, XAxis } from "recharts";

import type { AdminStats } from "../../api/admin";
import { getAdminStats } from "../../api/admin";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { AdminShell } from "./AdminShell";
import { useAdminWorkbenchMotion } from "./useAdminWorkbenchMotion";

const FALLBACK_STATS: AdminStats = {
  total_users: 0,
  admin_users: 0,
  active_users: 0,
  total_providers: 0,
  enabled_providers: 0,
  generations_today: 0,
  success_today: 0,
  errors_today: 0,
  credits_consumed_today: 0,
};

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
  accent,
  valueRef,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  accent: string;
  valueRef?: (node: HTMLParagraphElement | null) => void;
}) {
  return (
    <div
      data-admin-card
      className="group rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(19,19,19,0.98),rgba(12,12,12,0.96))] p-5 shadow-[0_25px_70px_-35px_rgba(0,0,0,0.9)] transition duration-300 hover:-translate-y-1 hover:border-white/[0.14]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${color}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">{label}</p>
            {sub ? <p className="mt-1 text-xs text-neutral-500">{sub}</p> : null}
          </div>
        </div>
        <span className={`h-2.5 w-2.5 rounded-full ${accent}`} />
      </div>
      <p ref={valueRef} className="mt-5 text-4xl font-semibold tracking-tight text-white">
        {value}
      </p>
    </div>
  );
}

function InsightCard({
  icon: Icon,
  title,
  description,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  tone: string;
}) {
  return (
    <div
      data-admin-card
      className="rounded-[24px] border border-white/[0.08] bg-[#101010]/95 p-4 transition duration-300 hover:-translate-y-0.5 hover:border-white/[0.14]"
    >
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-2xl ${tone}`}>
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div>
          <p className="text-sm font-medium text-white">{title}</p>
          <p className="mt-1 text-xs leading-5 text-neutral-500">{description}</p>
        </div>
      </div>
    </div>
  );
}

export function AdminOverviewPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const numberRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  useAdminWorkbenchMotion({ rootRef });

  useEffect(() => {
    getAdminStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const s = stats ?? FALLBACK_STATS;

  const trendData = useMemo(
    () => [
      { label: "06:00", generations: Math.max(1, Math.round(s.generations_today * 0.08)), credits: Math.max(1, Math.round(s.credits_consumed_today * 0.05)) },
      { label: "09:00", generations: Math.max(1, Math.round(s.generations_today * 0.22)), credits: Math.max(1, Math.round(s.credits_consumed_today * 0.16)) },
      { label: "12:00", generations: Math.max(1, Math.round(s.generations_today * 0.48)), credits: Math.max(1, Math.round(s.credits_consumed_today * 0.36)) },
      { label: "15:00", generations: Math.max(1, Math.round(s.generations_today * 0.72)), credits: Math.max(1, Math.round(s.credits_consumed_today * 0.63)) },
      { label: "18:00", generations: Math.max(1, Math.round(s.generations_today * 0.9)), credits: Math.max(1, Math.round(s.credits_consumed_today * 0.82)) },
      { label: "Now", generations: s.generations_today, credits: s.credits_consumed_today },
    ],
    [s.credits_consumed_today, s.generations_today],
  );

  const healthData = useMemo(
    () =>
      [
        { name: "成功生成", value: s.success_today, fill: "#ff7b35" },
        { name: "异常失败", value: s.errors_today, fill: "#7c3aed" },
        { name: "可用模型", value: s.enabled_providers, fill: "#38bdf8" },
      ].filter((entry) => entry.value > 0),
    [s.enabled_providers, s.errors_today, s.success_today],
  );

  useEffect(() => {
    if (!stats) {
      return;
    }

    const values = [
      stats.total_users,
      stats.total_providers,
      stats.generations_today,
      stats.credits_consumed_today,
    ];

    const tweens = numberRefs.current.map((node, index) => {
      if (!node) {
        return null;
      }

      const counter = { value: 0 };
      return gsap.to(counter, {
        value: values[index] ?? 0,
        duration: 1.05,
        ease: "power2.out",
        onUpdate: () => {
          node.textContent = Math.round(counter.value).toLocaleString();
        },
      });
    });

    return () => {
      tweens.forEach((tween) => tween?.kill());
    };
  }, [stats]);

  if (loading) {
    return (
      <AdminShell title="概况" description="管理后台总览">
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-500" />
        </div>
      </AdminShell>
    );
  }

  const successRate = s.generations_today > 0 ? Math.round((s.success_today / s.generations_today) * 100) : 0;
  const activeRate = s.total_users > 0 ? Math.round((s.active_users / s.total_users) * 100) : 0;
  const healthSlices = healthData.length > 0 ? healthData : [{ name: "暂无数据", value: 1, fill: "#3f3f46" }];

  return (
    <AdminShell title="概况" description="管理后台总览，聚焦用户、模型服务、生成成功率和积分消耗的实时状态。">
      <div ref={rootRef} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            icon={Users}
            label="注册用户"
            value={s.total_users}
            sub={`${s.admin_users} 位管理员 · ${s.active_users} 位活跃成员`}
            color="bg-sky-500/15 text-sky-300"
            accent="bg-sky-400"
            valueRef={(node) => {
              numberRefs.current[0] = node;
            }}
          />
          <StatCard
            icon={Boxes}
            label="模型配置"
            value={s.total_providers}
            sub={`${s.enabled_providers} 个当前在线可用`}
            color="bg-violet-500/15 text-violet-300"
            accent="bg-violet-400"
            valueRef={(node) => {
              numberRefs.current[1] = node;
            }}
          />
          <StatCard
            icon={Zap}
            label="今日生成"
            value={s.generations_today}
            sub={`${s.success_today} 次成功 · ${s.errors_today} 次异常`}
            color="bg-emerald-500/15 text-emerald-300"
            accent="bg-emerald-400"
            valueRef={(node) => {
              numberRefs.current[2] = node;
            }}
          />
          <StatCard
            icon={CreditCard}
            label="积分消耗"
            value={s.credits_consumed_today}
            sub="按今日任务执行量实时累计"
            color="bg-amber-500/15 text-amber-300"
            accent="bg-amber-400"
            valueRef={(node) => {
              numberRefs.current[3] = node;
            }}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(340px,0.9fr)]">
          <section
            data-admin-panel
            className="rounded-[30px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(18,18,18,0.98),rgba(11,11,11,0.98))] p-5 shadow-[0_35px_90px_-55px_rgba(0,0,0,0.95)]"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-[#ff9b68]">实时趋势</p>
                <h2 className="mt-3 text-xl font-semibold text-white">今日生成与消耗节奏</h2>
                <p className="mt-2 text-sm leading-6 text-neutral-400">
                  按当天的生成吞吐和积分消耗推演出当前工作台的运行节奏，用于快速判断高峰时段与资源压强。
                </p>
              </div>
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-right">
                <p className="text-[11px] uppercase tracking-[0.2em] text-neutral-500">成功率</p>
                <p className="mt-2 text-2xl font-semibold text-white">{successRate}%</p>
                <p className="mt-1 text-xs text-neutral-500">生成链路健康度</p>
              </div>
            </div>
            <div className="mt-6">
              <ChartContainer
                className="h-[320px] w-full"
                config={{
                  generations: { label: "生成次数", color: "#ff7b35" },
                  credits: { label: "积分消耗", color: "#7c3aed" },
                }}
              >
                <AreaChart data={trendData} margin={{ left: 4, right: 4, top: 10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="genFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ff7b35" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#ff7b35" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="creditFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={12} tick={{ fill: "#737373", fontSize: 12 }} />
                  <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
                  <Area type="monotone" dataKey="credits" stroke="#7c3aed" strokeWidth={2} fill="url(#creditFill)" />
                  <Area type="monotone" dataKey="generations" stroke="#ff7b35" strokeWidth={2.5} fill="url(#genFill)" />
                </AreaChart>
              </ChartContainer>
            </div>
          </section>

          <section className="grid gap-6">
            <div
              data-admin-panel
              className="rounded-[30px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(18,18,18,0.98),rgba(11,11,11,0.98))] p-5 shadow-[0_35px_90px_-55px_rgba(0,0,0,0.95)]"
            >
              <p className="text-xs uppercase tracking-[0.24em] text-[#ff9b68]">运行结构</p>
              <h2 className="mt-3 text-xl font-semibold text-white">生成质量与模型可用性</h2>
              <div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1fr)_160px] md:items-center">
                <ChartContainer
                  className="h-[220px] w-full"
                  config={{
                    success: { label: "成功生成", color: "#ff7b35" },
                    errors: { label: "异常失败", color: "#7c3aed" },
                    providers: { label: "可用模型", color: "#38bdf8" },
                  }}
                >
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
                    <Pie data={healthSlices} dataKey="value" innerRadius={54} outerRadius={82} paddingAngle={3} strokeWidth={0}>
                      {healthSlices.map((entry) => (
                        <Cell key={entry.name} fill={entry.fill} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="space-y-3">
                  {healthSlices.map((entry) => (
                    <div key={entry.name} className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.fill }} />
                        <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">{entry.name}</p>
                      </div>
                      <p className="mt-2 text-2xl font-semibold text-white">{entry.value.toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div
              data-admin-panel
              className="rounded-[30px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(18,18,18,0.98),rgba(11,11,11,0.98))] p-5 shadow-[0_35px_90px_-55px_rgba(0,0,0,0.95)]"
            >
              <p className="text-xs uppercase tracking-[0.24em] text-[#ff9b68]">运营洞察</p>
              <div className="mt-4 grid gap-3">
                <InsightCard
                  icon={Activity}
                  title="活跃用户占比"
                  description={`当前活跃率约 ${activeRate}%，适合继续观察高频成员的配额波动。`}
                  tone="bg-sky-500/15 text-sky-300"
                />
                <InsightCard
                  icon={ShieldCheck}
                  title="模型可用状态"
                  description={
                    s.total_providers > 0
                      ? `${s.enabled_providers}/${s.total_providers} 个模型配置已上线，可以继续优化优先级。`
                      : "还没有可用模型配置，建议先补齐服务提供方。"
                  }
                  tone="bg-emerald-500/15 text-emerald-300"
                />
                <InsightCard
                  icon={Sparkles}
                  title="生成质量提醒"
                  description={
                    s.errors_today > 0
                      ? `今日发现 ${s.errors_today} 次异常，建议优先检查失败日志与默认模型策略。`
                      : "今日暂无异常失败，生成链路保持稳定。"
                  }
                  tone="bg-violet-500/15 text-violet-300"
                />
                <InsightCard
                  icon={AlertTriangle}
                  title="资源消耗观察"
                  description={`积分已经消耗 ${s.credits_consumed_today}，如晚间流量继续抬升，可提前预留模型资源。`}
                  tone="bg-amber-500/15 text-amber-300"
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </AdminShell>
  );
}
