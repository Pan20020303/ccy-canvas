import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check, CheckCircle2, ChevronDown, Download, Eye, FolderHeart, Image as ImageIcon,
  LayoutGrid, Loader2, MapPin, Music, Plus, Save, Trash2, Video, X,
} from 'lucide-react';
import clsx from 'clsx';
import { toast } from 'sonner';

import { useStore, ASSET_CATEGORIES, type SavedAsset, type SavedAssetCategory } from '../store';
import { getCanvas } from '../api/projects';
import { toRenderableMediaUrl } from '../reference-media';
import { MediaThumb } from './MediaThumb';

/**
 * 资产库 — 居中弹窗。两个页签:素材库(后端持久化的收藏)与画布资产(画布上的
 * 媒体节点)。2026-07 参考图增强:
 *   · 右上工具条:缩放滑块 + 实时预览开关 + 批量选择(应用/下载/删除)
 *   · 实时预览开启后,悬停缩略图在左下角放大预览
 *   · 每张卡片悬停出「查看 / 定位」浮层(定位=关弹窗并平移画布到该节点)
 *   · 画布资产页签:来源下拉(个人/协作画布 + 画布列表) + 类型筛选(图片/视频/
 *     音频/文本/3D World),可跨画布浏览(getCanvas 拉取其它画布节点)
 */

type KindFilter = 'all' | 'image' | 'video' | 'audio' | 'text' | 'world';

const LIBRARY_CHIPS: { key: KindFilter; zh: string; en: string }[] = [
  { key: 'all', zh: '全部', en: 'All' },
  { key: 'image', zh: '图片', en: 'Images' },
  { key: 'video', zh: '视频', en: 'Videos' },
  { key: 'audio', zh: '音频', en: 'Audio' },
  { key: 'text', zh: '文本', en: 'Text' },
];

const CANVAS_CHIPS: { key: KindFilter; zh: string; en: string }[] = [
  { key: 'image', zh: '图片', en: 'Images' },
  { key: 'video', zh: '视频', en: 'Videos' },
  { key: 'audio', zh: '音频', en: 'Audio' },
  { key: 'text', zh: '文本', en: 'Text' },
  { key: 'world', zh: '3D World', en: '3D World' },
];

// 画布节点 → 统一的资产条目。返回 null = 该节点不算媒体资产。
type CanvasAssetItem = {
  nodeId: string;
  kind: Exclude<KindFilter, 'all'>;
  name: string;
  thumb: string;
  url: string;
  text?: string;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nodeToAsset(node: { id?: unknown; type?: unknown; data?: unknown }, zh: boolean): CanvasAssetItem | null {
  const t = String(node.type ?? '');
  const id = String(node.id ?? '');
  if (!id) return null;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const url = str(d.url);
  const named = str(d.customTitle) || str(d.sourceName);

  if (/^(imageNode|referenceImageNode|panoramaNode)$/.test(t)) {
    const thumb = str(d.thumbnail) || url;
    if (!thumb && !url) return null;
    return { nodeId: id, kind: 'image', name: named || (zh ? '图片' : 'Image'), thumb: thumb || url, url: url || thumb };
  }
  if (/^(videoNode|referenceVideoNode)$/.test(t)) {
    if (!url) return null;
    return { nodeId: id, kind: 'video', name: named || (zh ? '视频' : 'Video'), thumb: str(d.poster) || str(d.thumbnail), url };
  }
  if (/^(audioNode|referenceAudioNode)$/.test(t)) {
    if (!url) return null;
    return { nodeId: id, kind: 'audio', name: named || (zh ? '音频' : 'Audio'), thumb: '', url };
  }
  if (t === 'textNode') {
    const text = str(d.content);
    if (!text) return null;
    return { nodeId: id, kind: 'text', name: named || (zh ? '文本' : 'Text'), thumb: '', url: '', text };
  }
  if (/^(directorStageNode|compositionPreviewNode|layerEditorNode)$/.test(t)) {
    const lastCap = (d.lastCapture ?? {}) as Record<string, unknown>;
    const caps = Array.isArray(d.lastCaptures) ? (d.lastCaptures as Array<Record<string, unknown>>) : [];
    const thumb = str(d.editorPreview) || str(d.image) || str(d.url) || str(lastCap.image) || str(caps[0]?.image);
    if (!thumb) return null;
    return { nodeId: id, kind: 'world', name: named || (zh ? '3D 场景' : '3D scene'), thumb, url: thumb };
  }
  return null;
}

async function downloadUrl(src: string, filename: string) {
  const proxied = toRenderableMediaUrl(src);
  if (!proxied) return;
  try {
    const res = await fetch(proxied, { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const obj = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = obj;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(obj), 4000);
  } catch {
    toast.error('下载失败,请稍后重试');
  }
}

export function AssetLibraryModal() {
  const isOpen = useStore((s) => s.isAssetLibraryOpen);
  const close = useStore((s) => s.setAssetLibraryOpen);
  const language = useStore((s) => s.language);
  const savedAssets = useStore((s) => s.savedAssets);
  const removeAsset = useStore((s) => s.removeAsset);
  const hydrateAssets = useStore((s) => s.hydrateAssets);
  const addNode = useStore((s) => s.addNode);
  const nodes = useStore((s) => s.nodes);
  const openSaveAssetDialog = useStore((s) => s.openSaveAssetDialog);
  const requestCanvasFocus = useStore((s) => s.requestCanvasFocus);
  const saveAsset = useStore((s) => s.saveAsset);
  const backendProjects = useStore((s) => s.backendProjects);
  const activeBackendProjectId = useStore((s) => s.activeBackendProjectId);
  const zh = language === 'zh';

  const [tab, setTab] = useState<'library' | 'canvas'>('library');
  const [category, setCategory] = useState<SavedAssetCategory | 'all'>('all');
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [libKind, setLibKind] = useState<KindFilter>('all');
  const [canvasKind, setCanvasKind] = useState<KindFilter>('image');
  const [hydrated, setHydrated] = useState(false);

  // 右上工具条状态
  const [zoom, setZoom] = useState(45); // 0..100 → 卡片列宽
  const [livePreview, setLivePreview] = useState(false);
  const [hoverItem, setHoverItem] = useState<{ kind: string; url: string; thumb: string; name: string; text?: string } | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [lightbox, setLightbox] = useState<{ url: string; kind: 'image' | 'video' } | null>(null);

  // 画布资产:来源(当前画布 / 其它画布)
  const [sourceTab, setSourceTab] = useState<'personal' | 'team'>('personal');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState<'current' | string>('current'); // 'current' | projectId
  const [remoteAssets, setRemoteAssets] = useState<CanvasAssetItem[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    void Promise.resolve(hydrateAssets()).then(() => setHydrated(true)).catch(() => { /* keep auto-delete disarmed */ });
    setTab('library');
    setCategory('all');
    setLibKind('all');
    setCanvasKind('image');
    setCategoryOpen(false);
    setBatchMode(false);
    setSelected(new Set());
    setHoverItem(null);
    setLightbox(null);
    setSourceMode('current');
    setSourceOpen(false);
    setSourceTab('personal');
    setRemoteAssets([]);
  }, [isOpen, hydrateAssets]);

  // 切换画布来源 → 拉取该画布节点(当前画布用内存态)。
  useEffect(() => {
    if (!isOpen || tab !== 'canvas' || sourceMode === 'current') return;
    let cancelled = false;
    setRemoteLoading(true);
    setRemoteAssets([]);
    getCanvas(sourceMode)
      .then((data) => {
        if (cancelled) return;
        const list = (Array.isArray(data.nodes) ? data.nodes : [])
          .map((n) => nodeToAsset(n as { id?: unknown; type?: unknown; data?: unknown }, zh))
          .filter((x): x is CanvasAssetItem => Boolean(x));
        setRemoteAssets(list);
      })
      .catch(() => { if (!cancelled) toast.error(zh ? '加载画布资产失败' : 'Failed to load canvas assets'); })
      .finally(() => { if (!cancelled) setRemoteLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, tab, sourceMode, zh]);

  const filteredAssets = useMemo(() => savedAssets.filter((asset) => {
    if (category !== 'all' && asset.category !== category) return false;
    if (libKind !== 'all' && asset.kind !== libKind) return false;
    return true;
  }), [savedAssets, category, libKind]);

  const currentCanvasAssets = useMemo(
    () => nodes.map((n) => nodeToAsset(n as { id?: unknown; type?: unknown; data?: unknown }, zh)).filter((x): x is CanvasAssetItem => Boolean(x)),
    [nodes, zh],
  );

  const canvasAssets = sourceMode === 'current' ? currentCanvasAssets : remoteAssets;
  const isCurrentCanvas = sourceMode === 'current';

  const filteredCanvasAssets = useMemo(
    () => canvasAssets.filter((a) => (canvasKind === 'all' ? true : a.kind === canvasKind)),
    [canvasAssets, canvasKind],
  );

  const columnWidth = Math.round(132 + (zoom / 100) * 168); // 132..300px

  const clearBatch = useCallback(() => { setBatchMode(false); setSelected(new Set()); }, []);

  if (!isOpen) return null;

  const useAsset = (asset: SavedAsset) => {
    const id = `asset-use-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const position = { x: 240 + Math.random() * 60, y: 180 + Math.random() * 60 };
    if (asset.kind === 'image') {
      addNode({ id, type: 'referenceImageNode', position, data: { url: asset.url, sourceName: asset.name, sourceKind: 'upload' } } as never);
    } else if (asset.kind === 'video') {
      addNode({ id, type: 'referenceVideoNode', position, data: { url: asset.url, sourceName: asset.name, sourceKind: 'upload' } } as never);
    } else if (asset.kind === 'audio') {
      addNode({ id, type: 'referenceAudioNode', position, data: { url: asset.url, sourceName: asset.name, sourceKind: 'upload' } } as never);
    } else {
      addNode({ id, type: 'textNode', position, data: { content: asset.text ?? '', customTitle: asset.name, textMode: 'editor' } } as never);
    }
  };

  const locateNode = (nodeId: string) => {
    close(false);
    requestCanvasFocus(nodeId);
  };

  const view = (item: { url: string; thumb: string; kind: string }) => {
    const src = item.kind === 'video' ? item.url : (item.thumb || item.url);
    if (!src) return;
    setLightbox({ url: src, kind: item.kind === 'video' ? 'video' : 'image' });
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ─── 批量动作 ──────────────────────────────────────────────────────────────
  const batchApply = () => {
    if (tab === 'library') {
      savedAssets.filter((a) => selected.has(a.id)).forEach(useAsset);
      toast.success(zh ? `已添加 ${selected.size} 项到画布` : `Added ${selected.size} to canvas`);
      close(false);
    } else {
      // 画布资产:批量存入素材库
      const items = canvasAssets.filter((a) => selected.has(a.nodeId));
      items.forEach((a) => saveAsset({
        name: a.name,
        category: 'other',
        kind: a.kind === 'world' ? 'image' : a.kind,
        thumbnail: a.thumb,
        url: a.url,
        text: a.text,
      }));
      toast.success(zh ? `已存入素材库 ${items.length} 项` : `Saved ${items.length} to library`);
    }
    clearBatch();
  };

  const batchDownload = async () => {
    const items = tab === 'library'
      ? savedAssets.filter((a) => selected.has(a.id)).map((a) => ({ url: a.url, name: a.name }))
      : canvasAssets.filter((a) => selected.has(a.nodeId)).map((a) => ({ url: a.url || a.thumb, name: a.name }));
    for (const it of items) {
      if (it.url) await downloadUrl(it.url, `${it.name.replace(/[^a-z0-9_-]+/gi, '-') || 'asset'}`);
    }
    clearBatch();
  };

  const batchDelete = () => {
    savedAssets.filter((a) => selected.has(a.id)).forEach((a) => removeAsset(a.id));
    clearBatch();
  };

  const selectableIds = tab === 'library' ? filteredAssets.map((a) => a.id) : filteredCanvasAssets.map((a) => a.nodeId);

  const categoryLabel = category === 'all'
    ? (zh ? '全部分类' : 'All categories')
    : (() => { const c = ASSET_CATEGORIES.find((x) => x.key === category); return c ? (zh ? c.zh : c.en) : ''; })();

  const activeProject = backendProjects.find((p) => p.id === activeBackendProjectId);
  const otherProjects = backendProjects.filter((p) => p.id !== activeBackendProjectId);
  const sourceLabel = sourceMode === 'current'
    ? (zh ? '当前画布' : 'Current canvas')
    : (backendProjects.find((p) => p.id === sourceMode)?.name ?? (zh ? '画布' : 'Canvas'));

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm" onClick={() => close(false)}>
      <div
        className="relative flex h-[86vh] w-[1240px] max-w-[95vw] flex-col rounded-2xl border border-white/10 bg-[#141519]/98 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header: title + tabs + right toolbar + close */}
        <div className="flex items-center gap-6 border-b border-white/6 px-6 pb-0 pt-4">
          <div className="pb-3 text-[15px] font-semibold text-neutral-100">{zh ? '资产库' : 'Asset Library'}</div>
          <div className="flex items-center gap-5">
            {([
              { key: 'library' as const, zh: '素材库', en: 'Library' },
              { key: 'canvas' as const, zh: '画布资产', en: 'Canvas assets' },
            ]).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => { setTab(t.key); clearBatch(); setHoverItem(null); }}
                className={clsx(
                  'border-b-2 pb-3 text-[13px] transition',
                  tab === t.key ? 'border-cyan-400 font-medium text-neutral-50' : 'border-transparent text-neutral-500 hover:text-neutral-200',
                )}
              >
                {zh ? t.zh : t.en}
              </button>
            ))}
          </div>

          {/* Right toolbar */}
          <div className="ml-auto mb-3 flex items-center gap-3">
            {/* zoom slider */}
            <div className="flex items-center gap-2 text-neutral-500">
              <LayoutGrid className="h-3.5 w-3.5" />
              <input
                type="range"
                min={0}
                max={100}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="h-1 w-24 cursor-pointer accent-neutral-300"
                title={zh ? '缩放' : 'Zoom'}
              />
            </div>
            <div className="h-4 w-px bg-white/10" />
            {/* live preview toggle */}
            <button
              type="button"
              onClick={() => { setLivePreview((v) => !v); if (livePreview) setHoverItem(null); }}
              className="flex items-center gap-2 text-xs text-neutral-300"
              title={zh ? '开启后悬停缩略图可在左下角预览' : 'Hover a thumbnail to preview it bottom-left'}
            >
              <span className={clsx('relative h-4 w-8 rounded-full border transition', livePreview ? 'border-cyan-300/50 bg-cyan-400/40' : 'border-white/12 bg-white/12')}>
                <span className={clsx('absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow transition-transform', livePreview ? 'translate-x-[14px]' : 'translate-x-[2px]')} />
              </span>
              {zh ? '实时预览' : 'Live preview'}
            </button>

            {batchMode ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-400">{zh ? `已选 ${selected.size} 项` : `${selected.size} selected`}</span>
                <button type="button" onClick={batchApply} disabled={selected.size === 0} className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-40">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {tab === 'library' ? (zh ? '应用' : 'Apply') : (zh ? '存入素材库' : 'Save')}
                </button>
                <button type="button" onClick={() => void batchDownload()} disabled={selected.size === 0} className="flex items-center gap-1 rounded-full bg-white/[0.06] px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/[0.12] disabled:opacity-40">
                  <Download className="h-3.5 w-3.5" />
                  {zh ? '下载' : 'Download'}
                </button>
                {tab === 'library' ? (
                  <button type="button" onClick={batchDelete} disabled={selected.size === 0} className="flex items-center gap-1 rounded-full bg-rose-500/12 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/22 disabled:opacity-40">
                    <Trash2 className="h-3.5 w-3.5" />
                    {zh ? '删除' : 'Delete'}
                  </button>
                ) : null}
                <button type="button" onClick={clearBatch} className="px-2 text-xs text-neutral-400 transition hover:text-neutral-200">
                  {zh ? '取消选择' : 'Cancel'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setBatchMode(true)}
                className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/[0.06]"
              >
                <Check className="h-3.5 w-3.5" />
                {zh ? '批量选择' : 'Batch select'}
              </button>
            )}
            <button
              type="button"
              onClick={() => close(false)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-white/8 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Filter row */}
        {tab === 'library' ? (
          <div className="flex items-center gap-3 px-6 py-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setCategoryOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/[0.06]"
              >
                {categoryLabel}
                <ChevronDown className="h-3.5 w-3.5 text-neutral-500" />
              </button>
              {categoryOpen ? (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setCategoryOpen(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1 max-h-[240px] w-40 overflow-y-auto rounded-xl border border-white/10 bg-[#1a1d22] py-1 shadow-2xl">
                    {ASSET_CATEGORIES.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => { setCategory(c.key as SavedAssetCategory | 'all'); setCategoryOpen(false); }}
                        className={clsx('w-full px-3 py-1.5 text-left text-xs transition hover:bg-white/5', c.key === category ? 'text-cyan-300' : 'text-neutral-200')}
                      >
                        {zh ? c.zh : c.en}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            {LIBRARY_CHIPS.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setLibKind(chip.key)}
                className={clsx('rounded-full px-3 py-1.5 text-xs transition', libKind === chip.key ? 'bg-white/12 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200')}
              >
                {zh ? chip.zh : chip.en}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 px-6 py-3">
            {/* Canvas source dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setSourceOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/[0.06]"
              >
                {sourceLabel}
                <ChevronDown className="h-3.5 w-3.5 text-neutral-500" />
              </button>
              {sourceOpen ? (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSourceOpen(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-xl border border-white/10 bg-[#1a1d22] shadow-2xl">
                    <div className="flex items-center gap-1 border-b border-white/8 p-1.5">
                      {([['personal', zh ? '个人画布' : 'Personal'], ['team', zh ? '协作画布' : 'Team']] as const).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSourceTab(key)}
                          className={clsx('flex-1 rounded-lg px-3 py-1.5 text-xs transition', sourceTab === key ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-neutral-200')}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {sourceTab === 'team' ? (
                      <div className="px-3 py-6 text-center text-xs text-neutral-500">{zh ? '暂无协作画布' : 'No team canvases'}</div>
                    ) : (
                      <div className="max-h-[280px] overflow-y-auto py-1">
                        <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wide text-neutral-600">{zh ? '当前画布' : 'Current'}</div>
                        <button
                          type="button"
                          onClick={() => { setSourceMode('current'); setSourceOpen(false); }}
                          className={clsx('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-white/5', sourceMode === 'current' ? 'text-cyan-300' : 'text-neutral-200')}
                        >
                          <span className="truncate">{activeProject?.name ?? (zh ? '无限画布' : 'Canvas')}</span>
                          {sourceMode === 'current' ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                        </button>
                        {otherProjects.length > 0 ? (
                          <>
                            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-neutral-600">{zh ? '其它画布' : 'Other'}</div>
                            {otherProjects.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => { setSourceMode(p.id); setSourceOpen(false); }}
                                className={clsx('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-white/5', sourceMode === p.id ? 'text-cyan-300' : 'text-neutral-300')}
                              >
                                <span className="truncate">{p.name}</span>
                                <span className="shrink-0 text-[10px] text-neutral-600">{p.updated_at?.slice(5, 10)}</span>
                              </button>
                            ))}
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
            {CANVAS_CHIPS.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setCanvasKind(chip.key)}
                className={clsx('rounded-full px-3 py-1.5 text-xs transition', canvasKind === chip.key ? 'bg-white/12 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200')}
              >
                {zh ? chip.zh : chip.en}
              </button>
            ))}
            {batchMode && selectableIds.length > 0 ? (
              <button
                type="button"
                onClick={() => setSelected(new Set(selectableIds))}
                className="ml-auto text-xs text-neutral-400 transition hover:text-neutral-200"
              >
                {zh ? '全选' : 'Select all'}
              </button>
            ) : null}
          </div>
        )}

        {/* ─── Content ─────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {tab === 'library' ? (
            filteredAssets.length === 0 ? (
              <EmptyLibrary zh={zh} />
            ) : (
              <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${columnWidth}px, 1fr))` }}>
                {filteredAssets.map((asset) => {
                  const isSel = selected.has(asset.id);
                  return (
                    <AssetCard
                      key={asset.id}
                      zh={zh}
                      name={asset.name}
                      kind={asset.kind}
                      thumb={asset.thumbnail || asset.url}
                      url={asset.url}
                      text={asset.text}
                      badge={(() => { const c = ASSET_CATEGORIES.find((x) => x.key === asset.category); return c ? (zh ? c.zh : c.en) : asset.category; })()}
                      batchMode={batchMode}
                      selected={isSel}
                      livePreview={livePreview}
                      onCardClick={() => (batchMode ? toggleSelect(asset.id) : useAsset(asset))}
                      onView={() => view({ url: asset.url, thumb: asset.thumbnail || asset.url, kind: asset.kind })}
                      onLocate={undefined}
                      onDelete={() => removeAsset(asset.id)}
                      onHover={(v) => setHoverItem(v ? { kind: asset.kind, url: asset.url, thumb: asset.thumbnail || asset.url, name: asset.name, text: asset.text } : null)}
                      onDeadThumb={hydrated ? () => removeAsset(asset.id) : undefined}
                    />
                  );
                })}
              </div>
            )
          ) : remoteLoading ? (
            <div className="flex h-full items-center justify-center text-neutral-500"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : filteredCanvasAssets.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
              <FolderHeart className="h-8 w-8" />
              <div className="text-sm">{zh ? '该画布下没有此类资产' : 'No assets of this type on this canvas'}</div>
            </div>
          ) : (
            <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${columnWidth}px, 1fr))` }}>
              {filteredCanvasAssets.map((item) => {
                const isSel = selected.has(item.nodeId);
                return (
                  <AssetCard
                    key={item.nodeId}
                    zh={zh}
                    name={item.name}
                    kind={item.kind}
                    thumb={item.thumb}
                    url={item.url}
                    text={item.text}
                    badge={undefined}
                    batchMode={batchMode}
                    selected={isSel}
                    livePreview={livePreview}
                    onCardClick={() => (batchMode ? toggleSelect(item.nodeId) : (isCurrentCanvas ? locateNode(item.nodeId) : view({ url: item.url, thumb: item.thumb, kind: item.kind })))}
                    onView={() => view({ url: item.url, thumb: item.thumb, kind: item.kind })}
                    onLocate={isCurrentCanvas ? () => locateNode(item.nodeId) : undefined}
                    onSave={() => { close(false); openSaveAssetDialog(item.nodeId); }}
                    onHover={(v) => setHoverItem(v ? { kind: item.kind, url: item.url, thumb: item.thumb, name: item.name, text: item.text } : null)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Live preview panel (bottom-left) */}
        {livePreview && hoverItem ? (
          <div className="pointer-events-none absolute bottom-4 left-4 z-30 max-h-[62vh] w-[300px] overflow-hidden rounded-2xl border border-white/12 bg-[#0d0f13]/95 p-2 shadow-[0_24px_70px_rgba(0,0,0,0.6)] backdrop-blur-md">
            {hoverItem.kind === 'image' || hoverItem.kind === 'world' ? (
              <img src={toRenderableMediaUrl(hoverItem.thumb || hoverItem.url)} alt="" className="max-h-[54vh] w-full rounded-lg object-contain" />
            ) : hoverItem.kind === 'video' ? (
              <video src={toRenderableMediaUrl(hoverItem.url)} className="max-h-[54vh] w-full rounded-lg object-contain" muted autoPlay loop />
            ) : hoverItem.kind === 'audio' ? (
              <div className="flex h-40 w-full items-center justify-center rounded-lg bg-white/[0.04] text-neutral-400"><Music className="h-10 w-10" /></div>
            ) : (
              <div className="max-h-[54vh] overflow-y-auto rounded-lg bg-white/[0.03] p-3 text-xs leading-5 text-neutral-300">{hoverItem.text || hoverItem.name}</div>
            )}
            <div className="truncate px-1 pt-1.5 text-[11px] text-neutral-400">{hoverItem.name}</div>
          </div>
        ) : null}
      </div>

      {/* Lightbox (查看) */}
      {lightbox ? (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/85 p-8" onClick={(e) => { e.stopPropagation(); setLightbox(null); }}>
          <button type="button" onClick={(e) => { e.stopPropagation(); setLightbox(null); }} className="absolute right-6 top-6 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20">
            <X className="h-5 w-5" />
          </button>
          {lightbox.kind === 'video' ? (
            <video src={toRenderableMediaUrl(lightbox.url)} className="max-h-[88vh] max-w-[92vw] rounded-xl" controls autoPlay onClick={(e) => e.stopPropagation()} />
          ) : (
            <img src={toRenderableMediaUrl(lightbox.url)} alt="" className="max-h-[88vh] max-w-[92vw] rounded-xl object-contain" onClick={(e) => e.stopPropagation()} />
          )}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

// ─── 单张资产卡片 ────────────────────────────────────────────────────────────

function AssetCard({
  zh, name, kind, thumb, url, text, badge, batchMode, selected, livePreview,
  onCardClick, onView, onLocate, onDelete, onSave, onHover, onDeadThumb,
}: {
  zh: boolean;
  name: string;
  kind: string;
  thumb: string;
  url: string;
  text?: string;
  badge?: string;
  batchMode: boolean;
  selected: boolean;
  livePreview: boolean;
  onCardClick: () => void;
  onView: () => void;
  onLocate?: () => void;
  onDelete?: () => void;
  onSave?: () => void;
  onHover: (v: boolean) => void;
  onDeadThumb?: () => void;
}) {
  const isImageLike = kind === 'image' || kind === 'world';
  return (
    <div
      className={clsx(
        'group relative overflow-hidden rounded-xl border bg-white/[0.02] transition',
        selected ? 'border-cyan-400/70 ring-1 ring-cyan-400/40' : 'border-white/8 hover:border-white/16',
      )}
      onMouseEnter={() => livePreview && onHover(true)}
      onMouseLeave={() => livePreview && onHover(false)}
    >
      <button type="button" onClick={onCardClick} className="block w-full text-left">
        <div className="aspect-square overflow-hidden bg-black/40">
          {isImageLike && (thumb || url) ? (
            <MediaThumb src={thumb || url} alt="" className="h-full w-full object-cover" onDead={onDeadThumb} />
          ) : kind === 'video' ? (
            thumb ? <MediaThumb src={thumb} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-neutral-500"><Video className="h-7 w-7" /></div>
          ) : kind === 'audio' ? (
            <div className="flex h-full w-full items-center justify-center text-neutral-500"><Music className="h-7 w-7" /></div>
          ) : (
            <div className="flex h-full items-center justify-center p-3 text-center text-[11px] text-neutral-400"><span className="line-clamp-5">{text || name}</span></div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 px-2.5 py-2">
          <span className="truncate text-xs text-neutral-200">{name}</span>
          {badge ? (
            <span className="shrink-0 rounded bg-white/6 px-1.5 py-0.5 text-[10px] text-neutral-500">{badge}</span>
          ) : (
            <span className="shrink-0 text-[10px] text-neutral-500">
              {kind === 'image' || kind === 'world' ? <ImageIcon className="h-3 w-3" /> : kind === 'video' ? <Video className="h-3 w-3" /> : kind === 'audio' ? <Music className="h-3 w-3" /> : null}
            </span>
          )}
        </div>
      </button>

      {/* Batch checkbox */}
      {batchMode ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCardClick(); }}
          className={clsx('absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border transition', selected ? 'border-cyan-400 bg-cyan-400 text-black' : 'border-white/40 bg-black/50 text-transparent hover:border-white/70')}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      ) : (
        <>
          {/* Hover overlay: 查看 / 定位 */}
          <div className="pointer-events-none absolute inset-x-0 top-[38%] flex -translate-y-1/2 items-center justify-center opacity-0 transition group-hover:opacity-100">
            <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-white/15 bg-black/70 p-1 backdrop-blur-md">
              <button type="button" onClick={(e) => { e.stopPropagation(); onView(); }} className="flex flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[11px] text-neutral-200 transition hover:bg-white/10">
                <Eye className="h-4 w-4" />
                {zh ? '查看' : 'View'}
              </button>
              {onLocate ? (
                <button type="button" onClick={(e) => { e.stopPropagation(); onLocate(); }} className="flex flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[11px] text-cyan-200 transition hover:bg-white/10">
                  <MapPin className="h-4 w-4" />
                  {zh ? '定位' : 'Locate'}
                </button>
              ) : null}
            </div>
          </div>
          {/* Corner actions */}
          {onSave ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); onSave(); }} className="absolute right-2 top-2 hidden items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[10.5px] text-cyan-200 transition hover:bg-cyan-500/20 group-hover:flex" title={zh ? '保存到素材库' : 'Save to library'}>
              <Plus className="h-3 w-3" />
              {zh ? '存入' : 'Save'}
            </button>
          ) : null}
          {onDelete ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }} className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md bg-black/70 text-rose-300 transition hover:bg-rose-500/25 group-hover:flex" title={zh ? '删除' : 'Delete'}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function EmptyLibrary({ zh }: { zh: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.04] text-neutral-500">
        <Save className="h-7 w-7" />
      </div>
      <div className="text-[15px] font-medium text-neutral-200">{zh ? '素材库为空' : 'Library is empty'}</div>
      <div className="text-xs text-neutral-500">
        {zh ? '在工作流画布中右键点击节点,即可保存到素材库' : 'Right-click a canvas node to save it into the library'}
      </div>
      <div className="mt-2 space-y-2.5 rounded-2xl bg-white/[0.03] px-6 py-4">
        {(zh
          ? ['在画布中找到图片、视频、音频或文本节点', '右键点击节点 → 选择 保存到素材库', '设置名称和分类后即可在此查看和使用']
          : ['Find an image/video/audio/text node on the canvas', 'Right-click it → choose "Save to library"', 'Name + categorize it, then reuse it from here']
        ).map((step, i) => (
          <div key={i} className="flex items-center gap-2.5 text-xs text-neutral-300">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-[10px] font-semibold text-amber-300">{i + 1}</span>
            {step}
          </div>
        ))}
      </div>
    </div>
  );
}
