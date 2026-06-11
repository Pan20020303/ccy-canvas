import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import {
  Box,
  Check,
  Film,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Layers,
  Mountain,
  Music,
  Package,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  StickyNote,
  Upload,
  User as UserIcon,
  Users,
  Video,
} from 'lucide-react';

import { t } from '../i18n';
import { useStore, ASSET_CATEGORIES, type SavedAssetCategory, type SavedAsset } from '../store';

type PanelKey = 'add' | 'projects' | 'assets' | 'files' | null;
type NodeKind = 'textNode' | 'imageNode' | 'videoNode' | 'audioNode' | 'panoramaNode' | 'stickyNoteNode';

const NODE_OPTIONS: Array<{ kind: NodeKind; icon: typeof Pencil; zh: string; en: string }> = [
  { kind: 'textNode', icon: Pencil, zh: '生成文本', en: 'Generate Text' },
  { kind: 'imageNode', icon: ImageIcon, zh: '生成图像', en: 'Generate Image' },
  { kind: 'videoNode', icon: Video, zh: '生成视频', en: 'Generate Video' },
  { kind: 'audioNode', icon: Music, zh: '生成音频', en: 'Generate Audio' },
  { kind: 'panoramaNode', icon: Globe, zh: '生成 360°', en: 'Generate 360°' },
  { kind: 'stickyNoteNode', icon: StickyNote, zh: '便签', en: 'Sticky note' },
];

const ASSET_TABS = [
  { key: 'people', icon: UserIcon, zh: '人物', en: 'People' },
  { key: 'scenes', icon: Mountain, zh: '场景', en: 'Scenes' },
  { key: 'objects', icon: Box, zh: '物品', en: 'Objects' },
] as const;

type AssetCategoryTab = SavedAssetCategory | 'all';

const formatShortDate = (timestamp: number, language: 'zh' | 'en') => (
  new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(timestamp)
);

export const Toolbar = () => {
  const language = useStore((state) => state.language);
  const addNode = useStore((state) => state.addNode);
  const spaces = useStore((state) => state.spaces);
  const activeSpaceId = useStore((state) => state.activeSpaceId);
  const switchSpace = useStore((state) => state.switchSpace);
  const localProjects = useStore((state) => state.projects);
  const backendProjects = useStore((state) => state.backendProjects);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const activeBackendProjectId = useStore((state) => state.activeBackendProjectId);
  const switchProject = useStore((state) => state.switchProject);
  const switchBackendProject = useStore((state) => state.switchBackendProject);
  const createProject = useStore((state) => state.createProject);
  const createBackendProject = useStore((state) => state.createBackendProject);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const setHistoryAssetsOpen = useStore((state) => state.setHistoryAssetsOpen);
  const savedAssets = useStore((state) => state.savedAssets);
  const removeAsset = useStore((state) => state.removeAsset);
  const isAssetLibraryOpen = useStore((state) => state.isAssetLibraryOpen);
  const setAssetLibraryOpen = useStore((state) => state.setAssetLibraryOpen);
  const dict = t[language];

  const projects = backendProjects.length > 0
    ? backendProjects.map((project) => ({
        id: project.id,
        name: project.name,
        createdAt: new Date(project.created_at).getTime(),
        updatedAt: new Date(project.updated_at).getTime(),
      }))
    : localProjects;
  const effectiveActiveProjectId = activeBackendProjectId ?? activeProjectId;

  const [open, setOpen] = useState<PanelKey>(null);
  const [assetTab, setAssetTab] = useState<typeof ASSET_TABS[number]['key']>('people');
  const [assetCategoryTab, setAssetCategoryTab] = useState<AssetCategoryTab>('all');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Programmatic open/close from the asset library store flag.
  useEffect(() => {
    if (isAssetLibraryOpen && open !== 'assets') setOpen('assets');
    if (!isAssetLibraryOpen && open === 'assets') setOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAssetLibraryOpen]);
  useEffect(() => {
    if (open !== 'assets' && isAssetLibraryOpen) setAssetLibraryOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(null);
      }
    };

    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    const mm = gsap.matchMedia();
    const ctx = gsap.context(() => {
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(root.children, {
          autoAlpha: 0,
          y: 14,
          duration: 0.36,
          ease: "power2.out",
          stagger: 0.06,
        });
      });
    }, root);

    return () => {
      ctx.revert();
      mm.revert();
    };
  }, []);

  useEffect(() => {
    if (!open || !panelRef.current) {
      return;
    }

    gsap.fromTo(
      panelRef.current,
      { autoAlpha: 0, y: 12 },
      { autoAlpha: 1, y: 0, duration: 0.24, ease: "power2.out" },
    );
  }, [open]);

  const handleAddNode = (kind: NodeKind) => {
    // Sticky notes get a sensible default text + color so they don't render
    // empty and look broken. Everything else just spawns with empty data.
    const data = kind === 'stickyNoteNode'
      ? { text: '', color: 'yellow' as const }
      : {};
    addNode({
      id: `${kind}-${Date.now()}`,
      type: kind,
      position: { x: Math.random() * 200 + 200, y: Math.random() * 200 + 150 },
      data,
    } as never);
    setOpen(null);
  };

  const submitProject = () => {
    const name = newProjectName.trim();
    if (backendProjects.length > 0) {
      void createBackendProject(name || '新项目');
    } else {
      createProject(name || undefined);
    }
    setNewProjectName('');
    setIsCreatingProject(false);
  };

  const toggle = (key: PanelKey) => setOpen((current) => (current === key ? null : key));

  const SideBtn = ({ k, icon: Icon, label }: { k: PanelKey; icon: typeof Layers; label: string }) => (
    <button
      onClick={() => toggle(k)}
      className={`group relative flex items-center justify-center rounded-full p-2.5 transition-all ${
        open === k ? 'bg-white/10 text-cyan-300' : 'text-neutral-400 hover:bg-white/5 hover:text-cyan-300'
      }`}
    >
      <Icon className="h-4 w-4" />
      <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        {label}
      </div>
    </button>
  );

  return (
    <div ref={rootRef} className="absolute bottom-6 left-1/2 z-40 flex -translate-x-1/2 flex-col-reverse items-center gap-3">
      <div className="flex flex-row items-center gap-0.5 rounded-full border border-white/10 bg-black/45 px-2 py-1.5 shadow-2xl backdrop-blur-xl">
        <button
          onClick={() => toggle('add')}
          className="group relative flex items-center justify-center rounded-full p-2.5 transition-all hover:bg-white/10"
        >
          <Plus
            className={`h-4 w-4 transition-transform duration-300 ease-out ${
              open === 'add' ? 'rotate-45 text-cyan-300' : 'text-cyan-400 group-hover:rotate-45'
            }`}
          />
        </button>

        <div className="mx-1 h-4 w-px bg-white/10" />

        <SideBtn k="projects" icon={Layers} label={language === 'zh' ? '空间 / 项目' : 'Spaces / Projects'} />
        <SideBtn k="assets" icon={Package} label={language === 'zh' ? '资源库' : 'Assets'} />
        <SideBtn k="files" icon={FolderOpen} label={language === 'zh' ? '文件 / 历史' : 'Files / History'} />

        <div className="mx-1 h-4 w-px bg-white/10" />

        <button
          onClick={() => setSettingsOpen(true)}
          className="group relative flex items-center justify-center rounded-full p-2.5 text-neutral-400 transition-all hover:bg-white/10 hover:text-cyan-300"
        >
          <SettingsIcon className="h-4 w-4" />
          <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
            {dict.settings}
          </div>
        </button>
      </div>

      {open ? (
        <div ref={panelRef} className="max-h-[70vh] w-[340px] overflow-y-auto rounded-2xl border border-white/10 bg-[#15181d]/95 p-3 shadow-2xl backdrop-blur-xl">
          {open === 'add' ? (
            <>
              <PanelTitle>{language === 'zh' ? '画布自由生成' : 'Free Generation'}</PanelTitle>
              <div className="flex flex-col gap-0.5">
                {NODE_OPTIONS.map((option) => {
                  const Icon = option.icon;

                  return (
                    <button
                      key={option.kind}
                      onClick={() => handleAddNode(option.kind)}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-neutral-200 transition hover:bg-white/5"
                    >
                      <Icon className="h-4 w-4 text-neutral-400" />
                      <span className="text-sm">{language === 'zh' ? option.zh : option.en}</span>
                    </button>
                  );
                })}
              </div>
              <div className="my-2 h-px bg-white/10" />
              <PanelTitle>{language === 'zh' ? '添加资源' : 'Add Resource'}</PanelTitle>
              <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-neutral-200 transition hover:bg-white/5">
                <Upload className="h-4 w-4 text-neutral-400" />
                <span className="text-sm">{language === 'zh' ? '上传文件' : 'Upload File'}</span>
              </button>
            </>
          ) : null}

          {open === 'projects' ? (
            <>
              <PanelTitle>{language === 'zh' ? '空间切换' : 'Spaces'}</PanelTitle>
              <div className="mb-4 flex flex-col gap-1.5">
                {spaces.map((space) => (
                  <button
                    key={space.id}
                    onClick={() => switchSpace(space.id)}
                    className={`rounded-xl border px-3 py-2.5 text-left transition ${
                      space.id === activeSpaceId
                        ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-300'
                        : 'border-white/5 bg-white/[0.02] text-neutral-200 hover:border-white/10 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{space.name}</div>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-neutral-500">
                          <span className="rounded-full border border-white/10 px-1.5 py-0.5">
                            {space.type === 'personal' ? '个人' : '团队'}
                          </span>
                          <span>{space.role}</span>
                        </div>
                      </div>
                      {space.id === activeSpaceId ? (
                        <div className="flex items-center gap-1 text-cyan-300">
                          {space.type === 'team' ? <Users className="h-3.5 w-3.5" /> : <UserIcon className="h-3.5 w-3.5" />}
                          <Check className="h-3.5 w-3.5" />
                        </div>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>

              <PanelTitle>{language === 'zh' ? '画布项目' : 'Canvas Projects'}</PanelTitle>
              <div className="mb-3 flex flex-col gap-1.5">
                {projects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => {
                      if (backendProjects.length > 0) {
                        void switchBackendProject(project.id);
                      } else {
                        switchProject(project.id);
                      }
                    }}
                    className={`rounded-xl border px-3 py-2.5 text-left transition ${
                      project.id === effectiveActiveProjectId
                        ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-300'
                        : 'border-white/5 bg-white/[0.02] text-neutral-200 hover:border-white/10 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {project.name.trim() || (language === 'zh' ? '未命名项目' : 'Untitled Project')}
                        </div>
                        <div className="mt-1 text-[10px] text-neutral-500">
                          {language === 'zh' ? '创建于 ' : 'Created '}
                          {formatShortDate(project.createdAt, language)}
                        </div>
                      </div>
                      {project.id === effectiveActiveProjectId ? <Check className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                    </div>
                  </button>
                ))}
              </div>

              {isCreatingProject ? (
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <label className="mb-2 block text-[11px] tracking-wide text-neutral-500">
                    {language === 'zh' ? '项目名称' : 'Project Name'}
                  </label>
                  <input
                    autoFocus
                    value={newProjectName}
                    onChange={(event) => setNewProjectName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        submitProject();
                      }

                      if (event.key === 'Escape') {
                        setIsCreatingProject(false);
                        setNewProjectName('');
                      }
                    }}
                    placeholder={language === 'zh' ? '例如：第一章分镜' : 'For example: Chapter 1 Storyboard'}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-cyan-400/40"
                  />
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      onClick={() => {
                        setIsCreatingProject(false);
                        setNewProjectName('');
                      }}
                      className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
                    >
                      {language === 'zh' ? '取消' : 'Cancel'}
                    </button>
                    <button
                      onClick={submitProject}
                      className="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-300 transition hover:bg-cyan-500/25"
                    >
                      {language === 'zh' ? '创建项目' : 'Create Project'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setIsCreatingProject(true)}
                  className="flex w-full items-center gap-2 rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-sm text-neutral-400 transition hover:border-cyan-500/40 hover:text-cyan-300"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {language === 'zh' ? '新建项目' : 'New Project'}
                </button>
              )}
            </>
          ) : null}

          {open === 'assets' ? (
            <>
              <div className="mb-3 flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <PanelTitle compact>{language === 'zh' ? '我的素材' : 'My Assets'}</PanelTitle>
                  <span className="text-[11px] text-neutral-500">{language === 'zh' ? '我的主体库' : 'Subject Library'}</span>
                </div>
                <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[9px] tracking-wider text-rose-300">BETA</span>
              </div>
              <div className="prompt-editor-scroll mb-3 flex items-center gap-1 overflow-x-auto pb-1">
                {ASSET_CATEGORIES.map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => setAssetCategoryTab(cat.key)}
                    className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] transition ${
                      cat.key === assetCategoryTab
                        ? 'bg-white/10 text-neutral-100'
                        : 'text-neutral-400 hover:bg-white/5'
                    }`}
                  >
                    {language === 'zh' ? cat.zh : cat.en}
                  </button>
                ))}
              </div>
              {(() => {
                const filtered = assetCategoryTab === 'all' ? savedAssets : savedAssets.filter((asset) => asset.category === assetCategoryTab);
                if (filtered.length === 0) {
                  return (
                    <div className="py-10 text-center text-xs text-neutral-600">
                      {language === 'zh' ? '暂无素材' : 'No assets yet'}
                    </div>
                  );
                }
                return (
                  <div className="grid grid-cols-2 gap-2.5">
                    {filtered.map((asset: SavedAsset) => (
                      <div key={asset.id} className="group relative overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] transition hover:border-white/15">
                        <button
                          type="button"
                          onClick={() => {
                            const id = `asset-use-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
                            const position = { x: 240 + Math.random() * 60, y: 180 + Math.random() * 60 };
                            if (asset.kind === 'image') {
                              addNode({ id, type: 'referenceImageNode', position, data: { url: asset.url, sourceName: asset.name, sourceKind: 'upload' } } as never);
                            } else if (asset.kind === 'video') {
                              addNode({ id, type: 'referenceVideoNode', position, data: { url: asset.url, sourceName: asset.name, sourceKind: 'upload' } } as never);
                            } else {
                              addNode({ id, type: 'textNode', position, data: { content: asset.text ?? '', customTitle: asset.name, textMode: 'editor' } } as never);
                            }
                            setOpen(null);
                          }}
                          className="block w-full text-left"
                        >
                          <div className="aspect-square overflow-hidden bg-black/40">
                            {asset.kind === 'image' && asset.thumbnail ? (
                              <img src={asset.thumbnail} alt="" className="h-full w-full object-cover" />
                            ) : asset.kind === 'video' && asset.url ? (
                              <video src={asset.url} className="h-full w-full object-cover" muted />
                            ) : asset.kind === 'text' ? (
                              <div className="flex h-full items-center justify-center p-2 text-center text-[10px] text-neutral-400">
                                <span className="line-clamp-4">{asset.text || asset.name}</span>
                              </div>
                            ) : (
                              <div className="flex h-full items-center justify-center text-neutral-500">
                                <ImageIcon className="h-5 w-5" />
                              </div>
                            )}
                          </div>
                          <div className="truncate px-2 py-1.5 text-[11px] text-neutral-200">{asset.name}</div>
                        </button>
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); removeAsset(asset.id); }}
                          className="absolute right-1.5 top-1.5 hidden h-5 w-5 items-center justify-center rounded-md bg-black/60 text-rose-300 transition hover:bg-rose-500/20 group-hover:flex"
                          title={language === 'zh' ? '删除' : 'Delete'}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </>
          ) : null}

          {open === 'files' ? (
            <>
              <PanelTitle>{language === 'zh' ? '文件管理' : 'Files'}</PanelTitle>
              <div className="mb-2 rounded-xl border border-cyan-500/10 bg-cyan-500/[0.05] px-3 py-2 text-[11px] text-neutral-400">
                {spaces.find((space) => space.id === activeSpaceId)?.type === 'team'
                  ? (language === 'zh' ? '你正在查看团队空间的共享历史生成。' : 'You are viewing shared team history.')
                  : (language === 'zh' ? '你正在查看个人空间的历史生成。' : 'You are viewing personal history.')}
              </div>
              <div className="space-y-3">
                <button
                  onClick={() => {
                    setHistoryAssetsOpen(true);
                    setOpen(null);
                  }}
                  className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-cyan-400/30 hover:bg-white/[0.05]"
                >
                  <div>
                    <div className="text-sm text-neutral-100">{language === 'zh' ? '历史生成' : 'History Assets'}</div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {language === 'zh'
                        ? '在独立弹窗中浏览、筛选和批量操作历史资产'
                        : 'Browse and batch manage history assets in a dedicated modal'}
                    </div>
                  </div>
                  <Film className="h-4 w-4 text-neutral-500" />
                </button>

                <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-neutral-600">
                  {language === 'zh' ? '输出文件夹将在下一阶段接入。' : 'Output folders will be connected in the next phase.'}
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

const PanelTitle = ({ children, compact }: { children: React.ReactNode; compact?: boolean }) => (
  <div className={`px-1 text-xs tracking-wider text-neutral-400 ${compact ? '' : 'mb-2'} uppercase`}>
    {children}
  </div>
);
