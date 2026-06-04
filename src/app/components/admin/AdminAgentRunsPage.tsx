import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, CheckCircle2, XCircle, Clock, Bot } from "lucide-react";

import { adminListAgentRuns, type AgentRun } from "../../api/skills";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AdminShell } from "./AdminShell";

const STATUS_LABELS: Record<AgentRun["status"], string> = {
  pending: "运行中", success: "成功", error: "失败", cancelled: "已取消",
};

function StatusCell({ run }: { run: AgentRun }) {
  if (run.status === "success") return <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> {STATUS_LABELS.success}</span>;
  if (run.status === "pending") return <span className="inline-flex items-center gap-1.5 text-xs text-amber-300"><Clock className="h-3.5 w-3.5 animate-pulse" /> {STATUS_LABELS.pending}</span>;
  return <span className="inline-flex items-center gap-1.5 text-xs text-rose-400" title={run.error_msg}><XCircle className="h-3.5 w-3.5" /> {STATUS_LABELS[run.status]}</span>;
}

export function AdminAgentRunsPage() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRuns(await adminListAgentRuns(200, 0)); } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <AdminShell
      title="智能体调用记录"
      description="查看所有智能体的运行历史：用户、目标、调用工具次数、最终回复和耗时。"
      action={<Button variant="outline" size="sm" onClick={load} className="border-white/10 text-neutral-300 hover:bg-white/5 gap-1.5">
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
      </Button>}
    >
      <div data-admin-panel className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              {["用户", "智能体", "目标", "状态", "工具调用", "步数", "耗时", "时间"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {loading ? (
              <tr><td colSpan={8} className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
            ) : runs.length === 0 ? (
              <tr><td colSpan={8} className="py-16 text-center text-sm text-neutral-600">暂无记录</td></tr>
            ) : runs.map((r) => (
              <tr key={r.id} className="hover:bg-white/[0.02] transition">
                <td className="px-4 py-3">
                  <div className="flex flex-col">
                    <span className="text-sm text-neutral-200">{r.user_name || "—"}</span>
                    <span className="text-[10px] text-neutral-500">{r.user_email || r.user_id.slice(0, 8)}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
                    <Bot className="h-3.5 w-3.5 text-cyan-300" />{r.agent_name || "—"}
                  </span>
                </td>
                <td className="px-4 py-3 max-w-[300px] truncate text-xs text-neutral-300" title={r.user_input}>{r.user_input}</td>
                <td className="px-4 py-3"><StatusCell run={r} /></td>
                <td className="px-4 py-3 text-xs text-neutral-400 tabular-nums">{r.tool_calls}</td>
                <td className="px-4 py-3 text-xs text-neutral-400 tabular-nums">{r.steps}</td>
                <td className="px-4 py-3 text-xs text-neutral-500">{r.duration_ms > 0 ? `${(r.duration_ms / 1000).toFixed(1)} s` : "—"}</td>
                <td className="px-4 py-3 text-xs text-neutral-500">{new Date(r.created_at).toLocaleString("zh-CN")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && runs.length > 0 ? (
          <div className="border-t border-white/[0.04] bg-white/[0.01] px-4 py-3 text-xs text-neutral-600">共 {runs.length} 条</div>
        ) : null}
      </div>
      {/* unused */}
      <Badge className="hidden" />
    </AdminShell>
  );
}
