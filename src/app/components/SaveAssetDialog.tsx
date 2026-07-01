import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, Image as ImageIcon, Video as VideoIcon, Type } from 'lucide-react';
import clsx from 'clsx';
import { toRenderableMediaUrl } from '../reference-media';
import { useStore, ASSET_CATEGORIES, type SavedAssetCategory } from '../store';

const SAVABLE_CATEGORIES = ASSET_CATEGORIES.filter((c) => c.key !== 'all') as { key: SavedAssetCategory; zh: string; en: string }[];

export function SaveAssetDialog() {
  const nodeId = useStore((s) => s.saveAssetDialogNodeId);
  const close = useStore((s) => s.closeSaveAssetDialog);
  const nodes = useStore((s) => s.nodes);
  const language = useStore((s) => s.language);
  const saveAsset = useStore((s) => s.saveAsset);
  const setAssetLibraryOpen = useStore((s) => s.setAssetLibraryOpen);

  const node = useMemo(() => nodes.find((n) => n.id === nodeId), [nodes, nodeId]);

  const [name, setName] = useState('');
  const [category, setCategory] = useState<SavedAssetCategory>('scene');
  const [categoryOpen, setCategoryOpen] = useState(false);

  useEffect(() => {
    if (!node) return;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const defaultName = (data.sourceName as string) || (data.customTitle as string) || (language === 'zh' ? '图片素材' : 'Image Asset');
    setName(defaultName);
  }, [node, language]);

  if (!node) return null;

  const data = (node.data ?? {}) as Record<string, string>;
  const url = data.url || '';
  const thumb = data.thumbnail || data.url || '';
  const text = data.content || '';
  const kind: 'image' | 'video' | 'text' = node.type === 'videoNode' || node.type === 'referenceVideoNode' ? 'video'
    : node.type === 'textNode' ? 'text'
    : 'image';

  const onConfirm = () => {
    if (!name.trim()) return;
    saveAsset({
      name: name.trim(),
      category,
      thumbnail: thumb,
      url,
      kind,
      text: kind === 'text' ? text : undefined,
    });
    close();
    setAssetLibraryOpen(true);
  };

  const categoryLabel = SAVABLE_CATEGORIES.find((c) => c.key === category);

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 backdrop-blur-sm" onClick={close}>
      <div
        className="relative w-[780px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#1a1d22]/98 p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-neutral-100 font-medium">{language === 'zh' ? '创建素材文件夹' : 'Create Asset Folder'}</span>
            <span className="text-neutral-500">{language === 'zh' ? '添加到现有素材文件夹' : 'Add to Existing Folder'}</span>
          </div>
          <button onClick={close} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <div className="mb-2 text-sm text-neutral-300">{language === 'zh' ? '封面' : 'Cover'}</div>
            <div className="aspect-video overflow-hidden rounded-xl border border-white/8 bg-black/40">
              {kind === 'image' && url ? (
                <img src={toRenderableMediaUrl(url)} alt="" className="h-full w-full object-cover" />
              ) : kind === 'video' && url ? (
                <video src={toRenderableMediaUrl(url)} className="h-full w-full object-cover" muted />
              ) : kind === 'text' ? (
                <div className="flex h-full items-center justify-center p-4 text-center text-xs text-neutral-400">
                  <Type className="mr-2 h-4 w-4" />
                  <span className="line-clamp-6">{text || (language === 'zh' ? '文本节点' : 'Text node')}</span>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-neutral-500">
                  {kind === 'video' ? <VideoIcon className="h-8 w-8" /> : <ImageIcon className="h-8 w-8" />}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-2 text-sm text-neutral-300">
                {language === 'zh' ? '名称 *' : 'Name *'}
              </div>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={language === 'zh' ? '图片素材' : 'Image asset'}
                className="w-full rounded-lg border border-white/10 bg-[#0f1115] px-3 py-2 text-sm text-neutral-100 outline-none focus:border-cyan-400/40"
              />
            </div>
            <div className="relative">
              <div className="mb-2 text-sm text-neutral-300">
                {language === 'zh' ? '分类 *' : 'Category *'}
              </div>
              <button
                type="button"
                onClick={() => setCategoryOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-[#0f1115] px-3 py-2 text-sm text-neutral-200 transition hover:bg-white/5"
              >
                <span>{categoryLabel ? (language === 'zh' ? categoryLabel.zh : categoryLabel.en) : (language === 'zh' ? '请选择' : 'Choose')}</span>
                <ChevronDown className="h-4 w-4 text-neutral-500" />
              </button>
              {categoryOpen ? (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setCategoryOpen(false)} />
                  <div className="absolute left-0 right-0 z-20 mt-1 max-h-[200px] overflow-y-auto rounded-lg border border-white/10 bg-[#1a1d22] py-1 shadow-2xl">
                    {SAVABLE_CATEGORIES.map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => { setCategory(opt.key); setCategoryOpen(false); }}
                        className={clsx(
                          'w-full px-3 py-2 text-left text-sm transition hover:bg-white/5',
                          opt.key === category ? 'text-cyan-300' : 'text-neutral-200',
                        )}
                      >
                        {language === 'zh' ? opt.zh : opt.en}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onConfirm}
            disabled={!name.trim()}
            className="rounded-lg bg-cyan-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {language === 'zh' ? '创建' : 'Create'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
