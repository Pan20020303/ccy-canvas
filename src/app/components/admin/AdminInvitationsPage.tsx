import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus, RefreshCw, XCircle } from "lucide-react";

import type { AdminInvitation, CreateInvitationPayload } from "../../api/admin";
import { listInvitations, revokeInvitation, createInvitation } from "../../api/admin";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminShell } from "./AdminShell";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-500/12 text-emerald-300 border-emerald-500/20",
  used: "bg-cyan-500/12 text-cyan-300 border-cyan-500/20",
  expired: "bg-neutral-500/12 text-neutral-400 border-neutral-500/20",
  revoked: "bg-red-500/12 text-red-300 border-red-500/20",
};

const STATUS_LABEL: Record<string, string> = {
  active: "有效",
  used: "已用完",
  expired: "已过期",
  revoked: "已撤销",
};

// ─── Create Drawer ──────────────────────────────────────────────────────────

function CreateDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [role, setRole] = useState<"admin" | "member">("member");
  const [quota, setQuota] = useState(100);
  const [maxUses, setMaxUses] = useState(1);
  const [expDays, setExpDays] = useState(30);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ code: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setRole("member");
      setQuota(100);
      setMaxUses(1);
      setExpDays(30);
      setNote("");
      setError("");
      setResult(null);
      setCopied(false);
      setSaving(false);
    }
  }, [open]);

  const handleCreate = async () => {
    setSaving(true);
    setError("");
    try {
      const expiresAt = new Date(Date.now() + expDays * 86400000).toISOString();
      const payload: CreateInvitationPayload = {
        role,
        initial_daily_quota: quota,
        max_uses: maxUses,
        expires_at: expiresAt,
        note: note.trim() || undefined,
      };
      const res = await createInvitation(payload);
      setResult({ code: res.invitation.code });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDone = () => {
    onCreated();
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={result ? handleDone : onClose} />
      <div className="relative z-10 flex w-[420px] flex-col bg-[#141414] border-l border-white/[0.08] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-sm font-semibold text-white">创建邀请码</h3>
          <button onClick={result ? handleDone : onClose} className="text-neutral-500 hover:text-white transition">
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6">
            <div className="text-xs text-neutral-500">邀请码已创建，请复制分享给受邀用户</div>
            <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-black/40 px-5 py-3">
              <span className="font-mono text-lg tracking-[0.15em] text-white">{result.code}</span>
              <button onClick={handleCopy} className="ml-2 text-neutral-400 hover:text-white transition">
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            {copied && <span className="text-xs text-emerald-400">已复制到剪贴板</span>}
            <Button onClick={handleDone} className="mt-4 bg-[#ff6a1f] text-white hover:bg-[#ff7b35] rounded-full px-8">完成</Button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              {/* 角色 */}
              <Field label="角色" required>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as "admin" | "member")}
                  className="w-full rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm text-white"
                >
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                </select>
              </Field>

              {/* 每日积分配额 */}
              <Field label="每日积分配额">
                <Input
                  type="number"
                  value={quota}
                  onChange={(e) => setQuota(Number(e.target.value))}
                  min={0}
                  className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
                />
              </Field>

              {/* 最大使用次数 */}
              <Field label="最大使用次数">
                <Input
                  type="number"
                  value={maxUses}
                  onChange={(e) => setMaxUses(Number(e.target.value))}
                  min={1}
                  className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
                />
              </Field>

              {/* 有效期 */}
              <Field label="有效天数">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    value={expDays}
                    onChange={(e) => setExpDays(Number(e.target.value))}
                    min={1}
                    max={365}
                    className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white w-24"
                  />
                  <span className="text-xs text-neutral-500">天后过期</span>
                </div>
              </Field>

              {/* 备注 */}
              <Field label="备注">
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="可选，如「给前端团队」"
                  className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
                />
              </Field>

              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>

            <div className="flex gap-3 border-t border-white/[0.06] px-6 py-4">
              <Button onClick={onClose} variant="outline" className="border-white/10 text-neutral-300 hover:bg-white/5 rounded-full px-5">取消</Button>
              <Button onClick={handleCreate} disabled={saving} className="bg-[#ff6a1f] text-white hover:bg-[#ff7b35] rounded-full px-5">
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                创建邀请码
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1 text-xs font-medium text-neutral-400">
        {required && <span className="text-[#ff6a1f]">*</span>} {label}
      </label>
      {children}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export function AdminInvitationsPage() {
  const [invitations, setInvitations] = useState<AdminInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setInvitations(await listInvitations()); } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRevoke = async (inv: AdminInvitation) => {
    setBusyId(inv.id);
    try {
      await revokeInvitation(inv.id);
      await load();
    } finally { setBusyId(null); }
  };

  return (
    <AdminShell
      title="邀请码管理"
      description="创建、查看和撤销邀请码。新用户通过邀请码注册后自动获得对应角色和积分配额。"
      action={
        <Button className="rounded-full bg-[#ff6a1f] px-5 text-white hover:bg-[#ff7b35]" onClick={() => setDrawerOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          创建邀请码
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-3">
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">邀请码总数</p>
            <p className="mt-2 text-3xl font-semibold text-white">{invitations.length}</p>
          </div>
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">当前有效</p>
            <p className="mt-2 text-3xl font-semibold text-white">{invitations.filter((inv) => inv.status === "active").length}</p>
          </div>
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">已撤销</p>
            <p className="mt-2 text-3xl font-semibold text-white">{invitations.filter((inv) => inv.status === "revoked").length}</p>
          </div>
        </div>
        <div
          data-admin-panel
          className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
        >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              {["角色", "配额", "使用量", "备注", "创建者", "过期时间", "状态", "操作"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {loading ? (
              <tr><td colSpan={8} className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
            ) : invitations.length === 0 ? (
              <tr><td colSpan={8} className="py-16 text-center text-sm text-neutral-600">暂无邀请码，点击「创建邀请码」开始</td></tr>
            ) : invitations.map((inv) => (
              <tr key={inv.id} className="group hover:bg-white/[0.02] transition">
                <td className="px-4 py-3">
                  <Badge className={inv.role === "admin" ? "bg-[#ff6a1f]/15 text-[#ff9b68] border-[#ff6a1f]/20" : "bg-white/[0.06] text-neutral-300 border-white/10"}>
                    {inv.role === "admin" ? "管理员" : "成员"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-neutral-300">{inv.initial_daily_quota}</td>
                <td className="px-4 py-3 text-neutral-400">{inv.used_count} / {inv.max_uses}</td>
                <td className="px-4 py-3 max-w-[160px] truncate text-neutral-500" title={inv.note}>{inv.note || "—"}</td>
                <td className="px-4 py-3 text-neutral-400">{inv.creator_name}</td>
                <td className="px-4 py-3 text-xs text-neutral-500">{new Date(inv.expires_at).toLocaleString("zh-CN")}</td>
                <td className="px-4 py-3">
                  <Badge className={STATUS_STYLES[inv.status] ?? STATUS_STYLES.expired}>
                    {STATUS_LABEL[inv.status] ?? inv.status}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {inv.status === "active" && (
                    <button
                      onClick={() => handleRevoke(inv)}
                      disabled={busyId === inv.id}
                      title="撤销"
                      className="text-neutral-500 hover:text-red-400 disabled:opacity-30 transition opacity-0 group-hover:opacity-100"
                    >
                      {busyId === inv.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && invitations.length > 0 && (
          <div className="border-t border-white/[0.04] bg-white/[0.01] px-4 py-3 text-xs text-neutral-600">
            共 {invitations.length} 条
          </div>
        )}
        </div>
      </div>

      <CreateDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={load} />
    </AdminShell>
  );
}
