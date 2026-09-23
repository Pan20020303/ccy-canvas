import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';

import {
  createFolder as apiCreateFolder,
  deleteFolder as apiDeleteFolder,
  deleteProject as apiDeleteProject,
  duplicateProject as apiDuplicateProject,
  listFolders,
  listTemplates,
  setProjectTemplate as apiSetProjectTemplate,
  updateProject as apiUpdateProject,
  uploadFile,
  type BackendFolder,
  type CanvasTemplate,
} from '../api/projects';
import { useAuth } from '../auth/AuthProvider';
import { MediaThumb } from './MediaThumb';
import BorderGlow from './reactbits/BorderGlow';
import { DestructiveConfirmDialog } from './ui/destructive-confirm-dialog';
import { useStore } from '../store';
import { toast } from 'sonner';


/** Shared BorderGlow tuning — cool silver light on BORDERLESS cards
 *  (reference style): no resting border, the glow only materializes on hover. */
const CARD_GLOW = {
  edgeSensitivity: 25,
  glowColor: '210 30 85',
  borderRadius: 10,
  glowRadius: 26,
  glowIntensity: 0.9,
  coneSpread: 22,
  fillOpacity: 0.3,
  colors: ['#e2e8f0', '#a5b4fc', '#7dd3fc'],
} as const;

/**
 * 无限画布列表. Project creation / switching / management (rename, cover,
 * duplicate, folders, delete) all live here; the canvas (/app) is entered by
 * opening a project.
 *
 * Mounted inside the shared home shell. Existing project operations stay here.
 */

const formatDate = (timestamp: number, zh: boolean) =>
  new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(timestamp)
    .replaceAll('/', '-');

type CardMenuState = { projectId: string; submenu: boolean } | null;
type DeleteTarget = { kind: 'project' | 'folder'; id: string; name: string } | null;

export function CanvasLibrary() {
  const navigate = useNavigate();
  const { user, refreshCredits } = useAuth();
  const language = useStore((s) => s.language);
  const theme = useStore((s) => s.theme);
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
  const light = theme === 'light';

  const [busyId, setBusyId] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const [folders, setFolders] = useState<BackendFolder[]>([]);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [cardMenu, setCardMenu] = useState<CardMenuState>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  // 个人 / 协作 画布切换 + 搜索(参考图五)。协作态来自后端 is_collaborative。
  const [collabTab, setCollabTab] = useState<'all' | 'personal' | 'collab'>('all');
  const [search, setSearch] = useState('');
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverTargetRef = useRef<string | null>(null);

  const hasBackend = Boolean(user);

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
        isCollaborative: project.is_collaborative ?? false,
        myRole: project.my_role,
        createdAt: new Date(project.created_at).getTime(),
        updatedAt: new Date(project.updated_at).getTime(),
      }))
      : localProjects.map((project) => ({ ...project, coverUrl: '', folderId: '', isCollaborative: false, myRole: undefined }))
  ), [hasBackend, backendProjects, localProjects]);
  const effectiveActiveProjectId = activeBackendProjectId ?? activeProjectId;

  const visibleProjects = useMemo(
    () => projects.filter((p) => {
      if (openFolderId ? p.folderId !== openFolderId : Boolean(p.folderId)) return false;
      if (collabTab === 'personal' && p.isCollaborative) return false;
      if (collabTab === 'collab' && !p.isCollaborative) return false;
      const q = search.trim().toLowerCase();
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    }),
    [projects, openFolderId, collabTab, search],
  );
  const openFolder = openFolderId ? folders.find((f) => f.id === openFolderId) ?? null : null;

  // Keep the dense reference-style grid usable for larger project libraries.
  const PAGE_SIZE = 24;
  const totalPages = Math.max(1, Math.ceil(visibleProjects.length / PAGE_SIZE));
  useEffect(() => { setPage(1); }, [openFolderId, collabTab, search]);
  useEffect(() => { setPage((p) => Math.min(p, totalPages)); }, [totalPages]);
  const pagedProjects = useMemo(
    () => visibleProjects.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [visibleProjects, page],
  );
  const paginationPages = useMemo(() => {
    if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
    const start = Math.max(1, Math.min(page - 2, totalPages - 4));
    return Array.from({ length: 5 }, (_, index) => start + index);
  }, [page, totalPages]);

  const changePage = (nextPage: number) => {
    const safePage = Math.max(1, Math.min(totalPages, nextPage));
    if (safePage === page) return;
    setPage(safePage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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
    } catch {
      toast.error(zh ? '打开画布失败，请稍后重试。' : 'Unable to open canvas.');
    } finally {
      setBusyId(null);
    }
  };

  // 画布模板墙:全站公开模板,点「使用」即复制成我的项目并打开。
  const [templates, setTemplates] = useState<CanvasTemplate[]>([]);
  const templateIds = useMemo(() => new Set(templates.map((t) => t.id)), [templates]);
  const refreshTemplates = useCallback(async () => {
    if (!user) return;
    try { setTemplates(await listTemplates()); } catch { /* 非致命:模板墙静默降级为空 */ }
  }, [user]);
  useEffect(() => { void refreshTemplates(); }, [refreshTemplates]);

  // 管理员:把某项目标记/取消为模板,即时刷新模板墙。
  const toggleTemplate = async (projectId: string, makeTemplate: boolean) => {
    try {
      await apiSetProjectTemplate(projectId, makeTemplate);
      await refreshTemplates();
    } catch { toast.error(zh ? '模板设置失败，请稍后重试。' : 'Could not update template status.'); }
  };

  const startCreating = async () => {
    if (busyId || creatingRef.current) return;
    creatingRef.current = true;
    setBusyId('__create__');
    try {
      if (hasBackend || user) {
        const created = await createBackendProject(zh ? '未命名项目' : 'Untitled Project');
        if (!created) throw new Error(zh ? '创建画布失败，请稍后重试。' : 'Could not create canvas.');
        else if (openFolderId) {
          // Creating inside a folder files the new project there directly.
          await apiUpdateProject(created.id, { folder_id: openFolderId }).catch(() => {});
          await refreshBackendProjects();
        }
      } else {
        createProject(zh ? '未命名项目' : undefined);
      }
      navigate('/app');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (zh ? '创建失败，请重试。' : 'Creation failed.'));
    } finally {
      creatingRef.current = false;
      setBusyId(null);
    }
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameTarget.name.trim();
    if (!name) return;
    try {
      await apiUpdateProject(renameTarget.id, { name });
      setRenameTarget(null);
      await refreshBackendProjects();
    } catch { toast.error(zh ? '重命名失败，请重试。' : 'Could not rename canvas.'); }
  };

  const submitCreateFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    try {
      await apiCreateFolder(name);
      setCreatingFolder(false);
      setFolderName('');
      await refreshFolders();
    } catch { toast.error(zh ? '创建文件夹失败，请重试。' : 'Could not create folder.'); }
  };

  const handleDuplicate = async (projectId: string) => {
    setBusyId(projectId);
    try {
      await apiDuplicateProject(projectId);
      await refreshBackendProjects();
    } catch { toast.error(zh ? '复制画布失败，请重试。' : 'Could not duplicate canvas.'); } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (projectId: string) => {
    setBusyId(projectId);
    try {
      const result = await apiDeleteProject(projectId);
      if (result.refunded_credits > 0) await refreshCredits();
      if (projectId === activeBackendProjectId) {
        // Deleted the active project — do a full reload so the canvas
        // re-anchors onto the first remaining project.
        await loadBackendProjects();
      } else {
        await refreshBackendProjects();
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleMoveToFolder = async (projectId: string, folderId: string) => {
    try {
      await apiUpdateProject(projectId, { folder_id: folderId });
      await refreshBackendProjects();
    } catch { toast.error(zh ? '移动画布失败，请重试。' : 'Could not move canvas.'); }
  };

  const handleDeleteFolder = async (folderId: string) => {
    await apiDeleteFolder(folderId);
    if (openFolderId === folderId) setOpenFolderId(null);
    await Promise.all([refreshFolders(), refreshBackendProjects()]);
  };

  const confirmDeleteTarget = async () => {
    const target = deleteTarget;
    if (!target || deleteBusy) return;
    setDeleteBusy(true);
    try {
      if (target.kind === 'project') await handleDelete(target.id);
      else await handleDeleteFolder(target.id);
      setDeleteTarget(null);
    } catch {
      toast.error(zh ? '删除结果未能确认，请刷新列表后检查。' : 'Could not confirm deletion. Refresh the list to check.');
    } finally {
      setDeleteBusy(false);
    }
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
    } catch { toast.error(zh ? '封面更新失败，请重试。' : 'Could not update the cover.'); } finally {
      setBusyId(null);
    }
  };

  const menuItemCls = 'flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] text-neutral-300 transition hover:bg-white/[0.06] hover:text-neutral-100';

  return (
    <div className="canvas-library">
      <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onCoverFile(e)} />
      <main className="canvas-library-main">
        {/* Title row: breadcrumb (root / folder) + 新建文件夹 */}
        <div className="canvas-library-heading">
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
              {openFolder ? openFolder.name : (zh ? '无限画布' : 'Infinite canvas')}
            </h1>
            <span className="text-[12px] text-neutral-500">{visibleProjects.length}</span>
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
                  aria-label={zh ? '文件夹名称' : 'Folder name'}
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

        {/* 个人 / 协作 切换 + 搜索(参考图五) */}
        {!openFolder ? (
          <div className="canvas-library-toolbar">
            <div className={clsx(
              'flex items-center gap-1 rounded-full border p-0.5',
              light ? 'border-black/10 bg-black/[0.035]' : 'border-white/10 bg-white/[0.045]',
            )}>
              {([['all', zh ? '全部' : 'All'], ['personal', zh ? '个人' : 'Personal'], ['collab', zh ? '协作' : 'Collab']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCollabTab(key)}
                  className={clsx(
                    'rounded-full px-4 py-1.5 text-[12.5px] transition',
                    collabTab === key
                      ? (light ? 'bg-white text-[#1c1f24] shadow-sm' : 'bg-white/12 text-white')
                      : 'text-neutral-400 hover:text-neutral-200',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={zh ? '搜索' : 'Search'}
                aria-label={zh ? '搜索所有画布' : 'Search all canvases'}
                className="w-56 rounded-full border border-white/12 bg-white/[0.045] py-1.5 pl-9 pr-3 text-[12.5px] text-neutral-100 outline-none transition placeholder:text-neutral-500 focus:border-white/25"
              />
            </div>
          </div>
        ) : null}

        <div className="canvas-library-grid">
          {/* 开始创作 — 参考风格：虚线空卡，无实体边框底。 */}
          <div className="canvas-library-create">
            <button
              type="button"
              onClick={startCreating}
              disabled={busyId !== null}
              className={clsx(
                'group flex aspect-[16/10] w-full flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed text-neutral-200 transition disabled:opacity-60',
                light
                  ? 'border-black/15 bg-white/65 shadow-[0_8px_28px_rgba(31,41,55,0.04)] hover:border-black/25 hover:bg-white'
                  : 'border-white/25 bg-white/[0.055] hover:border-white/45 hover:bg-white/[0.09]',
              )}
            >
              <span className={clsx(
                'flex h-10 w-10 items-center justify-center rounded-full transition',
                light ? 'bg-black/[0.05] group-hover:bg-black/[0.09]' : 'bg-white/[0.09] group-hover:bg-white/[0.16]',
              )}>
                <Plus className="h-4.5 w-4.5" />
              </span>
              <span className="text-[13px] tracking-wide">{zh ? '新建无限画布' : 'New canvas'}</span>
            </button>
            <div className="mt-3 px-0.5 text-[12.5px] text-neutral-400">
              {openFolder
                ? (zh ? '在此文件夹中新建项目' : 'Create a project in this folder')
                : (zh ? '创建新的画布项目' : 'Create a new canvas project')}
            </div>
          </div>

          {/* 文件夹卡片（仅根层级） */}
          {!openFolder ? folders.map((folder) => (
            <div key={folder.id} className="canvas-library-card group/folder">
              <BorderGlow {...CARD_GLOW} backgroundColor={light ? '#ffffff' : '#26282f'} className="!border-transparent">
                <button
                  type="button"
                  onClick={() => setOpenFolderId(folder.id)}
                  aria-label={`${zh ? '打开文件夹' : 'Open folder'}：${folder.name}`}
                  className={clsx(
                    'group relative block aspect-[16/10] w-full overflow-hidden bg-gradient-to-b transition',
                    light ? 'from-white to-[#e9edf2]' : 'from-[#30323a] to-[#22242b]',
                  )}
                >
                  {/* 文件夹页签造型 */}
                  <div className={clsx(
                    'absolute left-5 top-5 h-2.5 w-16 rounded-t-md',
                    light ? 'bg-black/[0.07]' : 'bg-white/[0.12]',
                  )} />
                  <div className={clsx(
                    'absolute inset-x-5 bottom-5 top-7 rounded-xl bg-gradient-to-b',
                    light
                      ? 'from-black/[0.06] to-black/[0.025] shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]'
                      : 'from-white/[0.1] to-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]',
                  )} />
                  <Folder className="absolute bottom-8 right-8 h-7 w-7 text-neutral-500 transition group-hover:text-neutral-300" />
                </button>
              </BorderGlow>
              <div className="mt-3 flex items-start justify-between gap-2 px-0.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-[13px] text-neutral-100">
                    {folder.name}
                    <span className="text-[10.5px] text-neutral-500">
                      {projects.filter((p) => p.folderId === folder.id).length}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] tabular-nums text-neutral-500">{formatDate(new Date(folder.created_at).getTime(), zh)}</div>
                </div>
                <button
                  type="button"
                  title={zh ? '删除文件夹' : 'Delete folder'}
                  onClick={() => setDeleteTarget({ kind: 'folder', id: folder.id, name: folder.name })}
                  className="mt-0.5 rounded-md p-1 text-neutral-600 opacity-0 transition hover:bg-white/10 hover:text-rose-300 group-hover/folder:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )) : null}

          {pagedProjects.map((project) => {
            const isActive = project.id === effectiveActiveProjectId;
            const menuVisible = cardMenu?.projectId === project.id;
            return (
              <div key={project.id} className="canvas-library-card group/card">
                <BorderGlow
                  {...CARD_GLOW}
                  backgroundColor={light ? '#ffffff' : '#24262d'}
                  className={clsx(
                    '!border-transparent',
                    isActive && (light ? 'ring-1 ring-black/20' : 'ring-1 ring-white/30'),
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void openProject(project.id)}
                    aria-label={`${zh ? '打开画布' : 'Open canvas'}：${project.name}`}
                    disabled={busyId !== null}
                    className="relative block aspect-[16/10] w-full overflow-hidden transition disabled:opacity-60"
                  >
                    {project.coverUrl ? (
                      <MediaThumb src={project.coverUrl} alt={project.name} className="h-full w-full object-cover" />
                    ) : (
                      <>
                        <div className={clsx(
                          'absolute inset-0 bg-gradient-to-b',
                          light ? 'from-white via-[#f4f6f8] to-[#e8ecf1]' : 'from-[#30323a] via-[#25272e] to-[#1f2127]',
                        )} />
                        <div
                          className="absolute inset-0 opacity-80 transition-opacity group-hover/card:opacity-100"
                          style={{
                            backgroundImage: light
                              ? 'radial-gradient(70% 55% at 50% 12%, rgba(255,255,255,0.85), transparent 65%)'
                              : 'radial-gradient(70% 55% at 50% 12%, rgba(255,255,255,0.16), transparent 65%)',
                          }}
                        />
                        <div className="relative flex h-full w-full items-center justify-center text-neutral-600 transition group-hover/card:text-neutral-400">
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
                    {/* 协作画布标记(参考图五) */}
                    {project.isCollaborative ? (
                      <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1 rounded-full border border-[#8b5cf6]/40 bg-[#8b5cf6]/30 px-2 py-0.5 text-[10px] text-purple-100 backdrop-blur">
                        <Users className="h-3 w-3" />
                        {zh ? '协作' : 'Collab'}
                      </div>
                    ) : null}
                    {busyId === project.id ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[12px] text-neutral-200 backdrop-blur-[2px]">
                        {zh ? '处理中…' : 'Working…'}
                      </div>
                    ) : null}
                  </button>
                </BorderGlow>

                <div className="mt-3 flex items-start justify-between gap-2 px-0.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-neutral-100">
                      {project.name.trim() || (zh ? '未命名项目' : 'Untitled Project')}
                    </div>
                    <div className="mt-1 text-[11px] tabular-nums text-neutral-500">{formatDate(project.createdAt, zh)}</div>
                  </div>
                  {hasBackend ? (
                    <div className="relative">
                      <button
                        type="button"
                        aria-label={zh ? `${project.name || '未命名项目'}更多操作` : `More actions for ${project.name || 'Untitled Project'}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => setCardMenu(menuVisible ? null : { projectId: project.id, submenu: false })}
                        className={`mt-0.5 rounded-md p-1 transition hover:bg-white/10 hover:text-neutral-200 ${menuVisible ? 'text-neutral-200' : 'text-neutral-600 opacity-0 group-hover/card:opacity-100'}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {menuVisible ? (
                        <div
                          onMouseDown={(e) => e.stopPropagation()}
                          className={clsx(
                            'absolute right-0 top-full z-50 mt-1 w-44 rounded-xl border py-1.5 backdrop-blur-xl',
                            light
                              ? 'border-black/10 bg-white/97 shadow-[0_24px_60px_rgba(31,41,55,0.16)]'
                              : 'border-white/10 bg-[#17181d]/97 shadow-[0_24px_60px_rgba(0,0,0,0.6)]',
                          )}
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
                          {user?.role === 'admin' ? (
                            <button
                              type="button"
                              className={menuItemCls}
                              data-testid="toggle-template"
                              onClick={() => { setCardMenu(null); void toggleTemplate(project.id, !templateIds.has(project.id)); }}
                            >
                              <Sparkles className="h-3.5 w-3.5 text-cyan-400/70" />
                              {templateIds.has(project.id)
                                ? (zh ? '取消模板' : 'Unset template')
                                : (zh ? '设为模板' : 'Set as template')}
                            </button>
                          ) : null}
                          <div
                            className="relative"
                            onMouseEnter={() => setCardMenu({ projectId: project.id, submenu: true })}
                            onMouseLeave={() => setCardMenu({ projectId: project.id, submenu: false })}
                          >
                            <button type="button" className={menuItemCls} aria-expanded={cardMenu?.submenu ?? false} onClick={() => setCardMenu({ projectId: project.id, submenu: !cardMenu?.submenu })}>
                              <FolderInput className="h-3.5 w-3.5 text-neutral-500" />
                              <span className="flex-1">{zh ? '移动至文件夹' : 'Move to folder'}</span>
                              <ChevronRight className="h-3.5 w-3.5 text-neutral-600" />
                            </button>
                            {cardMenu?.submenu ? (
                              <div className={clsx(
                                'relative mx-1 w-[calc(100%-8px)] rounded-lg border py-1.5 backdrop-blur-xl',
                                light
                                  ? 'border-black/10 bg-white/97 shadow-[0_24px_60px_rgba(31,41,55,0.16)]'
                                  : 'border-white/10 bg-[#17181d]/97 shadow-[0_24px_60px_rgba(0,0,0,0.6)]',
                              )}>
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
                            onClick={() => {
                              setCardMenu(null);
                              setDeleteTarget({ kind: 'project', id: project.id, name: project.name });
                            }}
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

        {visibleProjects.length > 0 ? (
          <nav
            aria-label={zh ? '项目分页' : 'Project pagination'}
            className="mt-12 flex flex-col items-center justify-center gap-3"
          >
            <div className="flex items-center justify-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => changePage(page - 1)}
              aria-label={zh ? '上一页' : 'Previous page'}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-neutral-300 transition hover:border-white/25 hover:text-white disabled:opacity-35 disabled:hover:border-white/10"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {paginationPages.map((pageNumber) => (
              <button
                key={pageNumber}
                type="button"
                onClick={() => changePage(pageNumber)}
                aria-label={zh ? `第 ${pageNumber} 页` : `Page ${pageNumber}`}
                aria-current={pageNumber === page ? 'page' : undefined}
                className={clsx(
                  'flex h-8 min-w-8 items-center justify-center rounded-full border px-2 text-[12px] tabular-nums transition',
                  pageNumber === page
                    ? 'border-[#ff6b47]/45 bg-[#ff6b47]/15 text-[#ff9a80]'
                    : 'border-white/10 bg-white/[0.04] text-neutral-400 hover:border-white/25 hover:text-white',
                )}
              >
                {pageNumber}
              </button>
            ))}
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => changePage(page + 1)}
              aria-label={zh ? '下一页' : 'Next page'}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-neutral-300 transition hover:border-white/25 hover:text-white disabled:opacity-35 disabled:hover:border-white/10"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            </div>
            <div className="text-[11px] tabular-nums text-neutral-500">
              {zh
                ? `第 ${page} / ${totalPages} 页 · 共 ${visibleProjects.length} 个项目`
                : `Page ${page} of ${totalPages} · ${visibleProjects.length} projects`}
            </div>
          </nav>
        ) : (
          <div className="mt-16 text-center text-[12px] text-neutral-600">
            {zh ? (search ? '没有匹配的画布，试试其他关键词。' : '暂无画布，点击上方新建开始创作。') : 'No matching canvases.'}
          </div>
        )}
      </main>

      <DestructiveConfirmDialog
        open={deleteTarget !== null}
        busy={deleteBusy}
        title={deleteTarget?.kind === 'folder'
          ? (zh ? '删除文件夹？' : 'Delete folder?')
          : (zh ? '删除项目？' : 'Delete project?')}
        description={deleteTarget?.kind === 'folder'
          ? (zh
            ? `「${deleteTarget.name}」将被删除，其中的项目会移回“全部项目”，项目内容不会被删除。`
            : `“${deleteTarget.name}” will be deleted. Its projects will return to All Projects and their content will be kept.`)
          : (zh
            ? `「${deleteTarget?.name ?? ''}」和画布中的所有内容将被永久删除，且无法恢复。若项目中还有未使用积分，将先按出资比例自动退回各出资人的个人账户。`
            : `“${deleteTarget?.name ?? ''}” and all of its canvas content will be permanently deleted. Any unused project points will first be returned to contributors in proportion to their funding.`)}
        confirmLabel={deleteTarget?.kind === 'folder'
          ? (zh ? '删除文件夹' : 'Delete folder')
          : (zh ? '删除项目' : 'Delete project')}
        cancelLabel={zh ? '取消' : 'Cancel'}
        busyLabel={zh ? '删除中…' : 'Deleting…'}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={() => void confirmDeleteTarget()}
      />

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
