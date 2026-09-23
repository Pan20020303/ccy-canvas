import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Coins, Loader2, RotateCcw, Settings, Users, Wallet, X, Zap } from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';

import {
  listProjectCreditLedger,
  refundProjectCredits,
  setProjectMemberCreditQuota,
  transferProjectCredits,
  type ProjectCreditLedgerEntry,
  type ProjectCreditMember,
  type ProjectCreditSummary,
} from '../api/projects';
import { collabRoleLabel } from '../store';

type CreditDialog =
  | { kind: 'transfer' }
  | { kind: 'refund' }
  | { kind: 'quota'; member: ProjectCreditMember };

export function ProjectCreditsModal({
  zh,
  projectId,
  summary,
  loading,
  onSummaryChange,
  onRefreshPersonal,
  onClose,
}: {
  zh: boolean;
  projectId: string;
  summary: ProjectCreditSummary | null;
  loading: boolean;
  onSummaryChange: (summary: ProjectCreditSummary) => void;
  onRefreshPersonal: () => void;
  onClose: () => void;
}) {
  const [dialog, setDialog] = useState<CreditDialog | null>(null);
  const usedPercent = summary && summary.total_funded > 0
    ? Math.min(100, Math.round((summary.total_consumed / summary.total_funded) * 100))
    : 0;

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[88vh] w-[960px] max-w-[94vw] flex-col rounded-2xl border border-white/10 bg-[#17191e] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h3 className="text-[15px] font-semibold text-white">{zh ? '项目积分' : 'Project points'}</h3>
            <p className="mt-0.5 text-xs text-neutral-500">
              {summary?.can_manage
                ? (zh ? '管理项目积分与成员额度' : 'Manage project points and member quotas')
                : (zh ? '协作生成统一从项目积分扣除' : 'Collaborative generations use project points')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {summary?.can_transfer ? (
              <>
                <button onClick={() => setDialog({ kind: 'refund' })} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-neutral-200 hover:bg-white/[0.08]">
                  <RotateCcw className="h-3.5 w-3.5" />{zh ? '退回个人' : 'Return'}
                </button>
                <button onClick={() => setDialog({ kind: 'transfer' })} className="flex items-center gap-1.5 rounded-lg bg-[#ff6a1f] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#ff7b38]">
                  <Wallet className="h-3.5 w-3.5" />{zh ? '划转到项目' : 'Fund project'}
                </button>
              </>
            ) : null}
            <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400 hover:bg-white/12 hover:text-white"><X className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
          {loading && !summary ? (
            <div className="flex h-52 items-center justify-center gap-2 text-sm text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" />{zh ? '正在读取项目积分' : 'Loading project points'}</div>
          ) : summary ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
                  <div className="flex items-center justify-between text-xs text-neutral-400"><span>{zh ? '项目积分余额' : 'Project balance'}</span><span>{zh ? '已用' : 'Used'} {usedPercent}%</span></div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <div><span className="text-2xl font-semibold text-neutral-100">{summary.current_balance}</span><span className="ml-1.5 text-[11px] text-neutral-500">{zh ? '剩余' : 'left'}</span></div>
                    <span className="text-[11px] text-neutral-500">{zh ? '累计划入' : 'funded'} {summary.total_funded}</span>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
                  <div className="text-xs text-neutral-400">{zh ? '累计消耗' : 'Total consumed'}</div>
                  <div className="mt-2 text-2xl font-semibold text-neutral-100">{summary.total_consumed}</div>
                  <div className="mt-1 text-[11px] text-neutral-500">{zh ? '所有成员的项目内生成消耗' : 'All member usage in this project'}</div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-neutral-200">
                  <Users className="h-4 w-4 text-neutral-400" />
                  {zh ? '成员使用额度' : 'Member quotas'}
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-white/10 px-1 text-[10px] text-neutral-300">{summary.members.length}</span>
                </div>
                <div className="space-y-1.5">
                  {summary.members.map((member) => (
                    <div key={member.uid} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-500/15 text-xs font-semibold text-cyan-200">{member.name.trim().slice(0, 1).toUpperCase()}</div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-neutral-100">{member.name}</div>
                        <div className="mt-0.5 text-[10.5px] text-neutral-500">{collabRoleLabel(member.role, zh)}</div>
                      </div>
                      <span className="text-xs text-neutral-400">{member.quota === null ? (zh ? '不限额' : 'Unlimited') : `${zh ? '额度' : 'Quota'} ${member.quota}`}</span>
                      <span className="rounded-md bg-[#ff6a1f]/15 px-2 py-0.5 text-[11px] text-[#ff9b68]">{zh ? `已用 ${member.used}` : `Used ${member.used}`}</span>
                      {summary.can_manage ? (
                        <button title={zh ? '设置成员额度' : 'Set quota'} onClick={() => setDialog({ kind: 'quota', member })} className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-white/8 hover:text-neutral-200"><Settings className="h-4 w-4" /></button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-52 flex-col items-center justify-center gap-2 text-neutral-500"><AlertCircle className="h-6 w-6" /><span className="text-sm">{zh ? '项目积分读取失败，请稍后重试' : 'Failed to load project points'}</span></div>
          )}
        </div>
      </div>

      {dialog && summary ? (
        <CreditActionDialog
          zh={zh}
          projectId={projectId}
          summary={summary}
          dialog={dialog}
          onCancel={() => setDialog(null)}
          onSuccess={(next) => {
            onSummaryChange(next);
            onRefreshPersonal();
            setDialog(null);
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}

function CreditActionDialog({ zh, projectId, summary, dialog, onCancel, onSuccess }: {
  zh: boolean;
  projectId: string;
  summary: ProjectCreditSummary;
  dialog: CreditDialog;
  onCancel: () => void;
  onSuccess: (summary: ProjectCreditSummary) => void;
}) {
  const [value, setValue] = useState(dialog.kind === 'quota' && dialog.member.quota !== null ? String(dialog.member.quota) : '');
  const [unlimited, setUnlimited] = useState(dialog.kind === 'quota' && dialog.member.quota === null);
  const [saving, setSaving] = useState(false);
  const title = dialog.kind === 'transfer'
    ? (zh ? '划转积分到项目' : 'Fund project')
    : dialog.kind === 'refund'
      ? (zh ? '退回个人积分' : 'Return project points')
      : (zh ? `设置 ${dialog.member.name} 的额度` : `Set ${dialog.member.name}'s quota`);

  const submit = async () => {
    const amount = Number(value);
    if (dialog.kind !== 'quota' && (!Number.isInteger(amount) || amount <= 0)) {
      toast.error(zh ? '请输入大于 0 的整数积分' : 'Enter a positive whole number');
      return;
    }
    if (dialog.kind === 'quota' && !unlimited && (!Number.isInteger(amount) || amount < 0)) {
      toast.error(zh ? '请输入不小于 0 的整数额度' : 'Enter a non-negative whole number');
      return;
    }
    setSaving(true);
    try {
      const next = dialog.kind === 'transfer'
        ? await transferProjectCredits(projectId, amount)
        : dialog.kind === 'refund'
          ? await refundProjectCredits(projectId, amount)
          : await setProjectMemberCreditQuota(projectId, dialog.member.uid, unlimited ? null : amount);
      toast.success(dialog.kind === 'quota' ? (zh ? '成员额度已更新' : 'Member quota updated') : (zh ? '项目积分已更新' : 'Project points updated'));
      onSuccess(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (zh ? '操作失败，请稍后重试' : 'Action failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 z-[230] flex items-center justify-center bg-black/65 p-6" onClick={(event) => { event.stopPropagation(); onCancel(); }}>
      <div className="w-[420px] max-w-full rounded-2xl border border-white/10 bg-[#1d2026] p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-white">{title}</h4>
          <button onClick={onCancel} className="rounded-lg p-1.5 text-neutral-500 hover:bg-white/8 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        {dialog.kind === 'transfer' ? <p className="mt-2 text-xs text-neutral-500">{zh ? `个人可划转余额：${summary.personal_balance}` : `Available personal balance: ${summary.personal_balance}`}</p> : null}
        {dialog.kind === 'refund' ? <p className="mt-2 text-xs text-neutral-500">{zh ? `本管理员可退回：${summary.my_contribution}，项目余额：${summary.current_balance}` : `Returnable: ${summary.my_contribution}; project balance: ${summary.current_balance}`}</p> : null}
        {dialog.kind === 'quota' ? (
          <label className="mt-4 flex items-center gap-2 text-xs text-neutral-300">
            <input type="checkbox" checked={unlimited} onChange={(event) => setUnlimited(event.target.checked)} className="accent-[#ff6a1f]" />
            {zh ? '不限额（仅受项目余额限制）' : 'Unlimited (project balance only)'}
          </label>
        ) : null}
        <input
          type="number"
          min={dialog.kind === 'quota' ? 0 : 1}
          step={1}
          disabled={dialog.kind === 'quota' && unlimited}
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
          placeholder={dialog.kind === 'quota' ? (zh ? '输入成员总额度' : 'Member quota') : (zh ? '输入积分数量' : 'Points')}
          className="mt-4 h-10 w-full rounded-xl border border-white/10 bg-black/25 px-3 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-[#ff6a1f]/70 disabled:cursor-not-allowed disabled:opacity-40"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} disabled={saving} className="rounded-lg px-4 py-2 text-xs text-neutral-400 hover:bg-white/5">{zh ? '取消' : 'Cancel'}</button>
          <button onClick={() => void submit()} disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-[#ff6a1f] px-4 py-2 text-xs font-medium text-white hover:bg-[#ff7b38] disabled:opacity-50">{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{zh ? '确认' : 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

export function ProjectCreditLogModal({ zh, projectId, onClose }: { zh: boolean; projectId: string; onClose: () => void }) {
  const [filter, setFilter] = useState<'all' | 'spend' | 'earn'>('all');
  const [entries, setEntries] = useState<ProjectCreditLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listProjectCreditLedger(projectId)
      .then((items) => { if (active) setEntries(items); })
      .catch(() => { if (active) toast.error(zh ? '积分记录读取失败' : 'Failed to load project ledger'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, zh]);

  const filters: { key: 'all' | 'spend' | 'earn'; zh: string; en: string }[] = [
    { key: 'all', zh: '全部', en: 'All' },
    { key: 'spend', zh: '消耗', en: 'Spent' },
    { key: 'earn', zh: '获得', en: 'Earned' },
  ];
  const filtered = entries.filter((entry) => filter === 'all'
    || (filter === 'spend'
      ? entry.type === 'reserve' || entry.type === 'refund_out'
      : entry.type === 'transfer_in' || entry.type === 'refund'));
  const labelFor = (entry: ProjectCreditLedgerEntry) => {
    if (entry.type === 'transfer_in') return zh ? '划转到项目' : 'Project funded';
    if (entry.type === 'refund_out') return zh ? '退回个人' : 'Returned';
    if (entry.type === 'reserve') return zh ? '生成消耗' : 'Generation';
    if (entry.type === 'refund') return zh ? '生成退款' : 'Generation refund';
    return zh ? '成员额度调整' : 'Quota updated';
  };

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-[76vh] w-[920px] max-w-[95vw] flex-col rounded-2xl border border-white/10 bg-[#17191e] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div><h3 className="text-[15px] font-semibold text-white">{zh ? '项目积分记录' : 'Project points ledger'}</h3><p className="mt-0.5 text-xs text-neutral-500">{zh ? '协作成员的生成消耗、退款和额度调整' : 'Collaborative usage, refunds and quota changes'}</p></div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400 hover:bg-white/12 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex items-center justify-end px-6 py-3">
          <div className="flex items-center gap-1 rounded-lg border border-white/8 bg-white/[0.03] p-0.5">
            {filters.map((item) => <button key={item.key} onClick={() => setFilter(item.key)} className={clsx('rounded-md px-3 py-1 text-xs', filter === item.key ? 'bg-white/12 text-white' : 'text-neutral-400 hover:text-neutral-200')}>{zh ? item.zh : item.en}</button>)}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" />{zh ? '读取中' : 'Loading'}</div>
          ) : filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-500"><Coins className="h-8 w-8" /><div className="text-sm">{zh ? '暂无积分记录' : 'No points records yet'}</div></div>
          ) : (
            <div className="space-y-1.5">
              {filtered.map((entry) => {
                const spend = entry.type === 'reserve' || entry.type === 'refund_out';
                const neutral = entry.type === 'quota_update';
                return (
                  <div key={entry.id} className="flex items-center gap-3 rounded-xl border border-white/7 bg-white/[0.02] px-4 py-3">
                    <div className={clsx('flex h-8 w-8 items-center justify-center rounded-full', spend ? 'bg-amber-500/10 text-amber-300' : neutral ? 'bg-neutral-500/10 text-neutral-400' : 'bg-emerald-500/10 text-emerald-300')}><Zap className="h-3.5 w-3.5" /></div>
                    <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="text-sm text-neutral-100">{labelFor(entry)}</span>{entry.user_name ? <span className="text-xs text-neutral-500">· {entry.user_name}</span> : null}</div><div className="mt-0.5 truncate text-[11px] text-neutral-600">{entry.reason || '—'}</div></div>
                    <div className="text-right"><div className={clsx('text-sm font-medium tabular-nums', spend ? 'text-amber-300' : neutral ? 'text-neutral-500' : 'text-emerald-300')}>{neutral ? '—' : `${spend ? '-' : '+'}${entry.amount}`}</div><div className="mt-0.5 text-[10.5px] text-neutral-600">{new Date(entry.created_at).toLocaleString(zh ? 'zh-CN' : 'en-US')}</div></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
