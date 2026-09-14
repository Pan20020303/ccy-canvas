import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Crosshair, Download, ImageOff, Info, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { useStore } from '../../../store';
import { useCanvasPreferences } from '../../../canvas-preferences';
import { toRenderableMediaUrl } from '../../../reference-media';
import { ImagePreview } from './ImagePreview';
import { VideoPreview, type PlaybackPreferences } from './VideoPreview';
import { PreviewButton } from './PreviewButton';
import { formatMediaBytes, neighboringMediaIds, nodePreviewItem, previewDownloadName, type MediaDimensions, type MediaKind, type PreviewItem } from './media-preview-model';
import './media-preview.css';

export type MediaPreviewProps = {
  kind: MediaKind;
  src: string;
  nodeId?: string;
  onClose: () => void;
  onDownload: (src: string, filename: string) => Promise<void>;
};

function PreviewThumbnail({ item, selected, onSelect }: { item: PreviewItem; selected: boolean; onSelect: () => void }) {
  const [failed, setFailed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = button.current;
    if (!element) return;
    if (selected) element.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected]);
  return <button ref={button} type="button" className="media-preview-thumbnail" data-kind={item.kind} aria-current={selected ? 'true' : undefined} aria-label={item.title} title={item.title} onClick={onSelect}>
    {failed ? <ImageOff /> : item.kind === 'image' || item.poster
      ? <img loading="lazy" src={toRenderableMediaUrl(item.kind === 'image' ? item.src : item.poster!, { thumbWidth: 160 })} alt="" onError={() => setFailed(true)} />
      : visible ? <video src={toRenderableMediaUrl(item.src)} preload="metadata" muted playsInline onError={() => setFailed(true)} /> : <Play />}
    {item.kind === 'video' && <Play className="media-preview-thumbnail-play" />}
    <span>{item.title}</span>
  </button>;
}

export function MediaPreviewModal({ kind, src, nodeId, onClose, onDownload }: MediaPreviewProps) {
  const nodes = useStore(state => state.nodes);
  const zh = useStore(state => state.language) === 'zh';
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialId = nodeId || '__standalone-preview__';
  const [neighbors] = useState(() => useCanvasPreferences.getState().values.linkedPreview ? neighboringMediaIds(useStore.getState().nodes, nodeId) : nodeId ? [nodeId] : []);
  const [selectedId, setSelectedId] = useState(initialId);
  const [revision, setRevision] = useState(0);
  const [info, setInfo] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [measured, setMeasured] = useState<{ key: string; dimensions: MediaDimensions } | null>(null);
  const [preferences, setPreferences] = useState<PlaybackPreferences>({ volume: 0.7, rate: 1, loop: false });
  const items = useMemo(() => {
    if (!nodeId) return [{ id: initialId, kind, src, title: zh ? (kind === 'image' ? '图片预览' : '视频预览') : 'Media preview' }];
    const map = new Map(nodes.map(node => [node.id, node]));
    return neighbors.flatMap(id => { const node = map.get(id); const item = node ? nodePreviewItem(node, zh) : null; return item ? [item] : []; });
  }, [initialId, kind, neighbors, nodeId, nodes, src, zh]);
  const selected = items.find(item => item.id === selectedId) || items[0];
  const index = selected ? items.indexOf(selected) : -1;
  const itemKey = selected ? `${selected.id}:${selected.src}:${revision}` : '';
  const dimensions = measured?.key === itemKey ? measured.dimensions : selected?.width && selected.height ? { width: selected.width, height: selected.height } : null;
  const resolution = dimensions ? `${dimensions.width} × ${dimensions.height}` : '';
  const bytes = formatMediaBytes(selected?.bytes);
  const select = (item: PreviewItem) => { setSelectedId(item.id); setDownloadError(''); dialogRef.current?.focus(); };
  const adjacent = (delta: number) => { if (items.length > 1) select(items[(index + delta + items.length) % items.length]); };
  const reload = () => { setRevision(value => value + 1); setDownloadError(''); };

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="media-preview-backdrop" />
      <Dialog.Content ref={dialogRef} tabIndex={-1} className="media-preview-dialog nodrag nopan nowheel" aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); dialogRef.current?.focus(); }}
        onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea')) return;
          if (event.key === 'ArrowLeft') { event.preventDefault(); adjacent(-1); }
          if (event.key === 'ArrowRight') { event.preventDefault(); adjacent(1); }
          if (event.key === 'Delete' || event.key === 'Backspace') event.preventDefault();
        }} onEscapeKeyDown={event => event.stopPropagation()}>
        <Dialog.Title className="media-preview-sr-only">{selected?.title || (zh ? '媒体预览' : 'Media preview')}</Dialog.Title>
        <div className="media-preview-top-left media-preview-pill">
          <PreviewButton label={zh ? '素材信息' : 'Media information'} aria-expanded={info} onClick={() => setInfo(!info)}><Info /></PreviewButton>
          <span className="media-preview-divider" />
          <PreviewButton label={zh ? '重新加载' : 'Reload'} disabled={!selected} onClick={reload}><RefreshCw /></PreviewButton>
        </div>
        {info && <section className="media-preview-info" aria-label={zh ? '素材详情' : 'Media details'}>
          <h2>{selected?.title}</h2>
          <dl><dt>{zh ? '类型' : 'Type'}</dt><dd>{selected?.kind === 'image' ? (zh ? '图片' : 'Image') : (zh ? '视频' : 'Video')}</dd>
            <dt>{zh ? '分辨率' : 'Dimensions'}</dt><dd>{resolution || (zh ? '等待媒体加载' : 'Waiting for media')}</dd>
            <dt>{zh ? '文件大小' : 'File size'}</dt><dd>{bytes || (zh ? '未提供' : 'Not provided')}</dd>
            {selected?.nodeId && <><dt>{zh ? '节点' : 'Node'}</dt><dd>{selected.nodeId}</dd></>}
          </dl>
          {selected?.prompt && <p className="media-preview-info-prompt">{selected.prompt}</p>}
        </section>}
        <div className="media-preview-top-right">
          {selected?.kind === 'video' && (resolution || bytes) && <span className="media-preview-pill media-preview-file-info">{[resolution, bytes].filter(Boolean).join(' · ')}</span>}
          <PreviewButton className="media-preview-pill" label={zh ? '下载原文件' : 'Download original'} disabled={!selected || downloading} onClick={async () => {
            if (!selected || downloading) return;
            setDownloading(true); setDownloadError('');
            try { await onDownload(selected.src, previewDownloadName(selected)); }
            catch { setDownloadError(zh ? '下载失败，请检查网络后重试。' : 'Download failed. Check your connection and retry.'); }
            finally { setDownloading(false); }
          }}>{downloading ? <Loader2 className="media-preview-spin" /> : <Download />}</PreviewButton>
          <PreviewButton className="media-preview-pill media-preview-close" label={zh ? '关闭预览' : 'Close preview'} onClick={onClose}><X /><kbd>Esc</kbd></PreviewButton>
        </div>
        {downloadError && <div className="media-preview-download-error" role="alert">{downloadError}</div>}
        {selected ? selected.kind === 'image'
          ? <ImagePreview key={itemKey} item={selected} zh={zh} onDimensions={value => setMeasured({ key: itemKey, dimensions: value })} />
          : <VideoPreview key={itemKey} item={selected} zh={zh} preferences={preferences} onPreferences={setPreferences} onDimensions={value => setMeasured({ key: itemKey, dimensions: value })} />
          : <div className="media-preview-status" role="status">{zh ? '这些节点已移除或暂时没有可预览的素材。' : 'These nodes no longer have previewable media.'}</div>}
        {items.length > 1 && <>
          <PreviewButton className="media-preview-previous media-preview-pill" label={zh ? '上一个节点' : 'Previous node'} onClick={() => adjacent(-1)}><ChevronLeft /></PreviewButton>
          <PreviewButton className="media-preview-next media-preview-pill" label={zh ? '下一个节点' : 'Next node'} onClick={() => adjacent(1)}><ChevronRight /></PreviewButton>
        </>}
        {selected && <div className="media-preview-bottom">
          <div className="media-preview-navigation">
            <span className="media-preview-pill" aria-live="polite">{zh ? '相邻节点' : 'Nearby nodes'} {index + 1} / {items.length}</span>
            {items.length > 1 && <span className="media-preview-pill media-preview-key-hint"><kbd>←</kbd><kbd>→</kbd> {zh ? '切换' : 'Switch'}</span>}
            <button className="media-preview-pill media-preview-locate" disabled={!selected.nodeId} onClick={() => {
              if (!selected.nodeId || !useStore.getState().nodes.some(node => node.id === selected.nodeId)) return;
              onClose(); useStore.getState().requestCanvasFocus(selected.nodeId);
            }}><Crosshair />{zh ? '定位到节点' : 'Locate node'}</button>
          </div>
          <div className="media-preview-thumbnails" role="group" aria-label={zh ? '相邻节点缩略图' : 'Nearby node thumbnails'}>
            {items.map(item => <PreviewThumbnail key={`${item.id}:${item.src}`} item={item} selected={item.id === selected.id} onSelect={() => select(item)} />)}
          </div>
        </div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
