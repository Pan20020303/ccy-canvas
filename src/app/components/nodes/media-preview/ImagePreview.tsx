import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ImageOff, Loader2, RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { toRenderableMediaUrl } from '../../../reference-media';
import { clamp, fitImageZoom, type MediaDimensions, type PreviewItem } from './media-preview-model';
import { PreviewButton } from './PreviewButton';

export function ImagePreview({ item, zh, onDimensions }: { item: PreviewItem; zh: boolean; onDimensions: (value: MediaDimensions) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<MediaDimensions | null>(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [error, setError] = useState(false);
  const drag = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const fitted = dimensions ? fitImageZoom(dimensions, viewport, rotation) : 1;
  const minZoom = Math.min(0.05, fitted);
  const setScale = useCallback((value: number) => setZoom(clamp(value, minZoom, 5)), [minZoom]);
  const reset = useCallback(() => { setZoom(fitted); setPan({ x: 0, y: 0 }); }, [fitted]);
  const rotate = (delta: number) => {
    const next = rotation + delta;
    setRotation(next);
    if (dimensions) setZoom(fitImageZoom(dimensions, viewport, next));
    setPan({ x: 0, y: 0 });
  };

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setViewport({ width: Math.max(1, element.clientWidth - 24), height: Math.max(1, element.clientHeight - 12) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { reset(); }, [reset]);
  // Only the focused dialog handles keys, so canvas delete/undo shortcuts cannot leak through.
  useEffect(() => {
    const element = stage.current?.closest('[role="dialog"]');
    if (!element) return;
    const handler = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.target instanceof HTMLInputElement || key.target instanceof HTMLSelectElement) return;
      if (key.key === '+' || key.key === '=') { key.preventDefault(); setScale(zoom * 1.2); }
      if (key.key === '-') { key.preventDefault(); setScale(zoom / 1.2); }
      if (key.key === '0') { key.preventDefault(); reset(); }
    };
    element.addEventListener('keydown', handler);
    return () => element.removeEventListener('keydown', handler);
  }, [reset, setScale, zoom]);

  return <>
    <div className="media-preview-zoom media-preview-pill" role="toolbar" aria-label={zh ? '图片预览工具' : 'Image controls'}>
      <PreviewButton label={zh ? '放大' : 'Zoom in'} disabled={!dimensions || error} onClick={() => setScale(zoom * 1.2)}><ZoomIn /></PreviewButton>
      <PreviewButton label={zh ? '缩小' : 'Zoom out'} disabled={!dimensions || error} onClick={() => setScale(zoom / 1.2)}><ZoomOut /></PreviewButton>
      <span className="media-preview-divider" />
      <button className="media-preview-percent" onClick={reset} title={zh ? '适应窗口（0）' : 'Fit to window (0)'} aria-label={zh ? '适应窗口' : 'Fit to window'}>{dimensions ? `${Math.round(zoom * 100)}%` : '—'}</button>
      <input type="range" min={minZoom} max={5} step="0.005" value={zoom} disabled={!dimensions || error} onChange={event => setScale(Number(event.target.value))} aria-label={zh ? '图片缩放' : 'Image zoom'} />
      <span className="media-preview-divider" />
      <PreviewButton label={zh ? '顺时针旋转' : 'Rotate clockwise'} disabled={!dimensions || error} onClick={() => rotate(90)}><RotateCw /></PreviewButton>
      <PreviewButton label={zh ? '逆时针旋转' : 'Rotate counterclockwise'} disabled={!dimensions || error} onClick={() => rotate(-90)}><RotateCcw /></PreviewButton>
    </div>
    <div ref={stage} className="media-preview-image-stage" onWheel={event => {
      if (!dimensions || error) return;
      const next = clamp(zoom * Math.exp(-event.deltaY * 0.0015), minZoom, 5);
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left - bounds.width / 2;
      const y = event.clientY - bounds.top - bounds.height / 2;
      setPan(value => ({ x: x - (x - value.x) * next / zoom, y: y - (y - value.y) * next / zoom }));
      setZoom(next);
    }} onPointerDown={event => {
      if (!dimensions || error || event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      const previous = drag.current;
      if (!previous || previous.pointer !== event.pointerId) return;
      setPan(value => ({ x: value.x + event.clientX - previous.x, y: value.y + event.clientY - previous.y }));
      drag.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => { setZoom(Math.abs(zoom - fitted) < 0.001 ? 1 : fitted); setPan({ x: 0, y: 0 }); }}>
      {!dimensions && !error && <div className="media-preview-status" role="status"><Loader2 className="media-preview-spin" />{zh ? '正在加载原图…' : 'Loading original image…'}</div>}
      {error && <div className="media-preview-status" role="alert"><ImageOff />{zh ? '图片加载失败，请重新加载或下载原文件查看。' : 'Image loading failed. Reload or download the original file.'}</div>}
      <img className="media-preview-original" src={toRenderableMediaUrl(item.src)} alt={item.title} draggable={false}
        style={{ width: dimensions?.width, height: dimensions?.height, opacity: dimensions && !error ? 1 : 0, transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${zoom})` }}
        onLoad={event => { const img = event.currentTarget; const next = { width: img.naturalWidth, height: img.naturalHeight }; if (next.width && next.height) { setDimensions(next); onDimensions(next); } }}
        onError={() => setError(true)} />
    </div>
  </>;
}
