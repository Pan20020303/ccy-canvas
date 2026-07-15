import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2, RefreshCw, Search } from "lucide-react";

import { listCreditLedger, type CreditLedgerEntry } from "../../api/admin";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminShell } from "./AdminShell";

const PAGE_SIZE = 100;
const CLIENT_PAGE_SIZE = 20;

const TYPE_LABELS: Record<string, string> = {
  reserve: "扣费（预留）",
  refund: "退款",
  charge: "结算",
  admin_adjustment: "管理员调整",
  daily_reset: "每日重置",
};

const TYPE_STYLES: Record<string, string> = {
  reserve: "text-red-400",
  refund: "text-emerald-400",
  charge: "text-red-300",
  admin_adjustment: "text-amber-300",
  daily_reset: "text-sky-300",
};

function formatDateTime(value: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// reserve deducts, refund returns — show the sign so it reads like a ledger.
function signedAmount(entry: CreditLedgerEntry): string {
  const negative = entry.type === "reserve" || entry.type === "charge";
  return `${negative ? "-" : "+"}${entry.amount}`;
}

export function AdminCreditLedgerPage() {
  const [rows, setRows] = useState<CreditLedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(async (offset = 0) => {
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    setError("");
    try {
      const res = await listCreditLedger(PAGE_SIZE, offset, { user: userFilter, type: typeFilter });
      setRows((cur) => (offset === 0 ? res.data : [...cur, ...res.data]));
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载积分流水失败");
    } finally {
      if (offset === 0) setLoading(false);
      else setLoadingMore(false);
    }
  }, [userFilter, typeFilter]);

  useEffect(() => { void load(0); }, [load]);

  // Reset the client pager whenever any filter/search state changes.
  useEffect(() => { setPage(0); }, [userFilter, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(rows.length / CLIENT_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedRows = useMemo(
    () => rows.slice(currentPage * CLIENT_PAGE_SIZE, (currentPage + 1) * CLIENT_PAGE_SIZE),
    [rows, currentPage],
  );

  const summary = useMemo(() => {
    let spent = 0;
    let refunded = 0;
    for (const r of rows) {
      if (r.type === "reserve" || r.type === "charge") spent += r.amount;
      else if (r.type === "refund") refunded += r.amount;
    }
    return { spent, refunded };
  }, [rows]);

  return (
    <AdminShell
      title="积分流水"
      description="按调用扣费的完整审计：谁、什么类型（扣费 / 退款 / 调整）、扣了多少积分、扣后余额、原因和时间。"
      action={
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}
          className="gap-1.5 border-white/10 text-neutral-300 hover:bg-white/5">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-3">
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">流水条数</p>
            <p className="mt-2 text-3xl font-semibold text-white">{total}</p>
          </div>
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">本页扣费</p>
            <p className="mt-2 text-3xl font-semibold text-red-400">-{summary.spent}</p>
          </div>
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">本页退款</p>
            <p className="mt-2 text-3xl font-semibold text-emerald-400">+{summary.refunded}</p>
          </div>
        </div>

        <div data-admin-card className="grid gap-3 rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4 md:grid-cols-[minmax(0,1fr)_220px]">
          <label className="space-y-2">
            <span className="text-xs font-medium text-neutral-400">用户关键词</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <Input value={userFilter} onChange={(e) => setUserFilter(e.target.value)} placeholder="搜索用户名或邮箱"
                className="h-10 rounded-xl border-white/10 bg-[#141414] pl-9 text-neutral-100 placeholder:text-neutral-500" />
            </div>
          </label>
          <label className="space-y-2">
            <span className="text-xs font-medium text-neutral-400">类型</span>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
              className="h-10 w-full rounded-xl border border-white/10 bg-[#141414] px-3 text-sm text-neutral-100 outline-none transition focus:border-cyan-300/50">
              <option value="">全部类型</option>
              <option value="reserve">扣费（预留）</option>
              <option value="refund">退款</option>
              <option value="charge">结算</option>
              <option value="admin_adjustment">管理员调整</option>
              <option value="daily_reset">每日重置</option>
            </select>
          </label>
        </div>

        <div data-admin-panel className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.02] text-left text-xs font-medium uppercase tracking-wider text-neutral-500">
                  <th className="px-4 py-3">用户</th>
                  <th className="px-4 py-3">类型</th>
                  <th className="px-4 py-3 text-right">积分</th>
                  <th className="px-4 py-3 text-right">扣后余额</th>
                  <th className="px-4 py-3">原因</th>
                  <th className="px-4 py-3">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {loading ? (
                  <tr><td colSpan={6} className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                ) : error ? (
                  <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-red-300">{error}</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-neutral-500">暂无积分流水。</td></tr>
                ) : (
                  pagedRows.map((r) => (
                    <tr key={r.id} className="transition hover:bg-white/[0.02]">
                      <td className="px-4 py-3">
                        <div className="flex flex-col">
                          <span className="text-sm text-neutral-200">{r.user_name || r.user_email || r.user_id.slice(0, 8)}</span>
                          <span className="text-[11px] text-neutral-500">{r.user_email}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className="border-white/10 bg-white/[0.05] text-neutral-300">{TYPE_LABELS[r.type] ?? r.type}</Badge>
                      </td>
                      <td className={`px-4 py-3 text-right font-mono tabular-nums ${TYPE_STYLES[r.type] ?? "text-neutral-300"}`}>{signedAmount(r)}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-neutral-300">{r.balance_after}</td>
                      <td className="max-w-[340px] px-4 py-3 text-neutral-400"><span className="block truncate" title={r.reason}>{r.reason || "—"}</span></td>
                      <td className="px-4 py-3 text-xs text-neutral-400">{formatDateTime(r.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {!loading && !error && pageCount > 1 ? (
            <div className="flex items-center justify-center gap-1 border-t border-white/[0.04] bg-white/[0.01] px-4 py-2">
              <button type="button" onClick={() => setPage(0)} disabled={currentPage === 0}
                className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition hover:bg-white/8 disabled:opacity-30 disabled:hover:bg-transparent">
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={currentPage === 0}
                className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition hover:bg-white/8 disabled:opacity-30 disabled:hover:bg-transparent">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-2 text-[11px] tabular-nums text-neutral-400">{currentPage + 1} / {pageCount}</span>
              <button type="button" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={currentPage >= pageCount - 1}
                className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition hover:bg-white/8 disabled:opacity-30 disabled:hover:bg-transparent">
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setPage(pageCount - 1)} disabled={currentPage >= pageCount - 1}
                className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition hover:bg-white/8 disabled:opacity-30 disabled:hover:bg-transparent">
                <ChevronsRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          {!loading && !error && rows.length > 0 && rows.length < total ? (
            <div className="border-t border-white/[0.04] bg-white/[0.01] px-4 py-3 text-xs text-neutral-500">
              <div className="flex items-center justify-between gap-3">
                <span>当前加载 {rows.length} / {total} 条。</span>
                <Button variant="outline" size="sm" onClick={() => void load(rows.length)} disabled={loadingMore}
                  className="h-8 border-white/10 text-neutral-300 hover:bg-white/5">
                  {loadingMore ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}加载更多
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </AdminShell>
  );
}
