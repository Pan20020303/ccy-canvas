import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";

import { listMyCreditLedger, type CreditLedgerEntry, type CreditLedgerType } from "../api/credits";

// ─── 我的积分明细弹窗 ─────────────────────────────────────────────────────
// 顶栏积分胶囊点开:看每笔积分怎么来怎么去,扣费透明化(付费信任的前提)。

const PAGE = 50;

const TYPE_LABEL: Record<CreditLedgerType, { zh: string; en: string; tone: string }> = {
  daily_reset:      { zh: "每日重置", en: "Daily reset",   tone: "text-cyan-300" },
  reserve:          { zh: "生成扣费", en: "Generation",    tone: "text-amber-300" },
  charge:           { zh: "扣费",     en: "Charge",        tone: "text-amber-300" },
  refund:           { zh: "退款",     en: "Refund",        tone: "text-emerald-300" },
  admin_adjustment: { zh: "管理员调整", en: "Admin adjust", tone: "text-violet-300" },
};

type Props = { open: boolean; onClose: () => void; language: "zh" | "en" };

export function CreditLedgerModal({ open, onClose, language }: Props) {
  const zh = language === "zh";
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const page = await listMyCreditLedger(PAGE, offset);
      setEntries((prev) => (offset === 0 ? page : [...prev, ...page]));
      setHasMore(page.length === PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setEntries([]);
      void loadPage(0);
    }
  }, [open, loadPage]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={onClose}
      data-testid="credit-ledger-modal"
    >
      <div
        className="relative flex h-[70vh] w-[40vw] min-w-[480px] max-w-[680px] flex-col rounded-2xl border border-white/10 bg-[#1a1d22]/98 px-5 py-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-3 text-sm font-medium text-neutral-200">{zh ? "我的积分明细" : "My credit ledger"}</div>
        {error ? (
          <div className="mb-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 text-[12px] text-rose-300">{error}</div>
        ) : null}
        <div className="prompt-editor-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          {entries.length === 0 && loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              {zh ? "加载中…" : "Loading…"}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[13px] text-neutral-500">
              {zh ? "暂无积分记录" : "No credit entries yet"}
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-[#1a1d22] text-[11px] text-neutral-500">
                <tr className="text-left">
                  <th className="py-1.5 font-normal">{zh ? "时间" : "Time"}</th>
                  <th className="py-1.5 font-normal">{zh ? "类型" : "Type"}</th>
                  <th className="py-1.5 text-right font-normal">{zh ? "变动" : "Δ"}</th>
                  <th className="py-1.5 text-right font-normal">{zh ? "余额" : "Balance"}</th>
                  <th className="py-1.5 pl-3 font-normal">{zh ? "说明" : "Reason"}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const meta = TYPE_LABEL[e.type] ?? { zh: e.type, en: e.type, tone: "text-neutral-300" };
                  // reserve/charge 是扣减(展示为负),其余为增加。
                  const isDebit = e.type === "reserve" || e.type === "charge";
                  const sign = isDebit ? "−" : "+";
                  return (
                    <tr key={e.id} className="border-t border-white/[0.05] text-neutral-300">
                      <td className="py-1.5 text-neutral-500 tabular-nums">{new Date(e.created_at).toLocaleString(zh ? "zh-CN" : undefined)}</td>
                      <td className={`py-1.5 ${meta.tone}`}>{zh ? meta.zh : meta.en}</td>
                      <td className={`py-1.5 text-right tabular-nums ${isDebit ? "text-neutral-400" : "text-emerald-300"}`}>{sign}{Math.abs(e.amount)}</td>
                      <td className="py-1.5 text-right tabular-nums text-neutral-400">{e.balance_after}</td>
                      <td className="max-w-[220px] truncate py-1.5 pl-3 text-neutral-500" title={e.reason}>{e.reason || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {hasMore ? (
          <button
            type="button"
            onClick={() => void loadPage(entries.length)}
            disabled={loading}
            className="mt-2 flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] py-1.5 text-[12px] text-neutral-300 transition hover:bg-white/[0.06] disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {zh ? "加载更多" : "Load more"}
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
