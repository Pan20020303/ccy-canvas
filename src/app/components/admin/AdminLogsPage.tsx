import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, CheckCircle2, XCircle } from "lucide-react";

import type { GenerationLog } from "../../api/admin";
import { listLogs } from "../../api/admin";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AdminShell } from "./AdminShell";

const SERVICE_LABELS: Record<string, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
};

export function AdminLogsPage() {
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setLogs(await listLogs(100, 0)); } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <AdminShell
      title="生成日志"
      description="查看所有用户的生成记录，包括耗时、状态和错误信息。"
      action={
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="border-white/10 text-neutral-300 hover:bg-white/5 gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      }
    >
      <div className="overflow-hidden rounded-2xl border border-white/[0.08]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              {["类型", "模型", "提示词", "状态", "耗时", "时间"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {loading ? (
              <tr><td colSpan={6} className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={6} className="py-16 text-center text-sm text-neutral-600">暂无日志</td></tr>
            ) : logs.map((log) => (
              <tr key={log.id} className="group hover:bg-white/[0.02] transition">
                <td className="px-4 py-3">
                  <Badge className="bg-white/[0.06] text-neutral-300 border-white/10">
                    {SERVICE_LABELS[log.service_type] ?? log.service_type}
                  </Badge>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-400">{log.model}</td>
                <td className="px-4 py-3 max-w-[250px] truncate text-neutral-300" title={log.prompt}>{log.prompt}</td>
                <td className="px-4 py-3">
                  {log.status === "success" ? (
                    <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> 成功</span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-red-400" title={log.error_msg}><XCircle className="h-3.5 w-3.5" /> 失败</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-neutral-500">
                  {log.duration_ms > 0 ? `${(log.duration_ms / 1000).toFixed(1)}s` : "—"}
                </td>
                <td className="px-4 py-3 text-xs text-neutral-500">
                  {new Date(log.created_at).toLocaleString("zh-CN")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && logs.length > 0 && (
          <div className="border-t border-white/[0.04] bg-white/[0.01] px-4 py-3 text-xs text-neutral-600">
            共 {logs.length} 条
          </div>
        )}
      </div>
    </AdminShell>
  );
}
