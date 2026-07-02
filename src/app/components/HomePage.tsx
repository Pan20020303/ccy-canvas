import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, Image as ImageIcon, LogOut, Plus, Shield, Zap } from 'lucide-react';

import { useAuth } from '../auth/AuthProvider';
import { useStore } from '../store';
import logoUrl from '../../imports/logo.png';

/**
 * 首页 — 全部项目. Project creation and switching moved OUT of the canvas dock
 * and live here: the canvas (/app) is entered by clicking a project card or
 * the 开始创作 card.
 *
 * Visual language: monochrome "moonlit" dark (near-black ground, a faint
 * top-center glow, silver-white accents) — full-bleed header, centered grid.
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
    <div className="relative min-h-screen bg-[#08090b] text-neutral-100">
      {/* Ambient moonlight: a faint top-center glow + corner falloff, echoing
          the monochrome mountain reference. Pure decoration. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_100%_at_50%_0%,rgba(255,255,255,0.07),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_120%,rgba(0,0,0,0.55),transparent_60%)]" />

      {/* Full-bleed header — spans the whole viewport width; only the grid
          below is width-constrained. */}
      <header className="relative z-10 w-full border-b border-white/[0.05] bg-black/25 backdrop-blur-xl">
        <div className="flex h-16 w-full items-center justify-between px-8">
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
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-xs text-neutral-100">
                      {user.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                </button>
                {menuOpen ? (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-white/10 bg-[#101114]/95 py-1.5 shadow-2xl backdrop-blur-xl">
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
      </header>

      {/* 全部项目 — width-constrained grid under the full-bleed header. */}
      <main className="relative z-10 mx-auto max-w-[1280px] px-8 pb-20 pt-10">
        <div className="mb-7 flex items-baseline gap-3">
          <h1 className="text-[19px] font-semibold tracking-wide text-neutral-100">{zh ? '全部项目' : 'All projects'}</h1>
          <span className="text-[12px] text-neutral-600">{projects.length}</span>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-x-5 gap-y-8">
          {/* 开始创作 */}
          <div>
            <button
              type="button"
              onClick={() => void startCreating()}
              disabled={busyId !== null}
              className="group flex aspect-[16/10] w-full flex-col items-center justify-center gap-2.5 rounded-2xl border border-white/[0.14] bg-gradient-to-b from-white/[0.06] to-white/[0.015] text-neutral-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-white/30 hover:from-white/[0.09] hover:shadow-[0_18px_50px_-20px_rgba(255,255,255,0.12)] disabled:opacity-60"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/[0.05] transition group-hover:border-white/30 group-hover:bg-white/[0.1]">
                <Plus className="h-4.5 w-4.5" />
              </span>
              <span className="text-[13px] tracking-wide">{zh ? '开始创作' : 'Start creating'}</span>
            </button>
            <div className="mt-3 px-0.5 text-[12.5px] text-neutral-500">
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
                  className={`group relative block aspect-[16/10] w-full overflow-hidden rounded-2xl border transition disabled:opacity-60 ${
                    isActive
                      ? 'border-white/25 shadow-[0_18px_50px_-20px_rgba(255,255,255,0.14)]'
                      : 'border-white/[0.07] hover:border-white/20 hover:shadow-[0_18px_50px_-24px_rgba(255,255,255,0.1)]'
                  }`}
                >
                  {/* Cover placeholder — layered monochrome gradients with a
                      faint "ridge line" highlight, after the mountain art.
                      (The project list API carries no cover field yet.) */}
                  <div className="absolute inset-0 bg-gradient-to-b from-[#17181c] via-[#101114] to-[#0a0b0d]" />
                  <div className="absolute inset-0 bg-[radial-gradient(70%_55%_at_50%_12%,rgba(255,255,255,0.08),transparent_65%)] opacity-80 transition-opacity group-hover:opacity-100" />
                  <div className="absolute inset-x-0 bottom-0 h-1/3 bg-[radial-gradient(60%_120%_at_50%_130%,rgba(0,0,0,0.6),transparent)]" />
                  <div className="relative flex h-full w-full items-center justify-center text-neutral-700 transition group-hover:text-neutral-500">
                    <ImageIcon className="h-8 w-8" />
                  </div>
                  {isActive ? (
                    <div className="absolute left-2.5 top-2.5 flex items-center gap-1 rounded-full border border-white/15 bg-black/50 px-2 py-0.5 text-[10px] text-neutral-100 backdrop-blur">
                      <Check className="h-3 w-3" />
                      {zh ? '当前' : 'Current'}
                    </div>
                  ) : null}
                  {busyId === project.id ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[12px] text-neutral-200 backdrop-blur-[2px]">
                      {zh ? '打开中…' : 'Opening…'}
                    </div>
                  ) : null}
                </button>
                <div className="mt-3 min-w-0 px-0.5">
                  <div className="truncate text-[13px] text-neutral-200">
                    {project.name.trim() || (zh ? '未命名项目' : 'Untitled Project')}
                  </div>
                  <div className="mt-1 text-[11px] tabular-nums text-neutral-600">{formatDate(project.createdAt, zh)}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-16 text-center text-[12px] text-neutral-700">{zh ? '没有更多了' : 'No more projects'}</div>
      </main>
    </div>
  );
}
