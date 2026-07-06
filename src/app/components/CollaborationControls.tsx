import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle, ArrowRight, Check, ChevronDown, ChevronUp, Coins, Info, Lock,
  ScrollText, Send, ShieldCheck, Trash2, Users, X, Zap,
} from 'lucide-react';
import clsx from 'clsx';

import { useAuth } from '../auth/AuthProvider';
import {
  useStore, COLLAB_ROLE_OPTIONS, collabRoleLabel,
  type CollabMember, type CollabRole,
} from '../store';

/**
 * 协作控件 —— 画布顶栏右侧。
 *   · 私有画布:显示「协作」按钮 → 打开「转为协作项目」弹窗。
 *   · 协作画布:显示「创建者 ▾」(成员管理/操作日志/转为私有) +「⚡ ▾」
 *     (积分管理/积分记录) +「● 协作中」状态。
 *   · 成员管理弹窗:邀请成员(UID + 身份:访问者/协作者/管理者)+ 项目成员列表。
 * 本轮只搭 UI 外壳(会话态),真实邀请/权限/积分逻辑后续接入。
 */

const pillBase = 'rounded-full border border-white/[0.10] bg-black/55 backdrop-blur-xl shadow-[0_10px_32px_-12px_rgba(0,0,0,0.65)]';

export function CollaborationControls() {
  const language = useStore((s) => s.language);
  const activeProjectId = useStore((s) => s.activeBackendProjectId);
  const collabProjects = useStore((s) => s.collabProjects);
  const membersByProject = useStore((s) => s.collabMembersByProject);
  const setProjectCollaborative = useStore((s) => s.setProjectCollaborative);
  const addCollabMember = useStore((s) => s.addCollabMember);
  const removeCollabMember = useStore((s) => s.removeCollabMember);
  const setCollabMemberRole = useStore((s) => s.setCollabMemberRole);
  const { user } = useAuth();
  const zh = language === 'zh';

  const [convertOpen, setConvertOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [pointsMenuOpen, setPointsMenuOpen] = useState(false);
  const [placeholder, setPlaceholder] = useState<{ title: string; desc: string } | null>(null);

  if (!user || !activeProjectId) return null;

  const isCollab = Boolean(collabProjects[activeProjectId]);
  const invited = membersByProject[activeProjectId] ?? [];
  const members: CollabMember[] = [
    { uid: user.id, name: user.name, avatar: user.avatar, role: 'creator' },
    ...invited,
  ];

  return (
    <>
      {isCollab ? (
        <div className="flex items-center gap-2">
          {/* 创建者 role dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setRoleMenuOpen((v) => !v); setPointsMenuOpen(false); }}
              className={clsx('flex h-9 items-center gap-1.5 px-3 text-[12px] text-neutral-100 transition hover:bg-black/70', pillBase)}
            >
              <Users className="h-3.5 w-3.5 text-neutral-300" />
              {collabRoleLabel('creator', zh)}
              {roleMenuOpen ? <ChevronUp className="h-3 w-3 opacity-60" /> : <ChevronDown className="h-3 w-3 opacity-60" />}
            </button>
            {roleMenuOpen ? (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setRoleMenuOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-2 w-44 rounded-xl border border-white/10 bg-[#15181d]/95 py-1.5 shadow-2xl backdrop-blur-xl">
                  <MenuRow icon={Users} label={zh ? '成员管理' : 'Members'} onClick={() => { setRoleMenuOpen(false); setMembersOpen(true); }} />
                  <MenuRow icon={ScrollText} label={zh ? '操作日志' : 'Activity log'} onClick={() => { setRoleMenuOpen(false); setPlaceholder({ title: zh ? '操作日志' : 'Activity log', desc: zh ? '成员在本项目的操作记录将在此展示。' : 'Member activity on this project will appear here.' }); }} />
                  <div className="my-1 border-t border-white/5" />
                  <MenuRow icon={Lock} label={zh ? '转为私有' : 'Make private'} onClick={() => { setRoleMenuOpen(false); setProjectCollaborative(activeProjectId, false); }} />
                </div>
              </>
            ) : null}
          </div>

          {/* ⚡ points dropdown */}
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
                  <MenuRow icon={Coins} label={zh ? '积分管理' : 'Points'} onClick={() => { setPointsMenuOpen(false); setPlaceholder({ title: zh ? '积分管理' : 'Points management', desc: zh ? '把充值积分划转到本协作项目中统一管理。' : 'Transfer top-up points into this project.' }); }} />
                  <MenuRow icon={ScrollText} label={zh ? '积分记录' : 'Points log'} onClick={() => { setPointsMenuOpen(false); setPlaceholder({ title: zh ? '积分记录' : 'Points log', desc: zh ? '项目积分的划转与消耗明细将在此展示。' : 'Project point transfers and usage will appear here.' }); }} />
                </div>
              </>
            ) : null}
          </div>

          {/* 协作中 status */}
          <span className={clsx('flex h-9 items-center gap-1.5 px-3 text-[12px] text-emerald-300', pillBase)}>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {zh ? '协作中' : 'Collaborating'}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConvertOpen(true)}
          className={clsx('flex h-9 items-center gap-1.5 px-3.5 text-[12px] text-neutral-100 transition hover:-translate-y-0.5 hover:bg-black/70', pillBase)}
        >
          <Users className="h-3.5 w-3.5 text-neutral-300" />
          {zh ? '协作' : 'Collaborate'}
        </button>
      )}

      {convertOpen ? (
        <ConvertModal
          zh={zh}
          onCancel={() => setConvertOpen(false)}
          onConfirm={() => { setProjectCollaborative(activeProjectId, true); setConvertOpen(false); }}
        />
      ) : null}

      {membersOpen ? (
        <MemberModal
          zh={zh}
          members={members}
          onClose={() => setMembersOpen(false)}
          onInvite={(uid, role) => addCollabMember(activeProjectId, { uid, name: (zh ? '用户' : 'User') + uid, role })}
          onRemove={(uid) => removeCollabMember(activeProjectId, uid)}
          onRoleChange={(uid, role) => setCollabMemberRole(activeProjectId, uid, role)}
        />
      ) : null}

      {placeholder ? (
        <PlaceholderModal zh={zh} title={placeholder.title} desc={placeholder.desc} onClose={() => setPlaceholder(null)} />
      ) : null}
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

// ─── 转为协作项目 ────────────────────────────────────────────────────────────

function ConvertModal({ zh, onCancel, onConfirm }: { zh: boolean; onCancel: () => void; onConfirm: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-[640px] max-w-[94vw] rounded-2xl border border-white/10 bg-[#17191e] p-8 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#ff6a1f]/15 text-[#ff9b68]">
            <Users className="h-6 w-6" />
          </div>
          <h3 className="mt-4 text-xl font-semibold text-white">{zh ? '转为协作项目' : 'Convert to collaborative'}</h3>
          <p className="mt-1.5 text-sm text-neutral-500">{zh ? '开启团队协作，共同创作精彩故事' : 'Enable team collaboration and co-create'}</p>
        </div>

        <div className="mt-7 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <PlanCard
            icon={<Lock className="h-4 w-4" />}
            title={zh ? '私有项目' : 'Private'}
            highlight={false}
            bullets={zh
              ? ['仅您一人可以编辑和查看', '适合个人创作', '无法邀请成员协作', '使用个人积分']
              : ['Only you can edit and view', 'Best for solo work', 'No member invites', 'Uses your personal points']}
          />
          <ArrowRight className="h-5 w-5 text-neutral-600" />
          <PlanCard
            icon={<Users className="h-4 w-4" />}
            title={zh ? '协作项目' : 'Collaborative'}
            highlight
            bullets={zh
              ? ['可邀请团队成员共同创作', '支持角色权限管理', '实时协作，提升效率', '划转积分到项目中管理']
              : ['Invite teammates to co-create', 'Role-based permissions', 'Real-time collaboration', 'Pool points into the project']}
          />
        </div>

        <div className="mt-6 rounded-xl border border-[#ff6a1f]/25 bg-[#ff6a1f]/[0.06] p-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[#ffb183]">
            <AlertCircle className="h-4 w-4" />
            {zh ? '重要提示：' : 'Important:'}
          </div>
          <p className="mt-2 text-[12.5px] leading-6 text-[#e6b98f]">
            {zh
              ? '转换为协作项目后可以再转回私有项目，但会移除所有协作成员。'
              : 'You can switch back to private later, but that removes all collaborators.'}
            <br />
            {zh
              ? '仅限充值积分可划转到项目中，会员积分不支持划转。'
              : 'Only top-up points can be pooled into the project; membership points cannot.'}
          </p>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button onClick={onCancel} className="rounded-lg border border-white/12 bg-white/[0.04] px-5 py-2 text-sm text-neutral-300 transition hover:bg-white/[0.08]">
            {zh ? '取消' : 'Cancel'}
          </button>
          <button onClick={onConfirm} className="rounded-lg bg-[#ff8a3d] px-5 py-2 text-sm font-medium text-neutral-950 transition hover:bg-[#ff9b57]">
            {zh ? '确认转换' : 'Convert'}
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
  zh, members, onClose, onInvite, onRemove, onRoleChange,
}: {
  zh: boolean;
  members: CollabMember[];
  onClose: () => void;
  onInvite: (uid: string, role: CollabRole) => void;
  onRemove: (uid: string) => void;
  onRoleChange: (uid: string, role: CollabRole) => void;
}) {
  const [uid, setUid] = useState('');
  const [role, setRole] = useState<CollabRole>('visitor');
  const [roleOpen, setRoleOpen] = useState(false);

  const send = () => {
    const trimmed = uid.trim();
    if (!trimmed) return;
    onInvite(trimmed, role);
    setUid('');
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
          {/* 邀请成员 */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium text-neutral-300">
              <Send className="h-3.5 w-3.5 text-neutral-400" />
              {zh ? '邀请成员' : 'Invite member'}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                placeholder={zh ? '输入用户UID' : 'Enter user UID'}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#111318] px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[#ff6a1f]/40"
              />
              {/* 身份选择 */}
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
              <button
                onClick={send}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-neutral-950 transition hover:bg-neutral-200"
              >
                <Send className="h-3.5 w-3.5" />
                {zh ? '发送邀请' : 'Invite'}
              </button>
            </div>
          </div>

          {/* 项目成员 */}
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
            <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-neutral-300">
              {zh ? '项目成员' : 'Project members'}
              <Info className="h-3 w-3 text-neutral-600" />
            </div>
            <div className="space-y-1">
              {members.map((m) => (
                <div key={m.uid} className="group flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.03]">
                  <div className="relative">
                    {m.avatar ? (
                      <img src={m.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-500/20 text-xs text-cyan-200">{m.name.slice(0, 1).toUpperCase()}</div>
                    )}
                    {m.role === 'creator' ? <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#17191e] bg-emerald-400" /> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-neutral-100">{m.name}</div>
                  </div>
                  {m.role === 'creator' ? (
                    <span className="flex items-center gap-1 rounded-md bg-[#ff6a1f]/15 px-2 py-1 text-[11px] text-[#ff9b68]">
                      <ShieldCheck className="h-3 w-3" />
                      {collabRoleLabel('creator', zh)}
                    </span>
                  ) : (
                    <>
                      <MemberRolePicker zh={zh} role={m.role} onChange={(r) => onRoleChange(m.uid, r)} />
                      <button onClick={() => onRemove(m.uid)} title={zh ? '移除' : 'Remove'} className="text-neutral-600 opacity-0 transition hover:text-rose-400 group-hover:opacity-100">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
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

// ─── 占位页(操作日志 / 积分管理 / 积分记录,功能后续接入)────────────────────

function PlaceholderModal({ zh, title, desc, onClose }: { zh: boolean; title: string; desc: string; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[460px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#17191e] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <h3 className="text-[15px] font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-white/8 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] text-neutral-500">
            <Info className="h-6 w-6" />
          </div>
          <p className="max-w-[320px] text-sm text-neutral-400">{desc}</p>
          <span className="rounded-full bg-white/[0.05] px-3 py-1 text-[11px] text-neutral-500">{zh ? '功能开发中，敬请期待' : 'Coming soon'}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
