import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, User, Ban, Trash2, RefreshCw, Zap, XCircle, KeyRound, Eye, EyeOff, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight } from "lucide-react";

import type { AdminUser, AdjustCreditsPayload } from "../../api/admin";
import { listUsers, updateUserRole, updateUserStatus, deleteUser, adjustCredits, resetUserPassword } from "../../api/admin";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminShell } from "./AdminShell";

// ─── Credits Drawer ─────────────────────────────────────────────────────────

function CreditsDrawer({ user, open, onClose, onSaved }: {
  user: AdminUser | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [addAmount, setAddAmount] = useState(100);
  const [newQuota, setNewQuota] = useState(0);
  const [changeQuota, setChangeQuota] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open && user) {
      setAddAmount(100);
      setNewQuota(user.daily_quota);
      setChangeQuota(false);
      setReason("");
      setError("");
    }
  }, [open, user]);

  if (!open || !user) return null;

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const payload: AdjustCreditsPayload = { reason: reason.trim() || undefined };
      if (addAmount !== 0) payload.add_balance = addAmount;
      if (changeQuota) payload.set_quota = newQuota;
      await adjustCredits(user.id, payload);
      onSaved();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 flex w-[400px] flex-col bg-[#141414] border-l border-white/[0.08] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-sm font-semibold text-white">积分管理 — {user.name}</h3>
          <button onClick={onClose} className="text-neutral-500 hover:text-white transition">
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Current */}
          <div className="flex gap-4">
            <div className="flex-1 rounded-xl border border-white/[0.08] bg-black/30 p-3">
              <p className="text-[10px] uppercase tracking-wider text-neutral-500">当前余额</p>
              <p className="mt-1 text-2xl font-semibold text-white">{user.current_balance}</p>
            </div>
            <div className="flex-1 rounded-xl border border-white/[0.08] bg-black/30 p-3">
              <p className="text-[10px] uppercase tracking-wider text-neutral-500">每日配额</p>
              <p className="mt-1 text-2xl font-semibold text-white">{user.daily_quota}</p>
            </div>
          </div>

          {/* Add balance */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-400">充值积分</label>
            <div className="flex gap-2">
              {[50, 100, 500, 1000].map((v) => (
                <button
                  key={v}
                  onClick={() => setAddAmount(v)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition ${addAmount === v ? "border-[#ff6a1f]/40 bg-[#ff6a1f]/15 text-[#ff9b68]" : "border-white/[0.08] bg-[#1a1a1a] text-neutral-300 hover:bg-white/5"}`}
                >
                  +{v}
                </button>
              ))}
            </div>
            <Input
              type="number"
              value={addAmount}
              onChange={(e) => setAddAmount(Number(e.target.value))}
              className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white mt-1"
            />
            <p className="text-[10px] text-neutral-600">输入负数可扣减积分</p>
          </div>

          {/* Quota toggle */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium text-neutral-400">
              <button
                onClick={() => setChangeQuota(!changeQuota)}
                className={`relative h-5 w-9 rounded-full transition ${changeQuota ? "bg-[#ff6a1f]" : "bg-neutral-700"}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${changeQuota ? "left-[18px]" : "left-0.5"}`} />
              </button>
              同时修改每日配额
            </label>
            {changeQuota && (
              <Input
                type="number"
                value={newQuota}
                onChange={(e) => setNewQuota(Number(e.target.value))}
                min={0}
                className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
              />
            )}
          </div>

          {/* Reason */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-400">原因（可选）</label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="如：月度充值"
              className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-3 border-t border-white/[0.06] px-6 py-4">
          <Button onClick={onClose} variant="outline" className="border-white/10 text-neutral-300 hover:bg-white/5 rounded-full px-5">取消</Button>
          <Button onClick={handleSave} disabled={saving || (addAmount === 0 && !changeQuota)} className="bg-[#ff6a1f] text-white hover:bg-[#ff7b35] rounded-full px-5">
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            确认
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Password Dialog ────────────────────────────────────────────────────────

function PasswordDialog({ user, open, onClose }: {
  user: AdminUser | null;
  open: boolean;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (open) { setPassword(""); setConfirm(""); setError(""); setDone(false); setShow(false); }
  }, [open]);

  if (!open || !user) return null;

  const handleSave = async () => {
    setError("");
    if (password.length < 6) { setError("密码至少 6 位"); return; }
    if (password !== confirm) { setError("两次输入不一致"); return; }
    setSaving(true);
    try {
      await resetUserPassword(user.id, password);
      setDone(true);
      setTimeout(onClose, 1200);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "重置失败");
    } finally { setSaving(false); }
  };

  const genRandom = () => {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let pwd = "";
    for (let i = 0; i < 12; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
    setPassword(pwd); setConfirm(pwd); setShow(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm">
      <div className="w-[440px] max-w-[92vw] rounded-2xl border border-white/[0.08] bg-[#141414] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-white">重置密码</h3>
            <p className="mt-0.5 text-xs text-neutral-500">{user.name} · {user.email}</p>
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-white transition">
            <XCircle className="h-4 w-4" />
          </button>
        </div>
        {done ? (
          <div className="px-5 py-8 text-center text-sm text-emerald-400">密码已重置成功</div>
        ) : (
          <>
            <div className="space-y-4 px-5 py-5">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-neutral-400">新密码</label>
                  <button onClick={genRandom} className="text-[11px] text-neutral-500 transition hover:text-neutral-200">生成随机密码</button>
                </div>
                <div className="relative">
                  <Input
                    type={show ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="至少 6 位"
                    className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white pr-9"
                  />
                  <button onClick={() => setShow((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-200">
                    {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-neutral-400">再次输入</label>
                <Input
                  type={show ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <p className="text-[10px] text-neutral-600">该用户下次登录需用新密码。请通过安全渠道告知。</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
              <Button onClick={onClose} variant="outline" className="border-white/10 text-neutral-300 hover:bg-white/5 rounded-full px-5">取消</Button>
              <Button onClick={handleSave} disabled={saving || !password || !confirm} className="bg-[#ff6a1f] text-white hover:bg-[#ff7b35] rounded-full px-5">
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                确认重置
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export function AdminMembersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creditUser, setCreditUser] = useState<AdminUser | null>(null);
  const [passwordUser, setPasswordUser] = useState<AdminUser | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers(await listUsers()); } catch { /* */ }
    setLoading(false);
  }, []);

  const totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [page, totalPages]);

  const safePage = Math.min(page, totalPages - 1);
  const pagedUsers = users.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  useEffect(() => { load(); }, [load]);

  const handleToggleRole = async (u: AdminUser) => {
    setBusyId(u.id);
    try {
      await updateUserRole(u.id, u.role === "admin" ? "member" : "admin");
      await load();
    } finally { setBusyId(null); }
  };

  const handleToggleStatus = async (u: AdminUser) => {
    setBusyId(u.id);
    try {
      await updateUserStatus(u.id, u.status === "active" ? "disabled" : "active");
      await load();
    } finally { setBusyId(null); }
  };

  const handleDelete = async (u: AdminUser) => {
    setBusyId(u.id);
    try {
      await deleteUser(u.id);
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
    } finally { setBusyId(null); }
  };

  return (
    <AdminShell
      title="成员管理"
      description="查看和管理所有注册用户，包括角色、状态和积分配额。"
      action={
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="border-white/10 text-neutral-300 hover:bg-white/5 gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-3">
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">成员总数</p>
            <p className="mt-2 text-3xl font-semibold text-white">{users.length}</p>
          </div>
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">管理员</p>
            <p className="mt-2 text-3xl font-semibold text-white">{users.filter((u) => u.role === "admin").length}</p>
          </div>
          <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">当前活跃</p>
            <p className="mt-2 text-3xl font-semibold text-white">{users.filter((u) => u.status === "active").length}</p>
          </div>
        </div>
        <div
          data-admin-panel
          className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
        >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              {["成员名", "邮箱", "角色", "状态", "积分", "最后登录", "操作"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {loading ? (
              <tr><td colSpan={7} className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={7} className="py-16 text-center text-sm text-neutral-600">暂无用户</td></tr>
            ) : pagedUsers.map((u) => (
              <tr key={u.id} className="group hover:bg-white/[0.02] transition">
                <td className="px-4 py-3 font-medium text-neutral-200">{u.name}</td>
                <td className="px-4 py-3 text-neutral-400">{u.email}</td>
                <td className="px-4 py-3">
                  <Badge className={u.role === "admin" ? "bg-[#ff6a1f]/15 text-[#ff9b68] border-[#ff6a1f]/20" : "bg-white/[0.06] text-neutral-300 border-white/10"}>
                    {u.role === "admin" ? "管理员" : "成员"}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className={`h-2 w-2 rounded-full ${u.status === "active" ? "bg-emerald-400" : "bg-neutral-600"}`} />
                    <span className="text-neutral-300">{u.status === "active" ? "正常" : "已禁用"}</span>
                  </span>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => setCreditUser(u)}
                    className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-xs text-neutral-300 transition hover:border-[#ff6a1f]/30 hover:bg-[#ff6a1f]/5 hover:text-[#ff9b68]"
                  >
                    <Zap className="h-3 w-3" />
                    <span className="tabular-nums">{u.current_balance}</span>
                    <span className="text-neutral-600">/</span>
                    <span className="tabular-nums text-neutral-500">{u.daily_quota}</span>
                  </button>
                </td>
                <td className="px-4 py-3 text-xs text-neutral-500">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleString("zh-CN") : "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                    <button onClick={() => handleToggleRole(u)} disabled={busyId === u.id} title="切换角色" className="text-neutral-500 hover:text-[#ff6a1f] disabled:opacity-30 transition">
                      <ShieldCheck className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => setPasswordUser(u)} disabled={busyId === u.id} title="重置密码" className="text-neutral-500 hover:text-cyan-300 disabled:opacity-30 transition">
                      <KeyRound className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => handleToggleStatus(u)} disabled={busyId === u.id} title={u.status === "active" ? "禁用" : "启用"} className="text-neutral-500 hover:text-amber-400 disabled:opacity-30 transition">
                      {u.status === "active" ? <Ban className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                    </button>
                    <button onClick={() => handleDelete(u)} disabled={busyId === u.id} title="删除" className="text-neutral-500 hover:text-red-400 disabled:opacity-30 transition">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && users.length > 0 && (
          <div className="relative border-t border-white/[0.04] bg-white/[0.01] px-4 py-3 text-xs text-neutral-600">
            共 {users.length} 位用户
            {totalPages > 1 && (
              <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center gap-1 pointer-events-none">
                <button
                  onClick={() => setPage(0)}
                  disabled={safePage === 0}
                  title="第一页"
                  className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition hover:bg-white/[0.08] hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronsLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  title="上一页"
                  className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition hover:bg-white/[0.08] hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="px-1.5 text-[11px] tabular-nums text-neutral-400">
                  {safePage + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                  title="下一页"
                  className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition hover:bg-white/[0.08] hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setPage(totalPages - 1)}
                  disabled={safePage >= totalPages - 1}
                  title="最后一页"
                  className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition hover:bg-white/[0.08] hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronsRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      <CreditsDrawer
        user={creditUser}
        open={creditUser !== null}
        onClose={() => setCreditUser(null)}
        onSaved={load}
      />

      <PasswordDialog
        user={passwordUser}
        open={passwordUser !== null}
        onClose={() => setPasswordUser(null)}
      />
    </AdminShell>
  );
}
