import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { CheckCircle2, Clock3, Loader2, RefreshCw, Search, XCircle } from "lucide-react";

import { type AdminAuditLog, listAdminAuditLogs } from "../../api/admin";
import { toAdminErrorSummary } from "../../api/errors";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const PAGE_SIZE = 50;

function formatDateTime(value: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function AuditStatus({ entry }: { entry: AdminAuditLog }) {
  if (entry.status === "success") {
    return <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />成功</span>;
  }
  if (entry.status === "started") {
    return <span className="inline-flex items-center gap-1 text-amber-300"><Clock3 className="h-3.5 w-3.5 animate-pulse" />进行中</span>;
  }
  return <span className="inline-flex items-center gap-1 text-red-400"><XCircle className="h-3.5 w-3.5" />失败</span>;
}

export function AdminAuditLogsPanel() {
  const [entries, setEntries] = useState<AdminAuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [actor, setActor] = useState("");
  const [requestId, setRequestId] = useState("");
  const [status, setStatus] = useState<"" | AdminAuditLog["status"]>("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const deferredActor = useDeferredValue(actor);
  const deferredRequestID = useDeferredValue(requestId);

  const load = useCallback(async (offset = 0) => {
    if (offset === 0) setLoading(true); else setLoadingMore(true);
    setError("");
    try {
      const result = await listAdminAuditLogs(PAGE_SIZE, offset, {
        actor: deferredActor,
        requestId: deferredRequestID,
        status,
      });
      setEntries((current) => offset === 0 ? result.data : [...current, ...result.data]);
      setTotal(result.total);
    } catch (loadError) {
      setError(toAdminErrorSummary(loadError, "zh"));
    } finally {
      if (offset === 0) setLoading(false); else setLoadingMore(false);
    }
  }, [deferredActor, deferredRequestID, status]);

  useEffect(() => { void load(0); }, [load]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="space-y-2">
          <span className="text-xs font-medium text-neutral-400">执行状态</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as "" | AdminAuditLog["status"])} className="h-10 w-full rounded-xl border border-white/10 bg-[#141414] px-3 text-sm text-neutral-100 outline-none">
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="error">失败</option>
            <option value="started">进行中</option>
          </select>
        </label>
        <label className="space-y-2">
          <span className="text-xs font-medium text-neutral-400">操作者</span>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" /><Input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="姓名或邮箱" className="h-10 border-white/10 bg-[#141414] pl-9" /></div>
        </label>
        <label className="space-y-2">
          <span className="text-xs font-medium text-neutral-400">请求编号</span>
          <Input value={requestId} onChange={(event) => setRequestId(event.target.value)} placeholder="req_xxx" className="h-10 border-white/10 bg-[#141414]" />
        </label>
        <div className="flex items-end"><Button variant="outline" size="sm" onClick={() => void load(0)} disabled={loading} className="h-10 gap-1.5 border-white/10 text-neutral-300"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />刷新</Button></div>
      </div>

      <div data-admin-panel className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3"><div><p className="text-sm font-medium text-white">操作审计</p><p className="mt-1 text-xs text-neutral-500">仅记录管理端写操作；不保存密码、令牌、请求正文或原始供应商报错。</p></div><Badge className="border-white/10 bg-white/[0.05] text-neutral-300">{total} 条</Badge></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead><tr className="border-b border-white/[0.06] bg-white/[0.02] text-left text-xs text-neutral-500"><th className="px-4 py-3">时间</th><th className="px-4 py-3">操作者</th><th className="px-4 py-3">操作</th><th className="px-4 py-3">目标</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">请求编号</th><th className="px-4 py-3">耗时</th></tr></thead><tbody className="divide-y divide-white/[0.04]">
          {loading ? <tr><td colSpan={7} className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr> : null}
          {!loading && error ? <tr><td colSpan={7} className="px-4 py-16 text-center text-red-300">{error}</td></tr> : null}
          {!loading && !error && entries.length === 0 ? <tr><td colSpan={7} className="px-4 py-16 text-center text-neutral-500">暂无操作审计记录。</td></tr> : null}
          {!loading && !error ? entries.map((entry) => <tr key={entry.id} className="hover:bg-white/[0.02]"><td className="px-4 py-3 text-xs text-neutral-400">{formatDateTime(entry.created_at)}</td><td className="px-4 py-3"><div className="text-neutral-200">{entry.actor_name || "已删除用户"}</div><div className="text-[11px] text-neutral-500">{entry.actor_email}</div></td><td className="px-4 py-3 font-mono text-xs text-neutral-300">{entry.action}</td><td className="px-4 py-3 text-xs text-neutral-300">{entry.target_type}{entry.target_id ? ` · ${entry.target_id.slice(0, 12)}` : ""}</td><td className="px-4 py-3 text-xs"><AuditStatus entry={entry} />{entry.error_code ? <div className="mt-1 font-mono text-[10px] text-red-300">{entry.error_code}</div> : null}</td><td className="px-4 py-3 font-mono text-[11px] text-neutral-400">{entry.request_id || "—"}</td><td className="px-4 py-3 text-xs text-neutral-400">{entry.duration_ms ? `${entry.duration_ms} ms` : "—"}</td></tr>) : null}
        </tbody></table></div>
        {!loading && !error && entries.length < total ? <div className="border-t border-white/[0.04] px-4 py-3 text-right"><Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void load(entries.length)} className="border-white/10 text-neutral-300">{loadingMore ? "加载中…" : "加载更多"}</Button></div> : null}
      </div>
    </div>
  );
}
