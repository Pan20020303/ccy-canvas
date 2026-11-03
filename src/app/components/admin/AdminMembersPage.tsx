import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Search, ShieldCheck, Users, UserCheck, Settings2, AlertTriangle } from 'lucide-react';
import { type AdminUser, listUsers, updateUserRole, updateUserStatus, deleteUser, adjustCredits, resetUserPassword } from '../../api/admin';
import { AdminShell } from './AdminShell';
import { AdminActionDialog } from './AdminActionDialog';

type Action = 'choose' | 'role' | 'status' | 'credits' | 'password' | 'delete';
const failure = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';
const PAGE_SIZE = 15;

function MemberDialog({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: (message: string) => void }) {
  const [action, setAction] = useState<Action>('choose');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState('0');
  const [quota, setQuota] = useState(String(user.daily_quota));
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const titles = { choose: '管理成员', role: '确认更改角色', status: user.status === 'active' ? '确认停用账号' : '确认启用账号', credits: '调整积分与额度', password: '重置登录密码', delete: '删除成员' };
  const balanceAfter = user.current_balance + Number(amount);
  const validCredits = amount.trim() !== '' && quota.trim() !== '' && Number.isSafeInteger(Number(amount)) && Number.isSafeInteger(Number(quota)) && Number(quota) >= 0 && Number(quota) <= 2147483647 && balanceAfter >= 0 && balanceAfter <= 2147483647 && (Number(amount) !== 0 || Number(quota) !== user.daily_quota) && reason.trim().length > 0;
  const valid = action === 'credits' ? validCredits : action === 'delete' ? email.trim() === user.email : action === 'password' ? password.length >= 8 && password === confirm : true;
  const select = (value: Action) => { setAction(value); setError(''); };
  const submit = async () => {
    if (submitting.current || !valid || action === 'choose') return;
    submitting.current = true; setBusy(true); setError('');
    try {
      if (action === 'role') await updateUserRole(user.id, user.role === 'admin' ? 'member' : 'admin');
      if (action === 'status') await updateUserStatus(user.id, user.status === 'active' ? 'disabled' : 'active');
      if (action === 'delete') await deleteUser(user.id);
      if (action === 'credits') await adjustCredits(user.id, { add_balance: Number(amount), set_quota: Number(quota), reason: reason.trim() });
      if (action === 'password') await resetUserPassword(user.id, password);
      onSaved(`${user.name || user.email}：${titles[action]}已完成`);
    } catch (e) { setError(failure(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <AdminActionDialog title={titles[action]} description="所有更改均需确认后提交，操作将记录在后台审计日志中。" busy={busy} onClose={onClose}>
    <div className="admin-member-identity"><span className="admin-avatar">{(user.name || user.email).slice(0, 1)}</span><div><strong>{user.name || '未命名成员'}</strong><p>{user.email}</p></div><span className="admin-status">{user.role === 'admin' ? '管理员' : '成员'}</span></div>
    {action === 'choose' ? <>
      <div className="admin-action-options">
        <button onClick={() => select('credits')}><strong>积分与额度</strong><span>余额 {user.current_balance.toLocaleString()} · 每日额度 {user.daily_quota.toLocaleString()}</span></button>
        <button onClick={() => select('role')}><strong>更改成员角色</strong><span>{user.role === 'admin' ? '管理员 → 普通成员' : '普通成员 → 管理员'}</span></button>
        <button onClick={() => select('password')}><strong>重置密码</strong><span>设置新的登录密码</span></button>
        <button onClick={() => select('status')}><strong>{user.status === 'active' ? '停用账号' : '启用账号'}</strong><span>{user.status === 'active' ? '阻止后续访问，保留账号数据' : '恢复账号访问权限'}</span></button>
      </div>
      <div className="admin-danger-zone"><span>不可恢复的操作</span><button className="admin-button danger-text" onClick={() => select('delete')}>删除成员…</button></div>
    </> : <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <fieldset disabled={busy} className="admin-form-stack">
        {action === 'role' && <div className="admin-notice warning"><ShieldCheck size={18} /><p>{user.role === 'admin' ? '该成员将失去后台管理权限。' : '该成员将能管理平台成员、模型、密钥和存储配置。请仅向可信任人员授予管理员权限。'}</p></div>}
        {action === 'status' && <div className="admin-notice warning"><AlertTriangle size={18} /><p>{user.status === 'active' ? '账号停用后将无法继续访问受保护接口。已有项目和素材不会被删除。' : '账号启用后可重新登录并访问已有项目。'}</p></div>}
        {action === 'delete' && <><div className="admin-notice error"><AlertTriangle size={18} /><p>删除账号后无法通过此页面恢复。有项目或流水等关联记录时，系统可能拒绝删除；不会自动清理云端媒体。建议优先使用「停用账号」。</p></div><label>输入成员邮箱以确认<input autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={user.email} /></label></>}
        {action === 'credits' && <>
          <label>积分调整量（正数增加，负数扣减）<input type="number" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <div className="admin-change-preview"><span>当前余额 <b>{user.current_balance.toLocaleString()}</b></span><span>→</span><span>调整后 <b>{amount.trim() && Number.isFinite(balanceAfter) ? balanceAfter.toLocaleString() : '—'}</b></span></div>
          <label>每日额度<input type="number" min="0" max="2147483647" step="1" value={quota} onChange={(e) => setQuota(e.target.value)} /></label>
          <label>调整原因 <span>必填，记录到积分流水</span><input maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：补偿失败任务扣费" /></label>
          {!validCredits && <p className="admin-help">请填写整数和调整原因，调整后余额及额度不能为负数；至少修改一项。</p>}
        </>}
        {action === 'password' && <><label>新密码（至少 8 位）<input type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><label>再次输入新密码<input type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label><label className="admin-checkbox"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />显示密码</label><p className="admin-help">重置后旧密码不能用于新登录；不会强制注销已有会话。</p></>}
      </fieldset>
      {error && <div role="alert" className="admin-notice error">{error}</div>}
      <div className="admin-form-actions"><button type="button" className="admin-button" disabled={busy} onClick={() => select('choose')}>返回，不更改</button><button className={`admin-button ${action === 'delete' ? 'danger' : 'primary'}`} type="submit" disabled={busy || !valid}>{busy ? '正在提交…' : action === 'delete' ? '确认永久删除' : '确认更改'}</button></div>
    </form>}
  </AdminActionDialog>;
}

export function AdminMembersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current; setLoading(true); setError('');
    try { const data = await listUsers(); if (id === request.current) setUsers(data); }
    catch (e) { if (id === request.current) setError(failure(e)); }
    finally { if (id === request.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  const filtered = useMemo(() => users.filter((u) => (!role || u.role === role) && (!status || u.status === status) && `${u.name} ${u.email}`.toLowerCase().includes(search.trim().toLowerCase())), [users, search, role, status]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return <AdminShell title="成员管理" description="查看成员、分配权限与额度。先选择成员，再确认更改，避免误操作。" action={<button className="admin-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />刷新</button>}>
    <div className="admin-summary-grid">{[
      { label: '成员总数', value: users.length, icon: Users }, { label: '管理员', value: users.filter((u) => u.role === 'admin').length, icon: ShieldCheck }, { label: '正常账号', value: users.filter((u) => u.status === 'active').length, icon: UserCheck },
    ].map(({ label, value, icon: Icon }) => <div data-admin-card className="admin-summary-card" key={label}><span><Icon size={17} />{label}</span><strong>{loading && !users.length ? '—' : value}</strong></div>)}</div>
    {error && <div role="alert" className="admin-notice error">{error} <button className="admin-button" onClick={() => void load()}>重试</button></div>}
    {notice && <div role="status" className="admin-notice success">{notice}<button className="admin-button" onClick={() => setNotice('')}>知道了</button></div>}
    <section className="admin-panel" aria-label="成员列表">
      <div className="admin-filter-bar"><label className="admin-search"><Search size={16} /><input aria-label="搜索成员" placeholder="搜索姓名或邮箱" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} /></label><select aria-label="筛选角色" value={role} onChange={(e) => { setRole(e.target.value); setPage(0); }}><option value="">全部角色</option><option value="admin">管理员</option><option value="member">成员</option></select><select aria-label="筛选状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}><option value="">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option></select><span>{filtered.length} 位成员</span></div>
      <div className="admin-table-scroll" aria-busy={loading}><table className="admin-members-table"><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>积分余额 / 每日额度</th><th>最后登录</th><th>操作</th></tr></thead><tbody>
        {filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((u) => <tr key={u.id}><td><div className="admin-member-name"><span className="admin-avatar">{(u.name || u.email).slice(0, 1)}</span><div><strong title={u.name}>{u.name || '未命名成员'}</strong><span title={u.email}>{u.email}</span></div></div></td><td><span className={`admin-role ${u.role}`}>{u.role === 'admin' ? '管理员' : '成员'}</span></td><td><span className={`admin-status ${u.status}`}>{u.status === 'active' ? '正常' : '已停用'}</span></td><td className="admin-number"><strong>{u.current_balance.toLocaleString()}</strong><span className="admin-help"> / {u.daily_quota.toLocaleString()}</span></td><td className="admin-help">{u.last_login_at ? new Date(u.last_login_at).toLocaleString('zh-CN', { hour12: false }) : '尚未登录'}</td><td><button className="admin-button" aria-label={`管理 ${u.name || u.email}`} onClick={() => setSelected(u)}><Settings2 size={14} />管理</button></td></tr>)}
      </tbody></table>{filtered.length === 0 && <div className="admin-empty">{loading ? '正在加载成员…' : error ? '成员列表暂不可用，请重试。' : '没有匹配的成员，试试调整搜索或筛选条件。'}</div>}</div>
      <div className="admin-pagination"><span>第 {current + 1} / {pages} 页 · 每页 {PAGE_SIZE} 位</span><div><button className="admin-button" aria-label="上一页" disabled={current === 0} onClick={() => setPage(current - 1)}><ChevronLeft size={16} /></button><button className="admin-button" aria-label="下一页" disabled={current === pages - 1} onClick={() => setPage(current + 1)}><ChevronRight size={16} /></button></div></div>
    </section>
    {selected && <MemberDialog key={selected.id} user={selected} onClose={() => setSelected(null)} onSaved={(message) => { setSelected(null); setNotice(message); void load(); }} />}
  </AdminShell>;
}
