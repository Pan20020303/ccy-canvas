import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, Image as ImageIcon, LogOut, Plus, Shield, Zap } from 'lucide-react';

import { useAuth } from '../auth/AuthProvider';
import { useStore } from '../store';
import logoUrl from '../../imports/logo.png';

/**
 * 首页 — 全部项目 (reference: LibTV's project grid). Project creation and
 * switching moved OUT of the canvas dock and live here: the canvas (/app) is
 * entered by clicking a project card or the 开始创作 card.
 */

const formatDate = (timestamp: number, zh: boolean) =>
  new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(timestamp)
    .replaceAll('/', '-');

export function HomePage() {
  const navigate = useNavigate();
  const { user, creditSummary, logout } = useAuth();
  const language = useStore((s) => s.language);
  const localProjects = useStore((s) => s.projects);
  const backendProjects = useStore((s) => s.backendProjects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeBackendProjectId = useStore((s) => s.activeBackendProjectId);
  const switchProject = useStore((s) => s.switchProject);
  const switchBackendProject = useStore((s) => s.switchBackendProject);
  const createProject = useStore((s) => s.createProject);
  const createBackendProject = useStore((s) => s.createBackendProject);
  const zh = language === 'zh';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const projects = useMemo(() => (
    backendProjects.length > 0
      ? backendProjects.map((project) => ({
        id: project.id,
        name: project.name,
        createdAt: new Date(project.created_at).getTime(),
        updatedAt: new Date(project.updated_at).getTime(),
      }))
      : localProjects
  ), [backendProjects, localProjects]);
  const effectiveActiveProjectId = activeBackendProjectId ?? activeProjectId;

  const openProject = async (projectId: string) => {
    if (busyId) return;
    setBusyId(projectId);
    try {
      if (backendProjects.length > 0) {
        if (projectId !== activeBackendProjectId) await switchBackendProject(projectId);
      } else if (projectId !== activeProjectId) {
        switchProject(projectId);
      }
      navigate('/app');
    } finally {
      setBusyId(null);
    }
  };

  const startCreating = async () => {
    if (busyId) return;
    setBusyId('__create__');
    try {
      if (backendProjects.length > 0 || user) {
        const created = await createBackendProject(zh ? '未命名项目' : 'Untitled Project');
        if (!created) createProject(zh ? '未命名项目' : undefined);
      } else {
        createProject(zh ? '未命名项目' : undefined);
      }
      navigate('/app');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#0d0e12] text-neutral-100">
      {/* Header */}
      <div className="mx-auto flex max-w-[1280px] items-center justify-between px-8 pb-2 pt-6">
        <div className="flex items-center gap-2.5">
          <img src={logoUrl} alt="CCY Canvas" className="h-7 w-7 rounded object-contain" />
          <span className="text-[15px] font-semibold tracking-wide">CCY Canvas</span>
        </div>
        <div className="flex items-center gap-3">
          {user && creditSummary ? (
            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-neutral-300">
              <Zap className="h-3 w-3 text-amber-400" />
              <span className="tabular-nums">{creditSummary.current_balance}</span>
              <span className="text-neutral-600">/</span>
              <span className="tabular-nums text-neutral-500">{creditSummary.daily_quota}</span>
            </div>
          ) : null}
          {user ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] transition hover:bg-white/[0.08]"
              >
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} className="h-7 w-7 rounded-full object-cover" />
                ) : (
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-500/20 text-xs text-cyan-200">
                    {user.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
              </button>
              {menuOpen ? (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-white/10 bg-[#15181d]/95 py-1.5 shadow-2xl backdrop-blur-xl">
                    <div className="border-b border-white/5 px-3 py-2">
                      <div className="text-sm text-neutral-200">{user.name}</div>
                      <div className="text-[11px] text-neutral-500">{user.email}</div>
                    </div>
                    {user.role === 'admin' ? (
                      <button
                        type="button"
                        onClick={() => { setMenuOpen(false); navigate('/admin'); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/5"
                      >
                        <Shield className="h-3.5 w-3.5 text-neutral-400" />
                        {zh ? '管理端' : 'Admin'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={async () => { setMenuOpen(false); await logout(); navigate('/login'); }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/5"
                    >
                      <LogOut className="h-3.5 w-3.5 text-neutral-400" />
                      {zh ? '退出登录' : 'Log out'}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* 全部项目 */}
      <div className="mx-auto max-w-[1280px] px-8 pb-16 pt-6">
        <div className="mb-5 text-[16px] font-semibold text-neutral-100">{zh ? '全部项目' : 'All projects'}</div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-x-5 gap-y-7">
          {/* 开始创作 */}
          <div>
            <button
              type="button"
              onClick={() => void startCreating()}
              disabled={busyId !== null}
              className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-2 rounded-xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500/[0.10] to-cyan-400/[0.03] text-cyan-200 transition hover:border-cyan-400/50 hover:from-cyan-500/[0.16] disabled:opacity-60"
            >
              <Plus className="h-6 w-6" />
              <span className="text-[13px]">{zh ? '开始创作' : 'Start creating'}</span>
            </button>
            <div className="mt-2.5 px-0.5 text-[12.5px] text-neutral-400">
              {zh ? '创建新的画布项目' : 'Create a new canvas project'}
            </div>
          </div>

          {projects.map((project) => {
            const isActive = project.id === effectiveActiveProjectId;
            return (
              <div key={project.id}>
                <button
                  type="button"
                  onClick={() => void openProject(project.id)}
                  disabled={busyId !== null}
                  className={`group relative block aspect-[16/10] w-full overflow-hidden rounded-xl border transition disabled:opacity-60 ${
                    isActive
                      ? 'border-cyan-400/40 bg-white/[0.04]'
                      : 'border-white/[0.07] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'
                  }`}
                >
                  {/* 项目列表接口没有封面字段 — 占位图标（与参考的灰色占位一致）。 */}
                  <div className="flex h-full w-full items-center justify-center text-neutral-600 transition group-hover:text-neutral-500">
                    <ImageIcon className="h-9 w-9" />
                  </div>
                  {isActive ? (
                    <div className="absolute left-2.5 top-2.5 flex items-center gap-1 rounded-full bg-cyan-500/20 px-2 py-0.5 text-[10px] text-cyan-200">
                      <Check className="h-3 w-3" />
                      {zh ? '当前' : 'Current'}
                    </div>
                  ) : null}
                  {busyId === project.id ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-[12px] text-neutral-200">
                      {zh ? '打开中…' : 'Opening…'}
                    </div>
                  ) : null}
                </button>
                <div className="mt-2.5 flex items-start justify-between gap-2 px-0.5">
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px] text-neutral-200">
                      {project.name.trim() || (zh ? '未命名项目' : 'Untitled Project')}
                    </div>
                    <div className="mt-1 text-[11px] text-neutral-500">{formatDate(project.createdAt, zh)}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-14 text-center text-[12px] text-neutral-600">{zh ? '没有更多了' : 'No more projects'}</div>
      </div>
    </div>
  );
}
