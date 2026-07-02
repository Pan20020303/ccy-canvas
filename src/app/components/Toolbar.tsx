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
import { useStore } from '../store';
import { AssetLibraryModal } from './AssetLibraryModal';
import { Dock, DockItem } from './reactbits/Dock';

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
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The asset library is now a centered MODAL (AssetLibraryModal) driven by the
  // isAssetLibraryOpen store flag — the old dock side panel is gone. The dock
  // button below just toggles the flag; the modal hydrates itself on open.

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
      <Dock className="flex flex-row items-end gap-0.5 rounded-full border border-white/10 bg-black/45 px-2 py-1.5 shadow-2xl backdrop-blur-xl">
        <DockItem>
          {/* Primary action — solid white circle (reference proportions), the
              one filled control in the dock. */}
          <button
            onClick={() => toggle('add')}
            className={`group relative flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition-all ${
              open === 'add' ? 'bg-neutral-200 text-black' : 'bg-white text-black hover:bg-neutral-200'
            }`}
          >
            <Plus
              className={`h-4.5 w-4.5 transition-transform duration-300 ease-out ${
                open === 'add' ? 'rotate-45' : 'group-hover:rotate-45'
              }`}
            />
          </button>
        </DockItem>

        <div className="mx-1 h-4 w-px self-center bg-white/10" />

        <DockItem><SideBtn k="projects" icon={Layers} label={language === 'zh' ? '空间 / 项目' : 'Spaces / Projects'} /></DockItem>
        <DockItem>
          {/* 资产库 opens the centered modal (not a dock side panel). */}
          <button
            onClick={() => { setOpen(null); setAssetLibraryOpen(!isAssetLibraryOpen); }}
            className={`group relative flex items-center justify-center rounded-full p-2.5 transition-all ${
              isAssetLibraryOpen ? 'bg-white/10 text-cyan-300' : 'text-neutral-400 hover:bg-white/5 hover:text-cyan-300'
            }`}
          >
            <Package className="h-4 w-4" />
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
              {language === 'zh' ? '资产库' : 'Asset Library'}
            </div>
          </button>
        </DockItem>
        <DockItem>
          {/* 历史资产 opens its modal directly — no intermediate dock panel. */}
          <button
            onClick={() => { setOpen(null); setHistoryAssetsOpen(true); }}
            className="group relative flex items-center justify-center rounded-full p-2.5 text-neutral-400 transition-all hover:bg-white/5 hover:text-cyan-300"
          >
            <FolderOpen className="h-4 w-4" />
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
              {language === 'zh' ? '历史资产' : 'History Assets'}
            </div>
          </button>
        </DockItem>

        <div className="mx-1 h-4 w-px self-center bg-white/10" />

        <DockItem>
          <button
            onClick={() => setSettingsOpen(true)}
            className="group relative flex items-center justify-center rounded-full p-2.5 text-neutral-400 transition-all hover:bg-white/10 hover:text-cyan-300"
          >
            <SettingsIcon className="h-4 w-4" />
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
              {dict.settings}
            </div>
          </button>
        </DockItem>
      </Dock>

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
        </div>
      ) : null}

      {/* 资产库 modal — portaled to body; controlled by isAssetLibraryOpen. */}
      <AssetLibraryModal />
    </div>
  );
};

const PanelTitle = ({ children, compact }: { children: React.ReactNode; compact?: boolean }) => (
  <div className={`px-1 text-xs tracking-wider text-neutral-400 ${compact ? '' : 'mb-2'} uppercase`}>
    {children}
  </div>
);
