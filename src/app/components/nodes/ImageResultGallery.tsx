import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Download, Expand, Grid2X2, ImagePlus, Info, Loader2, MoreHorizontal, PanelLeft, X } from 'lucide-react';
import { toast } from 'sonner';
import BatchDownloadPanel from '../BatchDownloadPanel';
import { toRenderableMediaUrl } from '../../reference-media';
import { useActiveProjectReadOnly, useStore } from '../../store';
import { imageGalleryEntries } from '../../image-result-group';
import { mediaDimCache, rememberMediaDims } from '../../media-dims';
import './image-result-gallery.css';

export type ImageResultGalleryMode = 'panel' | 'fullscreen';
export type ImageResultAnchor = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

export function imageResultsFromData(data: Record<string, unknown>): string[] {
  return imageGalleryEntries(data).map(entry => entry.url);
}

type GalleryProps = {
  images: string[];
  primaryUrl: string;
  name?: string;
  zh: boolean;
  mode: ImageResultGalleryMode;
  anchor?: ImageResultAnchor;
  readOnly?: boolean;
  onClose: () => void;
  onExpand?: () => void;
  onSetPrimary: (url: string) => void;
  onAddAll: () => void;
};

function GalleryImage({ url, label, large = false, onFailure, onDimensions }: { url: string; label: string; large?: boolean; onFailure: () => void; onDimensions: (url: string, w: number, h: number) => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [original, setOriginal] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const originalSource = toRenderableMediaUrl(url);
  const source = large || original ? originalSource : toRenderableMediaUrl(url, { thumbWidth: 768 });
  const ready = () => {
    const img = imageRef.current;
    if (!img?.naturalWidth || !img.naturalHeight) return;
    onDimensions(url, img.naturalWidth, img.naturalHeight);
    setState('ready');
  };
  useEffect(() => { setState('loading'); setOriginal(false); }, [url, large]);
  useEffect(() => {
    if (imageRef.current?.complete) ready();
  }, [url, large]);
  return <>
    {state !== 'error' && <img ref={imageRef} src={source}
      alt={label} draggable={false} loading="lazy" onLoad={ready} onError={() => {
        if (!large && !original && source !== originalSource) { setOriginal(true); return; }
        setState('error'); onFailure();
      }} />}
    {state !== 'ready' && <span className="image-result-placeholder" role="status">
      {state === 'error' ? <><Info size={18} /><span>{label.startsWith('图片') ? '图片加载失败' : 'Image could not load'}</span></> : <Loader2 size={20} className="image-result-spin" />}
    </span>}
  </>;
}

function trapFocus(event: KeyboardEvent, ref: RefObject<HTMLElement | null>) {
  if (event.key !== 'Tab' || !ref.current) return;
  const focusable = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], summary, [tabindex="0"]')];
  const first = focusable[0], last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}

/** A portal keeps the gallery independent of canvas zoom and node clipping. */
export function ImageResultGallery({ images, primaryUrl, name = '图片', zh, mode, anchor, readOnly, onClose, onExpand, onSetPrimary, onAddAll }: GalleryProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<'grid' | 'single'>('grid');
  const [active, setActive] = useState(Math.max(0, images.indexOf(primaryUrl)));
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const measure = useCallback((url: string, w: number, h: number) => {
    rememberMediaDims(url, w, h);
    setRatios(previous => previous[url] === w / h ? previous : { ...previous, [url]: w / h });
  }, []);
  const ratio = (url: string) => {
    const cached = mediaDimCache.get(url);
    return ratios[url] || (cached ? cached.w / cached.h : 16 / 9);
  };
  const dialogRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const fullscreen = mode === 'fullscreen';
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const downloads = useMemo(() => images.map((url, index) => ({ id: String(index), url, kind: 'image' as const, name: `${name}-${index + 1}` })), [images, name]);

  useLayoutEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (menuOpen) setMenuOpen(false);
        else if (downloadOpen) setDownloadOpen(false);
        else closeRef.current();
      } else if (fullscreen && view === 'single' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        setActive(index => (index + (event.key === 'ArrowRight' ? 1 : images.length - 1)) % images.length);
      }
      trapFocus(event, dialogRef);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [menuOpen, downloadOpen, fullscreen, view, images.length]);
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, images.length - 1))); }, [images.length]);

  // Keep the common four-image batch visible without scrolling on laptop screens.
  const width = Math.min(650, viewport.width - 32, images.length <= 4 ? Math.max(280, viewport.height - 120) : 650);
  const height = Math.min(720, viewport.height - 48);
  const rows = Math.ceil(images.length / 2);
  const estimatedHeight = Math.min(height, Array.from({ length: rows }, (_, row) =>
    Math.max(...images.slice(row * 2, row * 2 + 2).map(url => (width - 56) / 2 / ratio(url))))
    .reduce((total, rowHeight) => total + rowHeight, 0) + Math.max(0, rows - 1) * 12 + 92);
  const centerX = anchor ? anchor.left + anchor.width / 2 : viewport.width / 2;
  const centerY = anchor ? anchor.top + anchor.height / 2 : viewport.height / 2;
  const panelStyle = fullscreen ? undefined : {
    width,
    maxHeight: height,
    left: Math.max(16, Math.min(viewport.width - width - 16, centerX - width / 2)),
    top: Math.max(24, Math.min(viewport.height - estimatedHeight - 24, centerY - estimatedHeight / 2)),
  };
  const setPrimary = (url: string) => { if (!readOnly && !failed.has(url)) onSetPrimary(url); };
  const addAll = () => { setMenuOpen(false); onAddAll(); };
  const downloadAll = () => { setMenuOpen(false); setDownloadOpen(true); };
  const current = images[active];
  const markFailed = (url: string) => setFailed(previous => previous.has(url) ? previous : new Set(previous).add(url));
  const tile = (url: string, index: number) => <button key={`${index}:${url}`} type="button"
    className={`image-result-tile${url === primaryUrl ? ' is-primary' : ''}`}
    style={{ aspectRatio: ratio(url) }}
    aria-label={`${zh ? '图片' : 'Image'} ${index + 1}${url === primaryUrl ? (zh ? '，主图' : ', primary') : ''}`}
    aria-current={url === primaryUrl ? 'true' : undefined}
    onClick={() => { setActive(index); setPrimary(url); }}
    onDoubleClick={() => { setActive(index); if (fullscreen) setView('single'); else onExpand?.(); }}>
    <GalleryImage url={url} label={`${zh ? '图片' : 'Image'} ${index + 1}`} onFailure={() => markFailed(url)} onDimensions={measure} />
    {url === primaryUrl ? <span className="image-result-main-badge">{zh ? (fullscreen ? '主图' : '当前图片') : 'Primary'}</span>
      : !readOnly && !failed.has(url) && <span className="image-result-set-main"><ImagePlus size={14} />{zh ? '设为主图' : 'Set as primary'}</span>}
  </button>;

  return createPortal(<div className={`image-result-overlay nodrag nopan nowheel${fullscreen ? ' is-fullscreen' : ''}`}
    onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={zh ? (fullscreen ? '图片全屏浏览' : '图片历史记录') : 'Image results'}
      className={`image-result-dialog${fullscreen ? ' is-fullscreen' : ''}`} style={panelStyle}
      onPointerDown={event => { if (menuOpen && !menuRef.current?.contains(event.target as globalThis.Node)) setMenuOpen(false); }}>
      <header className="image-result-header">
        {fullscreen ? <div className="image-result-toolbar">
          <div className="image-result-view-toggle">
            <button type="button" aria-label={zh ? '单图视图' : 'Single image'} aria-pressed={view === 'single'} onClick={() => setView('single')}><PanelLeft size={16} /></button>
            <button type="button" aria-label={zh ? '网格视图' : 'Grid view'} aria-pressed={view === 'grid'} onClick={() => setView('grid')}><Grid2X2 size={16} /></button>
          </div>
          <div className="image-result-bulk-actions">
            <button type="button" onClick={downloadAll}><Download size={15} />{zh ? '下载全部' : 'Download all'}</button>
            {!readOnly && <button type="button" onClick={addAll}><ImagePlus size={15} />{zh ? '全部添加到画布' : 'Add all to canvas'}</button>}
          </div>
        </div> : <h2>{zh ? '历史记录' : 'History'} <span>{images.length}</span></h2>}
        <div className="image-result-header-actions">
          {!fullscreen && <div className="image-result-menu-wrap" ref={menuRef}>
            <button type="button" aria-label={zh ? '更多图片操作' : 'More image actions'} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}><MoreHorizontal size={18} /></button>
            {menuOpen && <div className="image-result-menu" role="menu" aria-label={zh ? '图片操作' : 'Image actions'}>
              {!readOnly && <button role="menuitem" type="button" onClick={addAll}><ImagePlus size={16} />{zh ? '全部添加到画布' : 'Add all to canvas'}</button>}
              <button role="menuitem" type="button" onClick={downloadAll}><Download size={16} />{zh ? '下载全部' : 'Download all'}</button>
            </div>}
          </div>}
          {!fullscreen && <button type="button" aria-label={zh ? '放大图片组' : 'Expand image results'} onClick={onExpand}><Expand size={17} /></button>}
          {fullscreen && <button className="image-result-close" type="button" aria-label={zh ? '关闭图片浏览' : 'Close image results'} onClick={onClose}><X size={23} /></button>}
        </div>
      </header>
      {fullscreen && view === 'single' ? <div className="image-result-single">
        <div className="image-result-single-stage">
          <button className="image-result-previous" type="button" aria-label={zh ? '上一张' : 'Previous image'} onClick={() => setActive(index => (index + images.length - 1) % images.length)}><ChevronLeft size={24} /></button>
          <div className="image-result-single-image">
            <GalleryImage key={current} url={current} label={`${zh ? '图片' : 'Image'} ${active + 1}`} large onFailure={() => markFailed(current)} onDimensions={measure} />
            {current === primaryUrl ? <span className="image-result-main-badge">{zh ? '主图' : 'Primary'}</span>
              : !readOnly && !failed.has(current) && <button type="button" className="image-result-set-main" onClick={() => setPrimary(current)}><ImagePlus size={14} />{zh ? '设为主图' : 'Set as primary'}</button>}
          </div>
          <button className="image-result-next" type="button" aria-label={zh ? '下一张' : 'Next image'} onClick={() => setActive(index => (index + 1) % images.length)}><ChevronRight size={24} /></button>
        </div>
        <div className="image-result-filmstrip" aria-label={zh ? '图片缩略图' : 'Image thumbnails'}>{images.map((url, index) => <button type="button" key={`${index}:${url}`} style={{ width: 60 * ratio(url) }} aria-label={`${zh ? '查看图片' : 'View image'} ${index + 1}`} aria-current={index === active ? 'true' : undefined} onClick={() => setActive(index)}>
          <img src={toRenderableMediaUrl(url, { thumbWidth: 256 })} alt="" draggable={false} />
        </button>)}</div>
      </div> : <div className="image-result-grid">{images.map(tile)}</div>}
      {downloadOpen && <BatchDownloadPanel items={downloads} zh={zh} onClose={() => setDownloadOpen(false)} />}
    </section>
  </div>, document.body);
}

/** Image history entry point for image-based nodes such as panoramas. */
export function ImageResultGalleryBadge({ nodeId }: { nodeId: string }) {
  const data = useStore(state => state.nodes.find(node => node.id === nodeId)?.data);
  const zh = useStore(state => state.language) === 'zh';
  const [mode, setMode] = useState<ImageResultGalleryMode | null>(null);
  const [anchor, setAnchor] = useState<ImageResultAnchor>();
  const count = imageResultsFromData(data ?? {}).length;
  if (count < 2) return null;
  return <>
    <button type="button" className="image-result-count nodrag nopan" aria-label={zh ? `查看 ${count} 张图片` : `View ${count} images`}
      aria-haspopup="dialog" aria-expanded={mode !== null}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); setAnchor(event.currentTarget.parentElement?.getBoundingClientRect()); setMode('panel'); }}>
      {zh ? `${count} 张` : `${count} images`}<ChevronDown size={12} />
    </button>
    {mode && <NodeImageResultGallery nodeId={nodeId} mode={mode} anchor={anchor} onClose={() => setMode(null)} onExpand={() => setMode('fullscreen')} />}
  </>;
}

export function NodeImageResultGallery({ nodeId, mode, anchor, onClose, onExpand }: { nodeId: string; mode: ImageResultGalleryMode; anchor?: ImageResultAnchor; onClose: () => void; onExpand?: () => void }) {
  const data = useStore(state => state.nodes.find(node => node.id === nodeId)?.data);
  const zh = useStore(state => state.language) === 'zh';
  const setPrimary = useStore(state => state.setNodePrimaryImage);
  const addAll = useStore(state => state.addNodeImagesToCanvas);
  const readOnly = useActiveProjectReadOnly();
  const images = imageResultsFromData(data ?? {});
  if (images.length < 2) return null;
  return <ImageResultGallery images={images} primaryUrl={String(data?.url ?? '')} name={String(data?.customTitle || data?.sourceName || (zh ? '图片' : 'Image'))}
    zh={zh} mode={mode} anchor={anchor} readOnly={readOnly} onClose={onClose} onExpand={onExpand}
    onSetPrimary={url => setPrimary(nodeId, url)} onAddAll={() => {
      const before = useStore.getState().nodes.length;
      addAll(nodeId);
      const count = useStore.getState().nodes.length - before;
      if (count > 0) toast.success(zh ? `已添加 ${count} 张到画布` : `Added ${count} images to canvas`);
      else toast.info(zh ? '这些图片已在画布中' : 'These images are already on the canvas');
    }} />;
}
