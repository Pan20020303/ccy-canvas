import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import {
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Music,
  Package,
  Pencil,
  Pin,
  Plus,
  Settings as SettingsIcon,
  StickyNote,
  Upload,
  Video,
} from 'lucide-react';

import { t } from '../i18n';
import { useStore } from '../store';
import { AssetLibraryModal } from './AssetLibraryModal';
import { Dock, DockItem } from './reactbits/Dock';

type PanelKey = 'add' | null;
type NodeKind = 'textNode' | 'imageNode' | 'videoNode' | 'audioNode' | 'panoramaNode' | 'stickyNoteNode';

const NODE_OPTIONS: Array<{ kind: NodeKind; icon: typeof Pencil; zh: string; en: string }> = [
  { kind: 'textNode', icon: Pencil, zh: '生成文本', en: 'Generate Text' },
  { kind: 'imageNode', icon: ImageIcon, zh: '生成图像', en: 'Generate Image' },
  { kind: 'videoNode', icon: Video, zh: '生成视频', en: 'Generate Video' },
  { kind: 'audioNode', icon: Music, zh: '生成音频', en: 'Generate Audio' },
  { kind: 'panoramaNode', icon: Globe, zh: '生成 360°', en: 'Generate 360°' },
  { kind: 'stickyNoteNode', icon: StickyNote, zh: '便签', en: 'Sticky note' },
];

export const Toolbar = () => {
  const language = useStore((state) => state.language);
  const addNode = useStore((state) => state.addNode);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const setHistoryAssetsOpen = useStore((state) => state.setHistoryAssetsOpen);
  const isAssetLibraryOpen = useStore((state) => state.isAssetLibraryOpen);
  const setAssetLibraryOpen = useStore((state) => state.setAssetLibraryOpen);
  const snapToGrid = useStore((state) => state.snapToGrid);
  const setSnapToGrid = useStore((state) => state.setSnapToGrid);
  const dict = t[language];

  // 空间/项目面板已移除 — 项目的创建和切换在首页（/home）完成。
  const [open, setOpen] = useState<PanelKey>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The asset library is a centered MODAL (AssetLibraryModal) driven by the
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

  const toggle = (key: PanelKey) => setOpen((current) => (current === key ? null : key));

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
        <DockItem>
          {/* 自动吸附 — moved here from the bottom-left strip (reference dock
              keeps the pin at the right end). Toggles the 24px grid snap +
              neighbor alignment guides. */}
          <button
            onClick={() => setSnapToGrid(!snapToGrid)}
            className={`group relative flex items-center justify-center rounded-full p-2.5 transition-all ${
              snapToGrid ? 'bg-white/10 text-cyan-300' : 'text-neutral-400 hover:bg-white/5 hover:text-cyan-300'
            }`}
          >
            <Pin className="h-4 w-4" />
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
              {language === 'zh' ? '自动吸附' : 'Auto snap'}
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
