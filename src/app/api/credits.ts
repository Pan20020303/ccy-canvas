import { apiClient } from "./client";

// ─── 用户侧积分明细(我的积分流水)────────────────────────────────────────
// 顶栏积分胶囊点开:看每笔积分的增减(重置/扣费/退款/管理员调整)与操作后余额。

export type CreditLedgerType =
  | "daily_reset"
  | "reserve"
  | "charge"
  | "refund"
  | "admin_adjustment";

export type CreditLedgerEntry = {
  id: string;
  type: CreditLedgerType;
  amount: number;
  balance_after: number;
  reason: string;
  created_at: string;
};

/** 本人积分流水(分页,倒序)。返回满 limit 条时可能还有更多(继续加 offset)。 */
export function listMyCreditLedger(limit = 50, offset = 0): Promise<CreditLedgerEntry[]> {
  return apiClient.get<CreditLedgerEntry[]>(`/api/app/credits/ledger?limit=${limit}&offset=${offset}`);
}
