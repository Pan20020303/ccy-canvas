import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle, ArrowLeft, ArrowRight, Calendar, Check, ChevronDown, ChevronUp, Coins, Info,
  Lock, RotateCcw, ScrollText, Send, Settings, ShieldCheck, Trash2, Users, Wallet, X, Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';

import { useAuth } from '../auth/AuthProvider';
import { lookupUsers } from '../api/assets';
import {
  setProjectCollaboration, listProjectMembers, inviteProjectMember,
  updateProjectMemberRole, removeProjectMember,
} from '../api/projects';
import {
  useStore, COLLAB_ROLE_OPTIONS, collabRoleLabel,
  type CollabActivity, type CollabMember, type CollabRole,
} from '../store';

/**
 * 协作控件 —— 画布顶栏右侧。私有:「协作」按钮 → 转为协作弹窗(仅创建者);协作中:
 * 「<身份> ▾」(成员管理/操作日志/转为私有,按权限显示) +「⚡ ▾」(创建者:积分管理/
 * 积分记录) +「● 协作中」。协作标记、成员、权限均由后端持久化(project_members);
 * 操作日志与积分账单仍为会话态/占位,后续接入。
 */

const pillBase = 'rounded-full border border-white/[0.10] bg-black/55 backdrop-blur-xl shadow-[0_10px_32px_-12px_rgba(0,0,0,0.65)]';

function relTime(ts: number, zh: boolean): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return zh ? '刚刚' : 'just now';
  if (m < 60) return zh ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return zh ? `${h} 小时前` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return zh ? `${d} 天前` : `${d}d ago`;
}

export function CollaborationControls() {
  const language = useStore((s) => s.language);
  const activeProjectId = useStore((s) => s.activeBackendProjectId);
  const backendProjects = useStore((s) => s.backendProjects);
  const refreshBackendProjects = useStore((s) => s.refreshBackendProjects);
  const activityByProject = useStore((s) => s.collabActivityByProject);
  const logCollabActivity = useStore((s) => s.logCollabActivity);
  // 只订阅节点数量,避免每次画布编辑都重渲染顶栏。
  const nodeCount = useStore((s) => s.nodes.length);
  const { user, creditSummary } = useAuth();
  const zh = language === 'zh';

  const [convertOpen, setConvertOpen] = useState(false);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [pointsManageOpen, setPointsManageOpen] = useState(false);
  const [pointsLogOpen, setPointsLogOpen] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [pointsMenuOpen, setPointsMenuOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [members, setMembers] = useState<CollabMember[]>([]);

  // 协作状态与我的身份来自后端项目(ListProjectsForUser 返回 is_collaborative + my_role)。
  const project = activeProjectId ? backendProjects.find((p) => p.id === activeProjectId) : undefined;
  const isCollab = Boolean(project?.is_collaborative);
  const myRole: CollabRole = (project?.my_role as CollabRole | undefined) ?? 'creator';
  const isCreator = myRole === 'creator';
  const canManage = isCreator || myRole === 'admin';

  // 成员列表来自后端(owner 不入表,故创建者视角自行补一行 creator)。
  const loadMembers = useCallback(async () => {
    if (!activeProjectId || !isCollab || !user) { setMembers([]); return; }
    try {
      const list = await listProjectMembers(activeProjectId);
      const mapped: CollabMember[] = list.map((m) => ({ uid: m.uid, name: m.name, role: m.role }));
      setMembers(isCreator
        ? [{ uid: user.id, name: user.name, avatar: user.avatar, role: 'creator' }, ...mapped]
        : mapped);
    } catch { /* best-effort */ }
  }, [activeProjectId, isCollab, isCreator, user]);

  useEffect(() => { void loadMembers(); }, [loadMembers]);

  // 操作日志(会话态):协作中,节点数变化时记一条 update_node(当前用户)。
  const prevCount = useRef<number | null>(null);
  useEffect(() => {
    if (!activeProjectId || !isCollab || !user) { prevCount.current = nodeCount; return; }
    if (prevCount.current !== null && nodeCount !== prevCount.current) {
      logCollabActivity(activeProjectId, { action: 'update_node', uid: user.id, name: user.name, avatar: user.avatar });
    }
    prevCount.current = nodeCount;
  }, [nodeCount, activeProjectId, isCollab, user, logCollabActivity]);

  if (!user || !activeProjectId) return null;

  const activity = activityByProject[activeProjectId] ?? [];

  const convert = async (collaborative: boolean) => {
    if (converting) return;
    setConverting(true);
    try {
      await setProjectCollaboration(activeProjectId, collaborative);
      await refreshBackendProjects();
      toast.success(collaborative
        ? (zh ? '已转为协作项目' : 'Converted to collaborative')
        : (zh ? '已转为私有项目' : 'Converted to private'));
      setConvertOpen(false);
      setPrivateOpen(false);
    } catch {
      toast.error(zh ? '操作失败，请稍后重试' : 'Action failed');
    } finally {
      setConverting(false);
    }
  };

  const invite = async (username: string, role: CollabRole): Promise<boolean> => {
    if (role === 'creator') return false;
    try {
      const matches = await lookupUsers(username);
      const u = matches[0];
      if (!u) { toast.error(zh ? '未找到该用户名' : 'User not found'); return false; }
      if (u.uid === user.id) { toast.error(zh ? '不能邀请自己' : "Can't invite yourself"); return false; }
      if (members.some((m) => m.uid === u.uid)) { toast.info(zh ? '该用户已是成员' : 'Already a member'); return false; }
      await inviteProjectMember(activeProjectId, u.uid, role);
      await loadMembers();
      toast.success(zh ? `已邀请 ${u.name}` : `Invited ${u.name}`);
      return true;
    } catch {
      toast.error(zh ? '邀请失败，请稍后重试' : 'Invite failed');
      return false;
    }
  };

  const changeRole = async (uid: string, role: CollabRole) => {
    if (role === 'creator') return;
    try {
      await updateProjectMemberRole(activeProjectId, uid, role);
      await loadMembers();
    } catch {
      toast.error(zh ? '修改权限失败' : 'Failed to change role');
    }
  };

  const removeMember = async (uid: string) => {
    try {
      await removeProjectMember(activeProjectId, uid);
      await loadMembers();
    } catch {
      toast.error(zh ? '移除成员失败' : 'Failed to remove member');
    }
  };

  return (
    <>
      {isCollab ? (
        <div className="flex items-center gap-2">
          {/* 身份 role dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setRoleMenuOpen((v) => !v); setPointsMenuOpen(false); }}
              className={clsx('flex h-9 items-center gap-1.5 px-3 text-[12px] text-neutral-100 transition hover:bg-black/70', pillBase)}
            >
              <Users className="h-3.5 w-3.5 text-neutral-300" />
              {collabRoleLabel(myRole, zh)}
              {roleMenuOpen ? <ChevronUp className="h-3 w-3 opacity-60" /> : <ChevronDown className="h-3 w-3 opacity-60" />}
            </button>
            {roleMenuOpen ? (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setRoleMenuOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-2 w-44 rounded-xl border border-white/10 bg-[#15181d]/95 py-1.5 shadow-2xl backdrop-blur-xl">
                  {canManage ? (
                    <MenuRow icon={Users} label={zh ? '成员管理' : 'Members'} onClick={() => { setRoleMenuOpen(false); setMembersOpen(true); }} />
                  ) : null}
                  <MenuRow icon={ScrollText} label={zh ? '操作日志' : 'Activity log'} onClick={() => { setRoleMenuOpen(false); setLogOpen(true); }} />
                  {isCreator ? (
                    <>
                      <div className="my-1 border-t border-white/5" />
                      <MenuRow icon={Lock} label={zh ? '转为私有' : 'Make private'} onClick={() => { setRoleMenuOpen(false); setPrivateOpen(true); }} />
                    </>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>

          {/* ⚡ points dropdown — 创建者管理项目积分 */}
          {isCreator ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => { setPointsMenuOpen((v) => !v); setRoleMenuOpen(false); }}
                className={clsx('flex h-9 items-center gap-1 px-3 text-[12px] text-neutral-100 transition hover:bg-black/70', pillBase)}
                title={zh ? '项目积分' : 'Project points'}
              >
                <Zap className="h-3.5 w-3.5 text-amber-400" />
                {pointsMenuOpen ? <ChevronUp className="h-3 w-3 opacity-60" /> : <ChevronDown className="h-3 w-3 opacity-60" />}
              </button>
              {pointsMenuOpen ? (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setPointsMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-2 w-40 rounded-xl border border-white/10 bg-[#15181d]/95 py-1.5 shadow-2xl backdrop-blur-xl">
                    <MenuRow icon={Coins} label={zh ? '积分管理' : 'Points'} onClick={() => { setPointsMenuOpen(false); setPointsManageOpen(true); }} />
                    <MenuRow icon={ScrollText} label={zh ? '积分记录' : 'Points log'} onClick={() => { setPointsMenuOpen(false); setPointsLogOpen(true); }} />
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {/* 协作中 status */}
          <span className={clsx('flex h-9 items-center gap-1.5 px-3 text-[12px] text-emerald-300', pillBase)}>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {zh ? '协作中' : 'Collaborating'}
          </span>
        </div>
      ) : (
        // 未协作:仅创建者可见「协作」入口(成员只有在协作态才会看到该项目)。
        isCreator ? (
          <button
            type="button"
            onClick={() => setConvertOpen(true)}
            className={clsx('flex h-9 items-center gap-1.5 px-3.5 text-[12px] text-neutral-100 transition hover:-translate-y-0.5 hover:bg-black/70', pillBase)}
          >
            <Users className="h-3.5 w-3.5 text-neutral-300" />
            {zh ? '协作' : 'Collaborate'}
          </button>
        ) : null
      )}

      {convertOpen ? (
        <ConvertModal
          zh={zh}
          mode="toCollab"
          busy={converting}
          onCancel={() => setConvertOpen(false)}
          onConfirm={() => void convert(true)}
        />
      ) : null}

      {privateOpen ? (
        <ConvertModal
          zh={zh}
          mode="toPrivate"
          busy={converting}
          onCancel={() => setPrivateOpen(false)}
          onConfirm={() => void convert(false)}
        />
      ) : null}

      {membersOpen ? (
        <MemberModal
          zh={zh}
          members={members}
          canManage={canManage}
          onClose={() => setMembersOpen(false)}
          onInvite={invite}
          onRemove={(uid) => void removeMember(uid)}
          onRoleChange={(uid, role) => void changeRole(uid, role)}
        />
      ) : null}

      {logOpen ? <ActivityLogModal zh={zh} activity={activity} onClose={() => setLogOpen(false)} /> : null}

      {pointsManageOpen ? (
        <PointsManageModal
          zh={zh}
          members={members}
          rechargeBalance={creditSummary?.current_balance ?? 0}
          rechargeTotal={creditSummary?.daily_quota ?? 0}
          onClose={() => setPointsManageOpen(false)}
        />
      ) : null}

      {pointsLogOpen ? <PointsLogModal zh={zh} creatorName={user.name} avatar={user.avatar} onClose={() => setPointsLogOpen(false)} /> : null}
    </>
  );
}

function MenuRow({ icon: Icon, label, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/5">
      <Icon className="h-3.5 w-3.5 text-neutral-400" />
      <span>{label}</span>
    </button>
  );
}

// ─── 转为协作 / 转为私有(镜像布局)─────────────────────────────────────────

function ConvertModal({ zh, mode, busy, onCancel, onConfirm }: { zh: boolean; mode: 'toCollab' | 'toPrivate'; busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  const toPrivate = mode === 'toPrivate';
  const privateCard = (
    <PlanCard
      icon={<Lock className="h-4 w-4" />}
      title={zh ? '私有项目' : 'Private'}
      highlight={toPrivate}
      bullets={zh
        ? ['仅您一人可以编辑和查看', '适合个人创作', '无法邀请成员协作', '使用个人积分']
        : ['Only you can edit and view', 'Best for solo work', 'No member invites', 'Uses your personal points']}
    />
  );
  const collabCard = (
    <PlanCard
      icon={<Users className="h-4 w-4" />}
      title={zh ? '协作项目' : 'Collaborative'}
      highlight={!toPrivate}
      bullets={zh
        ? ['可邀请团队成员共同创作', '支持角色权限管理', '实时协作，提升效率', '划转积分到项目中管理']
        : ['Invite teammates to co-create', 'Role-based permissions', 'Real-time collaboration', 'Pool points into the project']}
    />
  );

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-[640px] max-w-[94vw] rounded-2xl border border-white/10 bg-[#17191e] p-8 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-center text-center">
          <div className={clsx('flex h-14 w-14 items-center justify-center rounded-2xl', toPrivate ? 'bg-white/[0.06] text-neutral-300' : 'bg-[#ff6a1f]/15 text-[#ff9b68]')}>
            {toPrivate ? <Lock className="h-6 w-6" /> : <Users className="h-6 w-6" />}
          </div>
          <h3 className="mt-4 text-xl font-semibold text-white">{toPrivate ? (zh ? '转为私有项目' : 'Convert to private') : (zh ? '转为协作项目' : 'Convert to collaborative')}</h3>
          <p className="mt-1.5 text-sm text-neutral-500">
            {toPrivate ? (zh ? '关闭协作，回归个人创作模式' : 'Turn off collaboration, back to solo') : (zh ? '开启团队协作，共同创作精彩故事' : 'Enable team collaboration and co-create')}
          </p>
        </div>

        <div className="mt-7 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          {privateCard}
          {toPrivate ? <ArrowLeft className="h-5 w-5 text-neutral-600" /> : <ArrowRight className="h-5 w-5 text-neutral-600" />}
          {collabCard}
        </div>

        <div className={clsx('mt-6 rounded-xl border p-4', toPrivate ? 'border-rose-500/25 bg-rose-500/[0.06]' : 'border-[#ff6a1f]/25 bg-[#ff6a1f]/[0.06]')}>
          <div className={clsx('flex items-center gap-2 text-[13px] font-medium', toPrivate ? 'text-rose-300' : 'text-[#ffb183]')}>
            <AlertCircle className="h-4 w-4" />
            {zh ? '重要提示：' : 'Important:'}
          </div>
          <p className={clsx('mt-2 text-[12.5px] leading-6', toPrivate ? 'text-rose-200/85' : 'text-[#e6b98f]')}>
            {toPrivate ? (
              <>
                {zh ? '转换为私有项目后，所有协作成员将被移除，且他们将无法再访问此项目。' : 'After converting to private, all collaborators are removed and can no longer access this project.'}
                <br />
                {zh ? '项目剩余积分将自动回退到您的个人积分中。' : 'Remaining project points return to your personal balance.'}
                <br />
                {zh ? '此操作不可撤销！' : 'This action cannot be undone!'}
              </>
            ) : (
              <>
                {zh ? '转换为协作项目后可以再转回私有项目，但会移除所有协作成员。' : 'You can switch back to private later, but that removes all collaborators.'}
                <br />
                {zh ? '仅限充值积分可划转到项目中，会员积分不支持划转。' : 'Only top-up points can be pooled into the project; membership points cannot.'}
              </>
            )}
          </p>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button onClick={onCancel} disabled={busy} className="rounded-lg border border-white/12 bg-white/[0.04] px-5 py-2 text-sm text-neutral-300 transition hover:bg-white/[0.08] disabled:opacity-50">
            {zh ? '取消' : 'Cancel'}
          </button>
          <button onClick={onConfirm} disabled={busy} className="rounded-lg bg-[#ff8a3d] px-5 py-2 text-sm font-medium text-neutral-950 transition hover:bg-[#ff9b57] disabled:opacity-50">
            {busy ? (zh ? '处理中…' : 'Working…') : (zh ? '确认转换' : 'Convert')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PlanCard({ icon, title, bullets, highlight }: { icon: React.ReactNode; title: string; bullets: string[]; highlight: boolean }) {
  return (
    <div className={clsx('h-full rounded-2xl border p-5', highlight ? 'border-[#ff6a1f]/30 bg-[#ff6a1f]/[0.05]' : 'border-white/10 bg-white/[0.02]')}>
      <div className={clsx('flex items-center gap-2 text-sm font-medium', highlight ? 'text-[#ffb183]' : 'text-neutral-200')}>
        {icon}
        {title}
      </div>
      <ul className="mt-4 space-y-2.5">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px] leading-5 text-neutral-400">
            <span className={clsx('mt-1.5 h-1 w-1 shrink-0 rounded-full', highlight ? 'bg-[#ff9b68]' : 'bg-neutral-600')} />
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── 成员管理 ────────────────────────────────────────────────────────────────

function MemberModal({
  zh, members, canManage = true, onClose, onInvite, onRemove, onRoleChange,
}: {
  zh: boolean;
  members: CollabMember[];
  canManage?: boolean;
  onClose: () => void;
  onInvite: (username: string, role: CollabRole) => Promise<boolean>;
  onRemove: (uid: string) => void;
  onRoleChange: (uid: string, role: CollabRole) => void;
}) {
  const [uid, setUid] = useState('');
  const [role, setRole] = useState<CollabRole>('visitor');
  const [roleOpen, setRoleOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const send = async () => {
    const trimmed = uid.trim();
    if (!trimmed || sending) return;
    setSending(true);
    const ok = await onInvite(trimmed, role);
    setSending(false);
    if (ok) setUid('');
  };

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[560px] max-w-[94vw] rounded-2xl border border-white/10 bg-[#17191e] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[15px] font-semibold text-white">{zh ? '成员管理' : 'Members'}</h3>
            <span className="text-xs text-neutral-500">{zh ? '管理项目成员与邀请权限' : 'Manage members and invite permissions'}</span>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-white/8 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {canManage ? (
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium text-neutral-300">
              <Send className="h-3.5 w-3.5 text-neutral-400" />
              {zh ? '邀请成员' : 'Invite member'}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
                placeholder={zh ? '输入用户名' : 'Enter username'}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#111318] px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[#ff6a1f]/40"
              />
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setRoleOpen((v) => !v)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#111318] px-3 py-2 text-sm text-neutral-200 transition hover:bg-white/[0.06]"
                >
                  {collabRoleLabel(role, zh)}
                  {roleOpen ? <ChevronUp className="h-3.5 w-3.5 opacity-60" /> : <ChevronDown className="h-3.5 w-3.5 opacity-60" />}
                </button>
                {roleOpen ? (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setRoleOpen(false)} />
                    <div className="absolute right-0 top-full z-20 mt-1 w-32 overflow-hidden rounded-xl border border-white/10 bg-[#1a1d22] py-1 shadow-2xl">
                      {COLLAB_ROLE_OPTIONS.map((opt) => (
                        <button
                          key={opt.key}
                          onClick={() => { setRole(opt.key); setRoleOpen(false); }}
                          className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-neutral-200 transition hover:bg-white/5"
                        >
                          {zh ? opt.zh : opt.en}
                          {role === opt.key ? <Check className="h-3.5 w-3.5 text-cyan-300" /> : null}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
              <button onClick={() => void send()} disabled={sending} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-neutral-950 transition hover:bg-neutral-200 disabled:opacity-50">
                <Send className="h-3.5 w-3.5" />
                {sending ? (zh ? '邀请中…' : 'Inviting…') : (zh ? '发送邀请' : 'Invite')}
              </button>
            </div>
          </div>
          ) : null}

          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              {zh ? '项目成员' : 'Project members'}
              <Info className="h-3 w-3 text-neutral-600" />
            </div>
            <div className="space-y-1">
              {members.map((m) => (
                <div key={m.uid} className="group flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.03]">
                  <Avatar name={m.name} avatar={m.avatar} creator={m.role === 'creator'} />
                  <div className="min-w-0 flex-1"><div className="truncate text-sm text-neutral-100">{m.name}</div></div>
                  {m.role === 'creator' ? (
                    <span className="flex items-center gap-1 rounded-md bg-[#ff6a1f]/15 px-2 py-1 text-[11px] text-[#ff9b68]">
                      <ShieldCheck className="h-3 w-3" />
                      {collabRoleLabel('creator', zh)}
                    </span>
                  ) : canManage ? (
                    <>
                      <MemberRolePicker zh={zh} role={m.role} onChange={(r) => onRoleChange(m.uid, r)} />
                      <button onClick={() => onRemove(m.uid)} title={zh ? '移除' : 'Remove'} className="text-neutral-600 opacity-0 transition hover:text-rose-400 group-hover:opacity-100">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-neutral-300">{collabRoleLabel(m.role, zh)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Avatar({ name, avatar, creator }: { name: string; avatar?: string; creator?: boolean }) {
  return (
    <div className="relative shrink-0">
      {avatar ? (
        <img src={avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-500/20 text-xs text-cyan-200">{name.slice(0, 1).toUpperCase()}</div>
      )}
      {creator ? <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#17191e] bg-emerald-400" /> : null}
    </div>
  );
}

function MemberRolePicker({ zh, role, onChange }: { zh: boolean; role: CollabRole; onChange: (r: CollabRole) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-neutral-300 transition hover:bg-white/[0.08]"
      >
        {collabRoleLabel(role, zh)}
        {open ? <ChevronUp className="h-3 w-3 opacity-60" /> : <ChevronDown className="h-3 w-3 opacity-60" />}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-28 overflow-hidden rounded-lg border border-white/10 bg-[#1a1d22] py-1 shadow-2xl">
            {COLLAB_ROLE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => { onChange(opt.key); setOpen(false); }}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[11px] text-neutral-200 transition hover:bg-white/5"
              >
                {zh ? opt.zh : opt.en}
                {role === opt.key ? <Check className="h-3 w-3 text-cyan-300" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ─── 操作日志 ────────────────────────────────────────────────────────────────

const LOG_PAGE_SIZE = 13;

function ActivityLogModal({ zh, activity, onClose }: { zh: boolean; activity: CollabActivity[]; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(activity.length / LOG_PAGE_SIZE));
  const rows = activity.slice((page - 1) * LOG_PAGE_SIZE, page * LOG_PAGE_SIZE);

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-[80vh] w-[880px] max-w-[94vw] flex-col rounded-2xl border border-white/10 bg-[#17191e] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 py-4">
          <div>
            <h3 className="text-[15px] font-semibold text-white">{zh ? '操作日志' : 'Activity log'}</h3>
            <p className="mt-0.5 text-xs text-neutral-500">{zh ? '查看项目的操作历史记录' : 'Project operation history'}</p>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400 transition hover:bg-white/12 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-6 pb-3">
          {activity.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-500">
              <ScrollText className="h-8 w-8" />
              <div className="text-sm">{zh ? '暂无操作记录' : 'No activity yet'}</div>
            </div>
          ) : rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] px-4 py-2.5">
              <Avatar name={r.name} avatar={r.avatar} />
              <span className="text-sm text-neutral-100">{r.name}</span>
              <span className="rounded-md bg-cyan-500/12 px-2 py-0.5 text-[11px] text-cyan-300">{r.action}</span>
              <span className="text-neutral-700">—</span>
              <span className="ml-auto text-xs text-neutral-500">{relTime(r.ts, zh)}</span>
            </div>
          ))}
        </div>

        {activity.length > 0 ? (
          <div className="flex items-center justify-center gap-3 border-t border-white/8 px-6 py-3.5 text-xs text-neutral-400">
            <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 transition hover:bg-white/[0.08] disabled:opacity-35">{zh ? '上一页' : 'Prev'}</button>
            <span>{zh ? '第' : 'Page'} <span className="rounded bg-white/10 px-2 py-0.5 text-neutral-100">{page}</span> / {pageCount} {zh ? '页' : ''}</span>
            <button disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} className="rounded-lg bg-white px-4 py-1.5 font-medium text-neutral-950 transition hover:bg-neutral-200 disabled:opacity-35">{zh ? '下一页' : 'Next'}</button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

// ─── 积分管理 ────────────────────────────────────────────────────────────────

function PointsManageModal({ zh, members, rechargeBalance, rechargeTotal, onClose }: { zh: boolean; members: CollabMember[]; rechargeBalance: number; rechargeTotal: number; onClose: () => void }) {
  const pct = rechargeTotal > 0 ? Math.round(((rechargeTotal - rechargeBalance) / rechargeTotal) * 100) : 0;
  const stub = () => toast.info(zh ? '积分划转功能开发中，敬请期待' : 'Points transfer coming soon');
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[960px] max-w-[94vw] rounded-2xl border border-white/10 bg-[#17191e] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h3 className="text-[15px] font-semibold text-white">{zh ? '项目积分' : 'Project points'}</h3>
            <p className="mt-0.5 text-xs text-neutral-500">{zh ? '管理项目积分与成员分配' : 'Manage project points and allocation'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={stub} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/[0.08]"><RotateCcw className="h-3.5 w-3.5" />{zh ? '积分退回' : 'Refund'}</button>
            <button onClick={stub} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/[0.08]"><Wallet className="h-3.5 w-3.5" />{zh ? '积分划转' : 'Transfer'}</button>
            <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400 transition hover:bg-white/12 hover:text-white"><X className="h-4 w-4" /></button>
          </div>
        </div>

        <div className="space-y-4 px-6 pb-6">
          <div className="grid grid-cols-2 gap-4">
            <StatCard zh={zh} label={zh ? '充值积分' : 'Top-up points'} balance={rechargeBalance} total={rechargeTotal} pct={pct} />
            <StatCard zh={zh} label={zh ? '团队积分' : 'Team points'} balance={0} total={0} pct={0} />
          </div>

          <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3.5">
            <div>
              <div className="text-sm text-neutral-100">{zh ? '项目周期限额' : 'Project period limit'}</div>
              <div className="mt-0.5 text-[11px] text-neutral-500">{zh ? '配额' : 'Quota'}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400">{zh ? '无限额' : 'Unlimited'}</span>
              <button onClick={stub} className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-white/8 hover:text-neutral-200"><Settings className="h-4 w-4" /></button>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-neutral-200">
              <Users className="h-4 w-4 text-neutral-400" />
              {zh ? '成员周期限额' : 'Member period limits'}
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-white/10 px-1 text-[10px] text-neutral-300">{members.length}</span>
            </div>
            <div className="space-y-1.5">
              {members.map((m) => (
                <div key={m.uid} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.02] px-3 py-3">
                  <Avatar name={m.name} avatar={m.avatar} creator={m.role === 'creator'} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-neutral-100">{m.name}</div>
                    <div className="mt-0.5 text-[10.5px] text-neutral-500">{collabRoleLabel(m.role, zh)}</div>
                  </div>
                  <span className="text-xs text-neutral-400">{zh ? '无限额' : 'Unlimited'}</span>
                  <span className="rounded-md bg-[#ff6a1f]/15 px-2 py-0.5 text-[11px] text-[#ff9b68]">{zh ? '已用 0' : 'Used 0'}</span>
                  <button onClick={stub} className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-white/8 hover:text-neutral-200"><Settings className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatCard({ zh, label, balance, total, pct }: { zh: boolean; label: string; balance: number; total: number; pct: number }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>{label}</span>
        <span>{zh ? '已用' : 'Used'} {pct}%</span>
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold text-neutral-100">{balance}</span>
          <span className="text-[11px] text-neutral-500">{zh ? '剩余' : 'left'}</span>
        </div>
        <span className="text-[11px] text-neutral-500">{zh ? '总量' : 'total'} {total}</span>
      </div>
    </div>
  );
}

// ─── 积分记录 / 积分账单 ─────────────────────────────────────────────────────

function PointsLogModal({ zh, creatorName, avatar, onClose }: { zh: boolean; creatorName: string; avatar?: string; onClose: () => void }) {
  const [filter, setFilter] = useState<'all' | 'spend' | 'earn'>('all');
  const filters: { key: 'all' | 'spend' | 'earn'; zh: string; en: string }[] = [
    { key: 'all', zh: '全部', en: 'All' },
    { key: 'spend', zh: '消耗', en: 'Spent' },
    { key: 'earn', zh: '获得', en: 'Earned' },
  ];
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-[80vh] w-[1000px] max-w-[95vw] flex-col rounded-2xl border border-white/10 bg-[#17191e] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* 成员卡 */}
        <div className="flex items-center gap-3 border-b border-white/8 px-6 py-4">
          <Avatar name={creatorName} avatar={avatar} creator />
          <div className="min-w-0">
            <div className="truncate text-sm text-neutral-100">{creatorName}</div>
            <div className="mt-0.5 text-[10.5px] text-neutral-500">{collabRoleLabel('creator', zh)}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-neutral-400">{zh ? '无限额' : 'Unlimited'}</span>
            <span className="rounded-md bg-[#ff6a1f]/15 px-2 py-0.5 text-[11px] text-[#ff9b68]">{zh ? '已用 0' : 'Used 0'}</span>
            <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400 transition hover:bg-white/12 hover:text-white"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* 账单头 */}
        <div className="flex items-center justify-between px-6 py-4">
          <h3 className="text-[15px] font-semibold text-white">{zh ? '积分账单' : 'Points statement'}</h3>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-white/[0.08]">
              <Calendar className="h-3.5 w-3.5" />
              {zh ? '本月（全月）' : 'This month'}
            </button>
            <div className="flex items-center gap-1 rounded-lg border border-white/8 bg-white/[0.03] p-0.5">
              {filters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={clsx('rounded-md px-3 py-1 text-xs transition', filter === f.key ? 'bg-white/12 text-white' : 'text-neutral-400 hover:text-neutral-200')}
                >
                  {zh ? f.zh : f.en}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 账单列表(暂空,需后端账单数据) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-500">
            <Coins className="h-8 w-8" />
            <div className="text-sm">{zh ? '暂无积分记录' : 'No points records yet'}</div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
