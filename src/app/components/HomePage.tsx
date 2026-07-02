import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Shield,
  Trash2,
  Zap,
} from 'lucide-react';

import {
  createFolder as apiCreateFolder,
  deleteFolder as apiDeleteFolder,
  deleteProject as apiDeleteProject,
  duplicateProject as apiDuplicateProject,
  listFolders,
  updateProject as apiUpdateProject,
  uploadFile,
  type BackendFolder,
} from '../api/projects';
import { useAuth } from '../auth/AuthProvider';
import { MediaThumb } from './MediaThumb';
import { useStore } from '../store';
import logoUrl from '../../imports/logo.png';

/**
 * 首页 — 全部项目. Project creation / switching / management (rename, cover,
 * duplicate, folders, delete) all live here; the canvas (/app) is entered by
 * opening a project.
 *
 * Visual language: graphite "premium dark" — layered charcoal ground with a
 * soft top glow, silver-white accents, full-bleed header + centered grid.
 */

const formatDate = (timestamp: number, zh: boolean) =>
  new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(timestamp)
    .replaceAll('/', '-');

type CardMenuState = { projectId: string; submenu: boolean } | null;

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
  const loadBackendProjects = useStore((s) => s.loadBackendProjects);
  const refreshBackendProjects = useStore((s) => s.refreshBackendProjects);
  const zh = language === 'zh';

  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [folders, setFolders] = useState<BackendFolder[]>([]);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [cardMenu, setCardMenu] = useState<CardMenuState>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverTargetRef = useRef<string | null>(null);

  const hasBackend = backendProjects.length > 0;

  const refreshFolders = async () => {
    try {
      setFolders(await listFolders());
    } catch { /* best-effort */ }
  };

  useEffect(() => {
    void refreshFolders();
    void refreshBackendProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close any card menu on outside click.
  useEffect(() => {
    if (!cardMenu) return;
    const onDown = () => setCardMenu(null);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [cardMenu]);

  const projects = useMemo(() => (
    hasBackend
      ? backendProjects.map((project) => ({
        id: project.id,
        name: project.name,
        coverUrl: project.cover_url ?? '',
        folderId: project.folder_id ?? '',
        createdAt: new Date(project.created_at).getTime(),
        updatedAt: new Date(project.updated_at).getTime(),
      }))
      : localProjects.map((project) => ({ ...project, coverUrl: '', folderId: '' }))
  ), [hasBackend, backendProjects, localProjects]);
  const effectiveActiveProjectId = activeBackendProjectId ?? activeProjectId;

  const visibleProjects = useMemo(
    () => projects.filter((p) => (openFolderId ? p.folderId === openFolderId : !p.folderId)),
    [projects, openFolderId],
  );
  const openFolder = openFolderId ? folders.find((f) => f.id === openFolderId) ?? null : null;

  const openProject = async (projectId: string) => {
    if (busyId) return;
    setBusyId(projectId);
    try {
      if (hasBackend) {
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
      if (hasBackend || user) {
        const created = await createBackendProject(zh ? '未命名项目' : 'Untitled Project');
        if (!created) createProject(zh ? '未命名项目' : undefined);
        else if (openFolderId) {
          // Creating inside a folder files the new project there directly.
          await apiUpdateProject(created.id, { folder_id: openFolderId }).catch(() => {});
          await refreshBackendProjects();
        }
      } else {
        createProject(zh ? '未命名项目' : undefined);
      }
      navigate('/app');
    } finally {
      setBusyId(null);
    }
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameTarget.name.trim();
    setRenameTarget(null);
    if (!name) return;
    await apiUpdateProject(renameTarget.id, { name }).catch(() => {});
    await refreshBackendProjects();
  };

  const submitCreateFolder = async () => {
    const name = folderName.trim();
    setCreatingFolder(false);
    setFolderName('');
    if (!name) return;
    await apiCreateFolder(name).catch(() => {});
    await refreshFolders();
  };

  const handleDuplicate = async (projectId: string) => {
    setBusyId(projectId);
    try {
      await apiDuplicateProject(projectId);
      await refreshBackendProjects();
    } catch { /* best-effort */ } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (projectId: string) => {
    const ok = window.confirm(zh ? '删除该项目？画布内容将一并删除，不可恢复。' : 'Delete this project? Its canvas is removed permanently.');
    if (!ok) return;
    setBusyId(projectId);
    try {
      await apiDeleteProject(projectId);
      if (projectId === activeBackendProjectId) {
        // Deleted the active project — do a full reload so the canvas
        // re-anchors onto the first remaining project.
        await loadBackendProjects();
      } else {
        await refreshBackendProjects();
      }
    } catch { /* best-effort */ } finally {
      setBusyId(null);
    }
  };

  const handleMoveToFolder = async (projectId: string, folderId: string) => {
    await apiUpdateProject(projectId, { folder_id: folderId }).catch(() => {});
    await refreshBackendProjects();
  };

  const handleDeleteFolder = async (folderId: string) => {
    const ok = window.confirm(zh ? '删除该文件夹？其中的项目会回到全部项目。' : 'Delete this folder? Its projects return to the root level.');
    if (!ok) return;
    await apiDeleteFolder(folderId).catch(() => {});
    if (openFolderId === folderId) setOpenFolderId(null);
    await Promise.all([refreshFolders(), refreshBackendProjects()]);
  };

  const pickCover = (projectId: string) => {
    coverTargetRef.current = projectId;
    coverInputRef.current?.click();
  };

  const onCoverFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const projectId = coverTargetRef.current;
    coverTargetRef.current = null;
    if (!file || !projectId) return;
    setBusyId(projectId);
    try {
      const uploaded = await uploadFile(file, file.name);
      await apiUpdateProject(projectId, { cover_url: uploaded.url });
      await refreshBackendProjects();
    } catch { /* best-effort */ } finally {
      setBusyId(null);
    }
  };

  const menuItemCls = 'flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] text-neutral-300 transition hover:bg-white/[0.06] hover:text-neutral-100';

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-[#111216] via-[#0d0e11] to-[#0a0b0d] text-neutral-100">
      {/* Ambient light: a soft top-center glow over layered charcoal — the
          "premium dark" read instead of flat black. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(55%_90%_at_50%_0%,rgba(255,255,255,0.08),transparent_70%)]" />

      <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onCoverFile(e)} />

      {/* Full-bleed header. */}
      <header className="relative z-20 w-full border-b border-white/[0.06] bg-white/[0.015] backdrop-blur-xl">
        <div className="flex h-16 w-full items-center justify-between px-8">
          <div className="flex items-center gap-2.5">
            <img src={logoUrl} alt="CCY Canvas" className="h-7 w-7 rounded object-contain" />
            <span className="text-[15px] font-semibold tracking-wide">CCY Canvas</span>
          </div>
          <div className="flex items-center gap-3">
            {user && creditSummary ? (
              <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] text-neutral-300">
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
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] transition hover:bg-white/[0.1]"
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
                    <div className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-white/10 bg-[#16171b]/95 py-1.5 shadow-2xl backdrop-blur-xl">
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

      <main className="relative z-10 mx-auto max-w-[1280px] px-8 pb-20 pt-9">
        {/* Title row: breadcrumb (root / folder) + 新建文件夹 */}
        <div className="mb-7 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {openFolder ? (
              <button
                type="button"
                onClick={() => setOpenFolderId(null)}
                className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] text-neutral-300 transition hover:bg-white/[0.08] hover:text-neutral-100"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                {zh ? '返回' : 'Back'}
              </button>
            ) : null}
            <h1 className="text-[19px] font-semibold tracking-wide text-neutral-100">
              {openFolder ? openFolder.name : (zh ? '全部项目' : 'All projects')}
            </h1>
            <span className="text-[12px] text-neutral-600">{visibleProjects.length}</span>
          </div>
          {!openFolder && hasBackend ? (
            creatingFolder ? (
              <div className="flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] py-1 pl-4 pr-1">
                <input
                  autoFocus
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitCreateFolder();
                    if (e.key === 'Escape') { setCreatingFolder(false); setFolderName(''); }
                  }}
                  placeholder={zh ? '文件夹名称' : 'Folder name'}
                  className="w-40 bg-transparent text-[12.5px] text-neutral-100 outline-none placeholder:text-neutral-600"
                />
                <button
                  type="button"
                  onClick={() => void submitCreateFolder()}
                  className="rounded-full bg-white px-3 py-1 text-[12px] font-medium text-black transition hover:bg-neutral-200"
                >
                  {zh ? '创建' : 'Create'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreatingFolder(true)}
                className="flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3.5 py-1.5 text-[12px] text-neutral-300 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-neutral-100"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                {zh ? '新建文件夹' : 'New folder'}
              </button>
            )
          ) : null}
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-x-5 gap-y-8">
          {/* 开始创作 */}
          <div>
            <button
              type="button"
              onClick={() => void startCreating()}
              disabled={busyId !== null}
              className="group flex aspect-[16/10] w-full flex-col items-center justify-center gap-2.5 rounded-2xl border border-white/[0.14] bg-gradient-to-b from-white/[0.07] to-white/[0.02] text-neutral-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition hover:border-white/30 hover:from-white/[0.1] hover:shadow-[0_18px_50px_-20px_rgba(255,255,255,0.12)] disabled:opacity-60"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] transition group-hover:border-white/30 group-hover:bg-white/[0.12]">
                <Plus className="h-4.5 w-4.5" />
              </span>
              <span className="text-[13px] tracking-wide">{zh ? '开始创作' : 'Start creating'}</span>
            </button>
            <div className="mt-3 px-0.5 text-[12.5px] text-neutral-500">
              {openFolder
                ? (zh ? '在此文件夹中新建项目' : 'Create a project in this folder')
                : (zh ? '创建新的画布项目' : 'Create a new canvas project')}
            </div>
          </div>

          {/* 文件夹卡片（仅根层级） */}
          {!openFolder ? folders.map((folder) => (
            <div key={folder.id} className="group/folder">
              <button
                type="button"
                onClick={() => setOpenFolderId(folder.id)}
                className="group relative block aspect-[16/10] w-full overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-[#1b1d22] to-[#121316] transition hover:border-white/20 hover:shadow-[0_18px_50px_-24px_rgba(255,255,255,0.1)]"
              >
                {/* 文件夹页签造型 */}
                <div className="absolute left-5 top-5 h-2.5 w-16 rounded-t-md bg-white/[0.09]" />
                <div className="absolute inset-x-5 bottom-5 top-7 rounded-xl border border-white/[0.07] bg-gradient-to-b from-white/[0.07] to-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]" />
                <Folder className="absolute bottom-8 right-8 h-7 w-7 text-neutral-600 transition group-hover:text-neutral-400" />
              </button>
              <div className="mt-3 flex items-start justify-between gap-2 px-0.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-[13px] text-neutral-200">
                    {folder.name}
                    <span className="text-[10.5px] text-neutral-600">
                      {projects.filter((p) => p.folderId === folder.id).length}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] tabular-nums text-neutral-600">{formatDate(new Date(folder.created_at).getTime(), zh)}</div>
                </div>
                <button
                  type="button"
                  title={zh ? '删除文件夹' : 'Delete folder'}
                  onClick={() => void handleDeleteFolder(folder.id)}
                  className="mt-0.5 rounded-md p-1 text-neutral-600 opacity-0 transition hover:bg-white/10 hover:text-rose-300 group-hover/folder:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )) : null}

          {visibleProjects.map((project) => {
            const isActive = project.id === effectiveActiveProjectId;
            const menuVisible = cardMenu?.projectId === project.id;
            return (
              <div key={project.id} className="group/card">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => void openProject(project.id)}
                    disabled={busyId !== null}
                    className={`relative block aspect-[16/10] w-full overflow-hidden rounded-2xl border transition disabled:opacity-60 ${
                      isActive
                        ? 'border-white/25 shadow-[0_18px_50px_-20px_rgba(255,255,255,0.16)]'
                        : 'border-white/[0.08] hover:border-white/20 hover:shadow-[0_18px_50px_-24px_rgba(255,255,255,0.1)]'
                    }`}
                  >
                    {project.coverUrl ? (
                      <MediaThumb src={project.coverUrl} alt={project.name} className="h-full w-full object-cover" />
                    ) : (
                      <>
                        <div className="absolute inset-0 bg-gradient-to-b from-[#1c1d22] via-[#141519] to-[#0e0f12]" />
                        <div className="absolute inset-0 bg-[radial-gradient(70%_55%_at_50%_12%,rgba(255,255,255,0.09),transparent_65%)] opacity-80 transition-opacity group-hover/card:opacity-100" />
                        <div className="relative flex h-full w-full items-center justify-center text-neutral-700 transition group-hover/card:text-neutral-500">
                          <ImageIcon className="h-8 w-8" />
                        </div>
                      </>
                    )}
                    {isActive ? (
                      <div className="absolute left-2.5 top-2.5 flex items-center gap-1 rounded-full border border-white/15 bg-black/55 px-2 py-0.5 text-[10px] text-neutral-100 backdrop-blur">
                        <Check className="h-3 w-3" />
                        {zh ? '当前' : 'Current'}
                      </div>
                    ) : null}
                    {busyId === project.id ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[12px] text-neutral-200 backdrop-blur-[2px]">
                        {zh ? '处理中…' : 'Working…'}
                      </div>
                    ) : null}
                  </button>
                </div>

                <div className="mt-3 flex items-start justify-between gap-2 px-0.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-neutral-200">
                      {project.name.trim() || (zh ? '未命名项目' : 'Untitled Project')}
                    </div>
                    <div className="mt-1 text-[11px] tabular-nums text-neutral-600">{formatDate(project.createdAt, zh)}</div>
                  </div>
                  {hasBackend ? (
                    <div className="relative">
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => setCardMenu(menuVisible ? null : { projectId: project.id, submenu: false })}
                        className={`mt-0.5 rounded-md p-1 transition hover:bg-white/10 hover:text-neutral-200 ${menuVisible ? 'text-neutral-200' : 'text-neutral-600 opacity-0 group-hover/card:opacity-100'}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {menuVisible ? (
                        <div
                          onMouseDown={(e) => e.stopPropagation()}
                          className="absolute right-0 top-full z-50 mt-1 w-44 rounded-xl border border-white/10 bg-[#17181d]/97 py-1.5 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl"
                        >
                          <button type="button" className={menuItemCls} onClick={() => { setCardMenu(null); void openProject(project.id); }}>
                            <ChevronRight className="h-3.5 w-3.5 text-neutral-500" />
                            {zh ? '打开' : 'Open'}
                          </button>
                          <button type="button" className={menuItemCls} onClick={() => { setCardMenu(null); setRenameTarget({ id: project.id, name: project.name }); }}>
                            <Pencil className="h-3.5 w-3.5 text-neutral-500" />
                            {zh ? '重命名' : 'Rename'}
                          </button>
                          <button type="button" className={menuItemCls} onClick={() => { setCardMenu(null); pickCover(project.id); }}>
                            <ImageIcon className="h-3.5 w-3.5 text-neutral-500" />
                            {zh ? '修改封面' : 'Change cover'}
                          </button>
                          <button type="button" className={menuItemCls} onClick={() => { setCardMenu(null); void handleDuplicate(project.id); }}>
                            <Copy className="h-3.5 w-3.5 text-neutral-500" />
                            {zh ? '创建副本' : 'Duplicate'}
                          </button>
                          <div
                            className="relative"
                            onMouseEnter={() => setCardMenu({ projectId: project.id, submenu: true })}
                            onMouseLeave={() => setCardMenu({ projectId: project.id, submenu: false })}
                          >
                            <button type="button" className={menuItemCls}>
                              <FolderInput className="h-3.5 w-3.5 text-neutral-500" />
                              <span className="flex-1">{zh ? '移动至文件夹' : 'Move to folder'}</span>
                              <ChevronRight className="h-3.5 w-3.5 text-neutral-600" />
                            </button>
                            {cardMenu?.submenu ? (
                              <div className="absolute left-full top-0 z-50 ml-1 w-44 rounded-xl border border-white/10 bg-[#17181d]/97 py-1.5 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl">
                                {folders.length === 0 ? (
                                  <div className="px-3.5 py-2 text-[12px] text-neutral-600">{zh ? '还没有文件夹' : 'No folders yet'}</div>
                                ) : folders.map((folder) => (
                                  <button
                                    key={folder.id}
                                    type="button"
                                    className={menuItemCls}
                                    onClick={() => { setCardMenu(null); void handleMoveToFolder(project.id, folder.id); }}
                                  >
                                    <Folder className="h-3.5 w-3.5 text-neutral-500" />
                                    <span className="flex-1 truncate">{folder.name}</span>
                                    {project.folderId === folder.id ? <Check className="h-3 w-3 text-neutral-400" /> : null}
                                  </button>
                                ))}
                                {project.folderId ? (
                                  <button
                                    type="button"
                                    className={menuItemCls}
                                    onClick={() => { setCardMenu(null); void handleMoveToFolder(project.id, ''); }}
                                  >
                                    <ChevronLeft className="h-3.5 w-3.5 text-neutral-500" />
                                    {zh ? '移出文件夹' : 'Move to root'}
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          <div className="my-1 border-t border-white/[0.06]" />
                          <button
                            type="button"
                            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] text-rose-300/90 transition hover:bg-rose-500/10 hover:text-rose-300"
                            onClick={() => { setCardMenu(null); void handleDelete(project.id); }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {zh ? '删除项目' : 'Delete project'}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-16 text-center text-[12px] text-neutral-700">{zh ? '没有更多了' : 'No more projects'}</div>
      </main>

      {/* 重命名弹层 */}
      {renameTarget ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setRenameTarget(null)}>
          <div
            className="w-[380px] rounded-2xl border border-white/10 bg-[#16171b] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-[14px] font-medium text-neutral-100">{zh ? '重命名项目' : 'Rename project'}</div>
            <input
              autoFocus
              value={renameTarget.name}
              onChange={(e) => setRenameTarget((t) => (t ? { ...t, name: e.target.value } : t))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename();
                if (e.key === 'Escape') setRenameTarget(null);
              }}
              className="w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-white/30"
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
              >
                {zh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => void submitRename()}
                className="rounded-lg bg-white px-3.5 py-1.5 text-xs font-medium text-black transition hover:bg-neutral-200"
              >
                {zh ? '确定' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
