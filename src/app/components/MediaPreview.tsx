import { useEffect, useMemo, useRef, useState } from 'react';
import Lightbox, { type Slide, type ZoomRef } from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen';
import type {} from 'yet-another-react-lightbox/plugins/video';
import Plyr from 'plyr';
import plyrIcons from '../../../node_modules/plyr/dist/plyr.svg?url';
import { Download, Maximize, Pencil, RotateCcw, Scissors, Sparkles, X, ZoomIn, ZoomOut } from 'lucide-react';
import { toRenderableMediaUrl } from '../reference-media';
import { fitMedia } from './media-preview-utils';
import 'yet-another-react-lightbox/styles.css';
import 'plyr/dist/plyr.css';
import './media-preview.css';

type Props = {
  kind: 'image' | 'video';
  src: string;
  title?: string;
  zh?: boolean;
  onClose: () => void;
  onDownload: () => Promise<void>;
  onEdit?: () => void;
  onUpscale?: () => void;
};

// A custom image slide lets Zoom measure the fitted element (including small
// images enlarged to fit), instead of clamping pan bounds to intrinsic pixels.
declare module 'yet-another-react-lightbox' {
  interface SlideTypes {
    'canvas-image': { type: 'canvas-image'; src: string };
  }
}

function LoadError({ zh, onRetry }: { zh: boolean; onRetry: () => void }) {
  return <div className="ccy-preview-error" role="alert">
    <strong>{zh ? '素材加载失败' : 'Media could not be loaded'}</strong>
    <p>{zh ? '请重试；若仍失败，请检查文件是否可访问或视频编码是否受浏览器支持。' : 'Retry, or check file access and browser codec support.'}</p>
    <button className="ccy-preview-button" onClick={onRetry}><RotateCcw size={16} />{zh ? '重新加载' : 'Retry'}</button>
  </div>;
}

// Plyr owns the media element below this host. React never reconciles its mutated
// children, and destroy + pause releases media resources on close or retry.
export function PreviewVideo({ src, zh, rect, onDimensions }: {
  src: string; zh: boolean; rect: { width: number; height: number };
  onDimensions: (width: number, height: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dims, setDims] = useState({ width: 16, height: 9 });
  const dimensionsCallback = useRef(onDimensions);
  dimensionsCallback.current = onDimensions;
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    setError(false);
    setLoading(true);
    const video = document.createElement('video');
    video.src = src;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'auto';
    container.appendChild(video);
    const metadata = () => {
      if (video.videoWidth && video.videoHeight) {
        setDims({ width: video.videoWidth, height: video.videoHeight });
        dimensionsCallback.current(video.videoWidth, video.videoHeight);
      }
    };
    const ready = () => { setLoading(false); setError(false); };
    const failed = () => { setError(true); setLoading(false); };
    video.addEventListener('loadedmetadata', metadata);
    video.addEventListener('loadeddata', ready);
    video.addEventListener('error', failed);
    const player = new Plyr(video, {
      iconUrl: plyrIcons,
      loadSprite: true,
      blankVideo: '',
      autoplay: false,
      hideControls: false,
      storage: { enabled: false },
      keyboard: { focused: true, global: false },
      controls: ['play-large', 'play', 'rewind', 'fast-forward', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'fullscreen'],
      settings: ['speed'],
      speed: { selected: 1, options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] },
      fullscreen: { enabled: true, fallback: true, iosNative: true },
      i18n: zh ? {
        restart: '重新开始', rewind: '后退 {seektime} 秒', play: '播放', pause: '暂停',
        fastForward: '前进 {seektime} 秒', seek: '播放进度', seekLabel: '{currentTime} / {duration}',
        played: '已播放', buffered: '已缓冲', currentTime: '当前时间', duration: '时长',
        volume: '音量', mute: '静音', unmute: '取消静音', enableCaptions: '打开字幕',
        disableCaptions: '关闭字幕', download: '下载', enterFullscreen: '全屏',
        exitFullscreen: '退出全屏', settings: '设置', pip: '画中画', speed: '播放速度', normal: '正常',
        normalSpeed: '正常', quality: '画质', loop: '循环', start: '开始', end: '结束', all: '全部',
        allLoop: '循环全部', reset: '重置', disabled: '关闭', enabled: '开启', menuBack: '返回',
      } : undefined,
    });
    const stalled = window.setTimeout(() => {
      if (video.readyState < 2) failed();
    }, 30000);
    return () => {
      clearTimeout(stalled);
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('loadeddata', ready);
      video.removeEventListener('error', failed);
      video.pause();
      player.destroy();
      video.removeAttribute('src');
      video.load();
      container.replaceChildren();
    };
  }, [src, zh, attempt]);
  const size = fitMedia(dims.width, dims.height, rect.width, rect.height);
  return <div className="ccy-preview-video-stage" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
    <div className="ccy-preview-video-host" ref={host} style={{ width: size.width, height: size.height, visibility: error ? 'hidden' : undefined }} />
    {loading && <div className="ccy-preview-loading" role="status">{zh ? '正在加载视频…' : 'Loading video…'}</div>}
    {error && <LoadError zh={zh} onRetry={() => setAttempt(n => n + 1)} />}
  </div>;
}

export default function MediaPreview({ kind, src, title, zh = true, onClose, onDownload, onEdit, onUpscale }: Props) {
  const zoomRef = useRef<ZoomRef>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [imageError, setImageError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const viewport = useRef({ width: 1, height: 1 });
  const url = useMemo(() => toRenderableMediaUrl(src), [src]);
  const slides = useMemo<Slide[]>(() => kind === 'video'
    ? [{ type: 'video', sources: [{ src: url, type: '' }] }]
    : [{ type: 'canvas-image', src: url }],
  [kind, url]);
  const reportDimensions = (width: number, height: number) => {
    setDims(old => old.width === width && old.height === height ? old : { width, height });
  };
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try { await onDownload(); } finally { setDownloading(false); }
  };
  const oneToOne = () => {
    if (!dims.width || !dims.height) return;
    const size = fitMedia(dims.width, dims.height, viewport.current.width, viewport.current.height);
    zoomRef.current?.changeZoom(1 / size.scale);
  };
  const actualPercent = dims.width
    ? Math.round(fitMedia(dims.width, dims.height, viewport.current.width, viewport.current.height).scale * zoomLevel * 100)
    : null;
  const button = (key: string, text: string, icon: React.ReactNode, action: () => void, disabled = false) =>
    <button key={key} type="button" className="ccy-preview-button" aria-label={text} title={text} onClick={action} disabled={disabled}>{icon}<span>{text}</span></button>;
  return <Lightbox
    open close={onClose} slides={slides} plugins={[Zoom, Fullscreen]} className="ccy-media-preview"
    styles={{ root: { zIndex: 1000 } }}
    animation={{ fade: 150, zoom: 150 }}
    carousel={{ finite: true, preload: 0, padding: 0 }}
    controller={{ closeOnBackdropClick: false, closeOnPullDown: false, closeOnPullUp: false, aria: true }}
    portal={{ container: { onKeyDown: e => e.stopPropagation(), onPointerDown: e => e.stopPropagation(), onDoubleClick: e => e.stopPropagation() } }}
    labels={{ Close: zh ? '关闭预览' : 'Close preview', 'Zoom in': zh ? '放大' : 'Zoom in', 'Zoom out': zh ? '缩小' : 'Zoom out', 'Enter Fullscreen': zh ? '进入全屏' : 'Enter Fullscreen', 'Exit Fullscreen': zh ? '退出全屏' : 'Exit Fullscreen' }}
    zoom={{ ref: zoomRef, minZoom: 0.01, supports: ['canvas-image'], maxZoom: Math.max(8, dims.width / Math.max(1, viewport.current.width), dims.height / Math.max(1, viewport.current.height)), scrollToZoom: true, doubleClickMaxStops: 1 }}
    on={{ zoom: ({ zoom }) => setZoomLevel(zoom) }}
    toolbar={{ buttons: [
      ...(onEdit ? [button('edit', zh ? (kind === 'image' ? '编辑图片' : '剪辑视频') : 'Edit', kind === 'image' ? <Pencil size={16} /> : <Scissors size={16} />, onEdit)] : []),
      ...(onUpscale ? [button('upscale', zh ? '超分' : 'Upscale', <Sparkles size={16} />, onUpscale)] : []),
      ...(kind === 'image' ? [
        button('fit', zh ? '适应窗口' : 'Fit', <Maximize size={16} />, () => zoomRef.current?.changeZoom(1)),
        button('actual', '1:1', null, oneToOne, !dims.width),
      ] : []),
      button('download', downloading ? (zh ? '下载中…' : 'Downloading…') : (zh ? '下载原文件' : 'Download original'), <Download size={16} />, () => void download(), downloading),
      'close',
    ] }}
    render={{
      buttonPrev: () => null,
      buttonNext: () => null,
      iconClose: () => <X size={20} />,
      buttonZoom: ({ zoomIn, zoomOut, disabled }) => kind === 'image' ? <div className="ccy-preview-zoom">
        {button('minus', zh ? '缩小' : 'Zoom out', <ZoomOut size={16} />, zoomOut, disabled)}
        <span aria-label={zh ? '显示比例' : 'Display scale'}>{actualPercent === null ? '—' : actualPercent + '%'}</span>
        {button('plus', zh ? '放大' : 'Zoom in', <ZoomIn size={16} />, zoomIn, disabled)}
      </div> : null,
      controls: () => <>
        <div className="ccy-preview-title"><span>{kind === 'image' ? (zh ? '图片预览' : 'Image preview') : (zh ? '视频预览' : 'Video preview')}</span><strong>{title || (zh ? '画布素材' : 'Canvas media')}</strong><small>{dims.width ? dims.width + ' × ' + dims.height : ''}</small></div>
        <div className="ccy-preview-hint">{zh ? (kind === 'image' ? '滚轮缩放 · 放大后拖动 · 双击切换缩放 · Esc 关闭' : '空格播放 / 暂停 · 播放器设置可调倍速 · Esc 关闭') : (kind === 'image' ? 'Scroll to zoom · Drag to pan · Double-click to zoom · Esc to close' : 'Space to play / pause · Settings for playback speed · Esc to close')}</div>
      </>,
      slide: ({ slide, rect }) => {
        viewport.current = rect;
        if (slide.type === 'video') return <PreviewVideo key={url} src={url} zh={zh} rect={rect} onDimensions={reportDimensions} />;
        if (imageError) return <LoadError zh={zh} onRetry={() => { setImageError(false); setRetry(n => n + 1); }} />;
        const fit = dims.width ? fitMedia(dims.width, dims.height, rect.width, rect.height) : undefined;
        return <img key={url + retry} src={url} alt={title || (zh ? '图片预览' : 'Image preview')} draggable={false}
          className="ccy-preview-image" style={fit ? { width: fit.width, height: fit.height } : { maxWidth: rect.width, maxHeight: rect.height }}
          onLoad={e => reportDimensions(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          onError={() => setImageError(true)} />;
      },
    }}
  />;
}
