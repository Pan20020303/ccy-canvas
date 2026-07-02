import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, FolderHeart, Image as ImageIcon, Music, Plus, Save, Trash2, Video, X } from 'lucide-react';
import clsx from 'clsx';

import { useStore, ASSET_CATEGORIES, type SavedAsset, type SavedAssetCategory } from '../store';
import { MediaThumb } from './MediaThumb';

/**
 * 资产库 — the centered asset-library modal (replaces the old dock side panel).
 * Tabs: 素材库 (saved assets, backend-persisted) and 画布资产 (media nodes on the
 * current canvas, with one-click save into the library). Modeled on the
 * reference app's 资产库 dialog: category dropdown + kind chips + card grid +
 * a three-step empty state.
 */

type KindFilter = 'all' | 'image' | 'video' | 'text';

const KIND_CHIPS: { key: KindFilter; zh: string; en: string }[] = [
  { key: 'all', zh: '全部', en: 'All' },
  { key: 'image', zh: '图片', en: 'Images' },
  { key: 'video', zh: '视频', en: 'Videos' },
  { key: 'text', zh: '文本', en: 'Text' },
];

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
  const zh = language === 'zh';

  const [tab, setTab] = useState<'library' | 'canvas'>('library');
  const [category, setCategory] = useState<SavedAssetCategory | 'all'>('all');
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [kind, setKind] = useState<KindFilter>('all');

  // Pull server-persisted assets + reset filters each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      hydrateAssets();
      setTab('library');
      setCategory('all');
      setKind('all');
      setCategoryOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const filteredAssets = useMemo(() => savedAssets.filter((asset) => {
    if (category !== 'all' && asset.category !== category) return false;
    if (kind !== 'all' && asset.kind !== kind) return false;
    return true;
  }), [savedAssets, category, kind]);

  const canvasMedia = useMemo(() => nodes.filter((n) => {
    const t = String(n.type ?? '');
    if (!/image|video|audio|panorama/i.test(t)) return false;
    const data = (n.data ?? {}) as Record<string, unknown>;
    return typeof data.url === 'string' && (data.url as string).length > 0;
  }), [nodes]);

  if (!isOpen) return null;

  const useAsset = (asset: SavedAsset) => {
    const id = `asset-use-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const position = { x: 240 + Math.random() * 60, y: 180 + Math.random() * 60 };
    if (asset.kind === 'image') {
      addNode({ id, type: 'referenceImageNode', position, data: { url: asset.url, sourceName: asset.name, sourceKind: 'upload' } } as never);
    } else if (asset.kind === 'video') {
      addNode({ id, type: 'referenceVideoNode', position, data: { url: asset.url, sourceName: asset.name, sourceKind: 'upload' } } as never);
    } else {
      addNode({ id, type: 'textNode', position, data: { content: asset.text ?? '', customTitle: asset.name, textMode: 'editor' } } as never);
    }
    close(false);
  };

  const categoryLabel = category === 'all'
    ? (zh ? '全部分类' : 'All categories')
    : (() => { const c = ASSET_CATEGORIES.find((x) => x.key === category); return c ? (zh ? c.zh : c.en) : ''; })();

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm" onClick={() => close(false)}>
      <div
        className="flex h-[86vh] w-[1160px] max-w-[94vw] flex-col rounded-2xl border border-white/10 bg-[#141519]/98 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header: title + tabs + close */}
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
                onClick={() => setTab(t.key)}
                className={clsx(
                  'border-b-2 pb-3 text-[13px] transition',
                  tab === t.key ? 'border-cyan-400 font-medium text-neutral-50' : 'border-transparent text-neutral-500 hover:text-neutral-200',
                )}
              >
                {zh ? t.zh : t.en}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => close(false)}
            className="ml-auto mb-3 flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-white/8 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {tab === 'library' ? (
          <>
            {/* Filter row: category dropdown + kind chips */}
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
                          className={clsx(
                            'w-full px-3 py-1.5 text-left text-xs transition hover:bg-white/5',
                            c.key === category ? 'text-cyan-300' : 'text-neutral-200',
                          )}
                        >
                          {zh ? c.zh : c.en}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
              {KIND_CHIPS.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setKind(chip.key)}
                  className={clsx(
                    'rounded-full px-3 py-1.5 text-xs transition',
                    kind === chip.key ? 'bg-white/12 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200',
                  )}
                >
                  {zh ? chip.zh : chip.en}
                </button>
              ))}
            </div>

            {/* Asset grid / empty state */}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
              {filteredAssets.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.04] text-neutral-500">
                    <Save className="h-7 w-7" />
                  </div>
                  <div className="text-[15px] font-medium text-neutral-200">{zh ? '素材库为空' : 'Library is empty'}</div>
                  <div className="text-xs text-neutral-500">
                    {zh ? '在工作流画布中右键点击节点，即可保存到素材库' : 'Right-click a canvas node to save it into the library'}
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
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
                  {filteredAssets.map((asset) => (
                    <div key={asset.id} className="group relative overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] transition hover:border-white/16">
                      <button type="button" onClick={() => useAsset(asset)} className="block w-full text-left" title={zh ? '添加到画布' : 'Add to canvas'}>
                        <div className="aspect-square overflow-hidden bg-black/40">
                          {asset.kind === 'image' ? (
                            <MediaThumb src={asset.thumbnail || asset.url} alt="" className="h-full w-full object-cover" onDead={() => removeAsset(asset.id)} />
                          ) : asset.kind === 'video' && asset.url ? (
                            <div className="flex h-full w-full items-center justify-center text-neutral-500"><Video className="h-7 w-7" /></div>
                          ) : (
                            <div className="flex h-full items-center justify-center p-3 text-center text-[11px] text-neutral-400">
                              <span className="line-clamp-5">{asset.text || asset.name}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                          <span className="truncate text-xs text-neutral-200">{asset.name}</span>
                          <span className="shrink-0 rounded bg-white/6 px-1.5 py-0.5 text-[10px] text-neutral-500">
                            {(() => { const c = ASSET_CATEGORIES.find((x) => x.key === asset.category); return c ? (zh ? c.zh : c.en) : asset.category; })()}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); removeAsset(asset.id); }}
                        className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md bg-black/70 text-rose-300 transition hover:bg-rose-500/25 group-hover:flex"
                        title={zh ? '删除' : 'Delete'}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          /* 画布资产: media nodes on the current canvas, one-click save into the library. */
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {canvasMedia.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
                <FolderHeart className="h-8 w-8" />
                <div className="text-sm">{zh ? '当前画布还没有媒体节点' : 'No media nodes on this canvas yet'}</div>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
                {canvasMedia.map((node) => {
                  const data = (node.data ?? {}) as Record<string, unknown>;
                  const url = String(data.url ?? '');
                  const t = String(node.type ?? '');
                  const isImage = /image|panorama/i.test(t);
                  const isVideo = /video/i.test(t);
                  const name = (typeof data.customTitle === 'string' && data.customTitle)
                    || (typeof data.sourceName === 'string' && data.sourceName)
                    || (zh ? (isImage ? '图片' : isVideo ? '视频' : '音频') : (isImage ? 'Image' : isVideo ? 'Video' : 'Audio'));
                  return (
                    <div key={node.id} className="group relative overflow-hidden rounded-xl border border-white/8 bg-white/[0.02] transition hover:border-white/16">
                      <div className="aspect-square overflow-hidden bg-black/40">
                        {isImage ? (
                          <MediaThumb src={String(data.thumbnail ?? '') || url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-neutral-500">
                            {isVideo ? <Video className="h-7 w-7" /> : <Music className="h-7 w-7" />}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                        <span className="truncate text-xs text-neutral-200">{name}</span>
                        <span className="shrink-0 text-[10px] text-neutral-500">
                          {isImage ? <ImageIcon className="h-3 w-3" /> : isVideo ? <Video className="h-3 w-3" /> : <Music className="h-3 w-3" />}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => { close(false); openSaveAssetDialog(node.id); }}
                        className="absolute right-2 top-2 hidden items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[10.5px] text-cyan-200 transition hover:bg-cyan-500/20 group-hover:flex"
                        title={zh ? '保存到素材库' : 'Save to library'}
                      >
                        <Plus className="h-3 w-3" />
                        {zh ? '存入素材库' : 'Save'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

