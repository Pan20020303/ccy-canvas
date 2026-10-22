import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eraser, Undo2, X } from 'lucide-react';

// ─── 局部重绘蒙版编辑器 ───────────────────────────────────────────────────
// 用户在源图上涂抹「要修改的区域」,确认后生成 mask:涂抹处透明、其余黑,
// 与既有 buildSelectionMask 约定一致(黑=保留,透明=重绘)。真·局部编辑,
// 取代此前「零选区→整图重绘」的假局部。

/** 由涂抹画布生成 inpaint 蒙版:黑底(保留)+ 涂抹处 destination-out 抠成
 *  透明(重绘)。抽成纯函数便于单测:输入涂抹画布,输出 PNG dataURL。 */
export function buildInpaintMask(paint: HTMLCanvasElement, w: number, h: number): string {
  const mask = document.createElement('canvas');
  mask.width = w; mask.height = h;
  const mctx = mask.getContext('2d');
  if (!mctx) return '';
  mctx.fillStyle = 'rgba(0,0,0,1)';
  mctx.fillRect(0, 0, w, h);
  mctx.globalCompositeOperation = 'destination-out';
  mctx.drawImage(paint, 0, 0, w, h);
  return mask.toDataURL('image/png');
}

type Props = {
  open: boolean;
  sourceUrl: string;
  language: 'zh' | 'en';
  onCancel: () => void;
  /** 传出蒙版 dataURL(PNG,涂抹处透明)。 */
  onConfirm: (maskDataUrl: string) => void;
};

export function MaskEditor({ open, sourceUrl, language, onCancel, onConfirm }: Props) {
  const zh = language === 'zh';
  const imgRef = useRef<HTMLImageElement | null>(null);
  // 涂抹画布保持在图片原始分辨率,CSS 缩放显示;确认时直接作蒙版模板。
  const paintRef = useRef<HTMLCanvasElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [brush, setBrush] = useState(48);
  const [hasPaint, setHasPaint] = useState(false);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  // 撤销栈:每次落笔前存一张快照(dataURL),数量封顶防内存膨胀。
  const undoStack = useRef<string[]>([]);

  // 载入源图拿原始尺寸,初始化涂抹画布。
  useEffect(() => {
    if (!open) return;
    setNatural(null);
    setHasPaint(false);
    undoStack.current = [];
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      setNatural({ w, h });
      const c = paintRef.current;
      if (c) {
        c.width = w; c.height = h;
        c.getContext('2d')?.clearRect(0, 0, w, h);
      }
    };
    img.src = sourceUrl;
  }, [open, sourceUrl]);

  const paintCtx = () => paintRef.current?.getContext('2d') ?? null;

  const toNatural = useCallback((e: React.PointerEvent) => {
    const c = paintRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / Math.max(1, rect.width);
    const ny = (e.clientY - rect.top) / Math.max(1, rect.height);
    return { x: nx * c.width, y: ny * c.height };
  }, []);

  const stroke = (from: { x: number; y: number } | null, to: { x: number; y: number }) => {
    const ctx = paintCtx();
    const c = paintRef.current;
    if (!ctx || !c) return;
    // 画笔半径按显示比例换算到原始像素,手感与屏幕一致。
    const scale = c.width / Math.max(1, c.getBoundingClientRect().width);
    const r = (brush / 2) * scale;
    // 蒙版靠 destination-out 抠除,涂抹处必须是「满 alpha」才能抠成完全透明;
    // 半透明观感交给画布的 CSS opacity(见 canvas className),不影响像素 alpha。
    ctx.fillStyle = 'rgba(56,189,248,1)';
    ctx.strokeStyle = 'rgba(56,189,248,1)';
    ctx.lineWidth = r * 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(to.x, to.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (from) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
  };

  const pushUndo = () => {
    const c = paintRef.current;
    if (!c) return;
    try {
      undoStack.current.push(c.toDataURL());
      if (undoStack.current.length > 20) undoStack.current.shift();
    } catch { /* tainted canvas — 撤销降级不可用 */ }
  };

  const onDown = (e: React.PointerEvent) => {
    if (!natural) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pushUndo();
    drawing.current = true;
    const p = toNatural(e);
    lastPt.current = p;
    stroke(null, p);
    setHasPaint(true);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const p = toNatural(e);
    stroke(lastPt.current, p);
    lastPt.current = p;
  };
  const onUp = () => { drawing.current = false; lastPt.current = null; };

  const undo = () => {
    const c = paintRef.current;
    const ctx = paintCtx();
    if (!c || !ctx) return;
    const prev = undoStack.current.pop();
    ctx.clearRect(0, 0, c.width, c.height);
    if (prev) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = prev;
      setHasPaint(true);
    } else {
      setHasPaint(false);
    }
  };

  const clearAll = () => {
    const c = paintRef.current;
    const ctx = paintCtx();
    if (!c || !ctx) return;
    pushUndo();
    ctx.clearRect(0, 0, c.width, c.height);
    setHasPaint(false);
  };

  const confirm = () => {
    const paint = paintRef.current;
    if (!paint || !natural || !hasPaint) return;
    onConfirm(buildInpaintMask(paint, natural.w, natural.h));
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm" data-testid="mask-editor">
      <div className="relative flex max-h-[90vh] w-[min(720px,92vw)] flex-col rounded-2xl border border-white/10 bg-[#16181d]/98 p-5 shadow-2xl">
        <button
          type="button"
          onClick={onCancel}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-1 text-sm font-medium text-neutral-200">{zh ? '涂抹要修改的区域' : 'Paint the area to edit'}</div>
        <div className="mb-3 text-[12px] text-neutral-500">
          {zh ? '用画笔涂抹需要重绘的部分,其余区域保持不变。' : 'Brush over the region to regenerate; the rest stays untouched.'}
        </div>

        <div className="relative mx-auto flex max-h-[56vh] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/30">
          {sourceUrl ? <img src={sourceUrl} alt="" className="max-h-[56vh] w-auto select-none object-contain" draggable={false} /> : null}
          <canvas
            ref={paintRef}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none opacity-70"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className="text-[12px] text-neutral-400">{zh ? '画笔' : 'Brush'}</span>
          <input
            type="range" min={12} max={120} value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
            className="h-1 flex-1 cursor-pointer accent-cyan-400"
          />
          <span className="w-8 text-right text-[12px] tabular-nums text-neutral-500">{brush}</span>
          <button type="button" onClick={undo} className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-neutral-300 transition hover:bg-white/[0.06]" title={zh ? '撤销' : 'Undo'}>
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={clearAll} className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-neutral-300 transition hover:bg-white/[0.06]" title={zh ? '清除' : 'Clear'}>
            <Eraser className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[12px] text-neutral-300 transition hover:bg-white/[0.06]">
            {zh ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!hasPaint}
            data-testid="mask-confirm"
            className="rounded-lg border border-cyan-400/40 bg-cyan-400/12 px-4 py-1.5 text-[12px] text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {zh ? '确定选区' : 'Confirm area'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
