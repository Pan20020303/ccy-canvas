import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LayoutGrid, X } from 'lucide-react';
import clsx from 'clsx';

import { getHistoryItemAssetUrl } from '../history-assets';
import { toRenderableMediaUrl } from '../reference-media';
import { useStore, type HistoryItem } from '../store';

/** Tabs match NeoWOW's 选择素材 modal. Tabs we can't back yet are
 *  disabled — they render but show an empty "敬请期待" state so the
 *  full structure is visible. */
type AssetTab = 'history' | 'library' | 'canvas' | 'image_tools' | 'video_tools';

const TAB_LABELS: Record<AssetTab, { label: string; tag?: string }> = {
  history: { label: '生成历史' },
  library: { label: '素材库' },
  canvas: { label: '画布资产' },
  image_tools: { label: '图片工具', tag: '外部' },
  video_tools: { label: '视频工具', tag: '外部' },
};

const TAB_AVAILABLE: Record<AssetTab, boolean> = {
  history: true,
  library: false,
  canvas: true,
  image_tools: false,
  video_tools: false,
};

type SubFilter = 'current_canvas' | 'all' | 'image' | 'video';

const SUB_FILTER_LABELS: Record<SubFilter, string> = {
  current_canvas: '当前画布',
  all: '全部',
  image: '图片',
  video: '视频',
};

/** Unified asset record fed to the grid regardless of source tab. */
export type PickedAsset = {
  id: string;
  source: 'history' | 'canvas';
  kind: 'image' | 'video' | 'audio';
  url: string;            // resolved playable / displayable URL
  title?: string;
  // History-only — passed back so callers that want the full HistoryItem
  // (existing flows) don't need to re-fetch.
  historyItem?: HistoryItem;
};

const MAX_SELECTION = 10;

export function AssetPickerModal({
  isOpen,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (picked: PickedAsset[]) => void;
}) {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
  const history = useStore((state) => state.history);
  const nodes = useStore((state) => state.nodes);
  const activeProjectId = useStore((state) => state.activeProjectId);

  const [activeTab, setActiveTab] = useState<AssetTab>('history');
  const [subFilter, setSubFilter] = useState<SubFilter>('current_canvas');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Grid cell size in px — controls `minmax(Npx, 1fr)`. Range matches the
  // visual extremes of NeoWOW's slider (small ~120, large ~240).
  const [gridSize, setGridSize] = useState(168);
  const [livePreview, setLivePreview] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setSelectedIds([]);
      setActiveTab('history');
      setSubFilter('current_canvas');
    }
  }, [isOpen]);

  /** Pull items from the active tab + sub-filter. Sources:
   *  - history: store.history, filtered by mediaType + projectId
   *  - canvas: all nodes on canvas with a usable media url */
  const items: PickedAsset[] = useMemo(() => {
    if (activeTab === 'history') {
      return history
        .filter((item) => {
          if (subFilter === 'current_canvas' && item.projectId !== activeProjectId) return false;
          if (subFilter === 'image' && item.mediaType !== 'image') return false;
          if (subFilter === 'video' && item.mediaType !== 'video') return false;
          // text/audio fall through under "全部"; not picker-friendly so we
          // only surface image/video/audio with a visible thumbnail.
          return item.mediaType === 'image' || item.mediaType === 'video' || item.mediaType === 'audio';
        })
        .map<PickedAsset>((item) => ({
          id: `history-${item.id}`,
          source: 'history',
          kind: item.mediaType === 'audio' ? 'audio' : (item.mediaType as 'image' | 'video'),
          url: getHistoryItemAssetUrl(item, apiBaseUrl) || item.thumbnail || item.content || '',
          title: item.title,
          historyItem: item,
        }))
        .filter((entry) => entry.url);
    }
    if (activeTab === 'canvas') {
      return nodes
        .map<PickedAsset | null>((node) => {
          const data = (node.data ?? {}) as Record<string, unknown>;
          const rawUrl = (data.url as string) || (data.thumbnail as string) || '';
          if (!rawUrl) return null;
          const type = node.type ?? '';
          const isImage = type === 'imageNode' || type === 'referenceImageNode';
          const isVideo = type === 'videoNode' || type === 'referenceVideoNode';
          const isAudio = type === 'audioNode' || type === 'referenceAudioNode';
          if (!isImage && !isVideo && !isAudio) return null;
          const kind: PickedAsset['kind'] = isImage ? 'image' : isVideo ? 'video' : 'audio';
          if (subFilter === 'image' && kind !== 'image') return null;
          if (subFilter === 'video' && kind !== 'video') return null;
          return {
            id: `canvas-${node.id}`,
            source: 'canvas',
            kind,
            url: rawUrl,
            title: (data.sourceName as string) || node.id,
          };
        })
        .filter((entry): entry is PickedAsset => entry !== null);
    }
    return [];
  }, [activeTab, subFilter, history, nodes, activeProjectId, apiBaseUrl]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.includes(item.id)),
    [items, selectedIds],
  );

  const toggle = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((existing) => existing !== id);
      if (current.length >= MAX_SELECTION) return current;
      return [...current, id];
    });
  };

  if (!isOpen) return null;

  const tabAvailable = TAB_AVAILABLE[activeTab];

  // Portal to document.body so the `fixed` overlay actually escapes
  // PromptPanel's `transform: scale()` ancestor. Without this, the modal
  // gets trapped inside the scaled prompt panel and renders as a tiny
  // sliver attached to the node.
  return createPortal(
    <div className="fixed inset-0 z-[140] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative z-10 flex h-[78vh] w-[min(1280px,calc(100vw-48px))] flex-col overflow-hidden rounded-[18px] border border-white/10 bg-[#1a1c20]/98 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ── Header: title + tabs + close ─────────────────────────── */}
        <div className="flex items-center gap-6 border-b border-white/8 px-6 py-4">
          <div className="shrink-0 text-[15px] font-medium text-neutral-100">选择素材</div>
          <div className="flex flex-1 items-center gap-5 text-sm">
            {(Object.keys(TAB_LABELS) as AssetTab[]).map((tab) => {
              const meta = TAB_LABELS[tab];
              const isActive = tab === activeTab;
              const enabled = TAB_AVAILABLE[tab];
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => enabled && setActiveTab(tab)}
                  disabled={!enabled}
                  className={clsx(
                    'relative pb-1 transition',
                    isActive
                      ? 'text-neutral-100'
                      : enabled
                        ? 'text-neutral-500 hover:text-neutral-200'
                        : 'text-neutral-600 cursor-not-allowed',
                  )}
                >
                  {meta.label}
                  {meta.tag ? (
                    <span className="ml-1 rounded bg-purple-500/20 px-1 py-0.5 align-middle text-[10px] text-purple-300">{meta.tag}</span>
                  ) : null}
                  {isActive ? (
                    <span className="absolute -bottom-[5px] left-0 right-0 h-0.5 rounded-full bg-cyan-400" />
                  ) : null}
                </button>
              );
            })}
          </div>
          {/* Right-side controls: layout toggle (cosmetic for now), grid
              size slider, live-preview toggle, close. Mirrors NeoWOW's
              top-right cluster. */}
          <div className="flex shrink-0 items-center gap-3 text-neutral-400">
            <button
              type="button"
              className="rounded-md p-1 text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200"
              title="网格视图"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <input
              type="range"
              min={120}
              max={240}
              step={8}
              value={gridSize}
              onChange={(event) => setGridSize(Number(event.target.value))}
              className="asset-picker-size-slider h-1 w-24 cursor-pointer accent-neutral-300"
              title="网格大小"
            />
            <div className="mx-1 h-4 w-px bg-white/10" />
            <button
              type="button"
              onClick={() => setLivePreview((value) => !value)}
              className="flex items-center gap-2 text-xs text-neutral-300"
              title="鼠标悬停时自动播放视频"
            >
              <span
                className={clsx(
                  'relative inline-flex h-4 w-7 items-center rounded-full transition',
                  livePreview ? 'bg-cyan-500' : 'bg-white/15',
                )}
              >
                <span
                  className={clsx(
                    'absolute h-3 w-3 rounded-full bg-white transition',
                    livePreview ? 'left-3.5' : 'left-0.5',
                  )}
                />
              </span>
              <span className="select-none">实时预览</span>
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ── Sub-filter chips ─────────────────────────────────────── */}
        <div className="flex items-center gap-2 border-b border-white/[0.04] px-6 py-3 text-xs">
          {(Object.keys(SUB_FILTER_LABELS) as SubFilter[]).map((filter) => {
            const isActive = subFilter === filter;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setSubFilter(filter)}
                className={clsx(
                  'rounded-full px-3 py-1 transition',
                  isActive
                    ? 'bg-white/10 text-neutral-100'
                    : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200',
                )}
              >
                {SUB_FILTER_LABELS[filter]}
              </button>
            );
          })}
        </div>

        {/* ── Grid body ────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {!tabAvailable ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              敬请期待
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              暂无可选择的素材
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridSize}px, 1fr))` }}
            >
              {items.map((item) => {
                const selected = selectedIds.includes(item.id);
                const canSelectMore = selected || selectedIds.length < MAX_SELECTION;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={!canSelectMore}
                    onClick={() => toggle(item.id)}
                    className={clsx(
                      'group relative overflow-hidden rounded-xl border bg-[#22232a] text-left transition',
                      selected
                        ? 'border-cyan-400/60 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]'
                        : 'border-white/8 hover:border-white/20',
                      !canSelectMore && 'cursor-not-allowed opacity-40',
                    )}
                  >
                    <div className="relative aspect-square overflow-hidden bg-black/40">
                      {item.kind === 'video' ? (
                        <video
                          src={toRenderableMediaUrl(item.url)}
                          className="h-full w-full object-cover"
                          muted
                          loop
                          playsInline
                          preload="metadata"
                          autoPlay={livePreview}
                          onMouseEnter={(event) => {
                            if (!livePreview) event.currentTarget.play().catch(() => {});
                          }}
                          onMouseLeave={(event) => {
                            if (!livePreview) {
                              event.currentTarget.pause();
                              event.currentTarget.currentTime = 0;
                            }
                          }}
                        />
                      ) : item.kind === 'audio' ? (
                        <div className="flex h-full items-center justify-center text-2xl text-neutral-500">♪</div>
                      ) : (
                        <img src={toRenderableMediaUrl(item.url, { thumbWidth: 720 })} alt={item.title || ''} className="h-full w-full object-cover" loading="lazy" />
                      )}
                      <div
                        className={clsx(
                          'absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border transition',
                          selected
                            ? 'border-cyan-300 bg-cyan-500 text-white'
                            : 'border-white/30 bg-black/40 text-transparent',
                        )}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </div>
                      {item.source === 'canvas' ? (
                        <div className="absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-neutral-300">
                          画布
                        </div>
                      ) : null}
                    </div>
                    {item.title ? (
                      <div className="px-2.5 py-2 text-xs text-neutral-200 line-clamp-1">{item.title}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Footer: count + confirm ──────────────────────────────── */}
        <div className="flex items-center justify-between border-t border-white/8 px-6 py-3">
          <div className="text-xs text-neutral-400">
            已选 <span className="text-cyan-300">{selectedItems.length}</span> / {MAX_SELECTION}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-sm text-neutral-300 transition hover:bg-white/5"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => onConfirm(selectedItems)}
              disabled={selectedItems.length === 0}
              className="rounded-lg bg-cyan-500 px-4 py-1.5 text-sm text-white transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              确认
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
