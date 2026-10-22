import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';

type Rect = { left: number; top: number; width: number; height: number };
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const margin = 12;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function fit(rect: Rect): Rect {
  const width = Math.min(rect.width, Math.max(1, window.innerWidth - margin * 2));
  const height = Math.min(rect.height, Math.max(1, window.innerHeight - margin * 2));
  return { width, height, left: clamp(rect.left, margin, window.innerWidth - margin - width), top: clamp(rect.top, margin, window.innerHeight - margin - height) };
}
function initialRect(): Rect {
  const width = Math.max(720, window.innerWidth * .58);
  const height = window.innerHeight * .82;
  return fit({ width, height, left: (window.innerWidth - width) / 2, top: (window.innerHeight - height) / 2 });
}
const handles: Record<Edge, CSSProperties> = {
  n: { top: -5, left: 14, right: 14, height: 10, cursor: 'ns-resize' },
  s: { bottom: -5, left: 14, right: 14, height: 10, cursor: 'ns-resize' },
  e: { right: -5, top: 14, bottom: 14, width: 10, cursor: 'ew-resize' },
  w: { left: -5, top: 14, bottom: 14, width: 10, cursor: 'ew-resize' },
  ne: { top: -5, right: -5, width: 20, height: 20, cursor: 'nesw-resize' },
  nw: { top: -5, left: -5, width: 20, height: 20, cursor: 'nwse-resize' },
  se: { bottom: -5, right: -5, width: 20, height: 20, cursor: 'nwse-resize' },
  sw: { bottom: -5, left: -5, width: 20, height: 20, cursor: 'nesw-resize' },
};
const labels: Record<Edge, string> = { n: '上边', s: '下边', e: '右边', w: '左边', ne: '右上角', nw: '左上角', se: '右下角', sw: '左下角' };

/** Screen-space resizing, independent of the canvas zoom. Children stay mounted
 * during resizing so an editor keeps its selection, draft and scroll position. */
export function ResizableTextDialog({ children, title, onClose, language }: {
  children: ReactNode; title: string; onClose: () => void; language: string;
}) {
  const [rect, setRect] = useState(initialRect);
  const drag = useRef<{ rect: Rect; x: number; y: number; edge: Edge; pointerId: number } | null>(null);
  useEffect(() => {
    const resize = () => { drag.current = null; setRect(current => fit(current)); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function start(event: PointerEvent<HTMLDivElement>, edge: Edge) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { rect, x: event.clientX, y: event.clientY, edge, pointerId: event.pointerId };
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const { rect: original, edge } = active;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    let { left, top, width, height } = original;
    const right = left + width, bottom = top + height;
    const minWidth = Math.min(560, window.innerWidth - margin * 2);
    const minHeight = Math.min(300, window.innerHeight - margin * 2);
    if (edge.includes('w')) { left = clamp(left + dx, margin, right - minWidth); width = right - left; }
    if (edge.includes('e')) width = clamp(width + dx, minWidth, window.innerWidth - margin - left);
    if (edge.includes('n')) { top = clamp(top + dy, margin, bottom - minHeight); height = bottom - top; }
    if (edge.includes('s')) height = clamp(height + dy, minHeight, window.innerHeight - margin - top);
    setRect({ left, top, width, height });
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return (
    <div className="fixed inset-0 z-[200] bg-black/55 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} data-testid="resizable-text-dialog"
        className="fixed flex min-h-0 min-w-0 flex-col rounded-2xl border border-white/10 bg-[#1a1d22]/98 px-6 py-5 shadow-2xl [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
        style={rect} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
        {children}
        {(Object.keys(handles) as Edge[]).map(edge => (
          <div key={edge} data-resize-edge={edge}
            title={language === 'zh' ? `拖动${labels[edge]}调整弹窗大小` : `Drag ${edge} to resize`}
            className="absolute z-30 touch-none select-none rounded hover:bg-cyan-300/20"
            style={handles[edge]} onPointerDown={event => start(event, edge)} onPointerMove={move}
            onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
            onClick={event => event.stopPropagation()} />
        ))}
        <span aria-hidden className="pointer-events-none absolute bottom-1 right-2 text-xs text-neutral-500">◢</span>
      </div>
    </div>
  );
}
