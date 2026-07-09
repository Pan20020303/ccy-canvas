import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brush, Loader2, Redo2, Trash2, Type, Undo2, Users, X } from 'lucide-react';
import { Button } from '../ui/button';

// 人物站位标注 studio —— 全屏放大编辑器，双模式:
//   自由画笔(pen/文字)  +  人物站位(圆点=位置 / 短箭头=朝向 / Shift 拖=移动虚线 /
//   名字标签自动避让 / 逐项尺寸调节)。
// 忠实移植自「橙次元人物站位工具」HTML:canvas 内部按图片自然尺寸绘制、CSS 缩放显示，
// 因此导出(toBlob)即原分辨率成图。坐标全部是自然像素。
// 组件零依赖父级内部实现:图片 URL 进、合成后的 PNG Blob 出(onSave)。

type Pt = { x: number; y: number };

type Mark = {
  name: string;
  color: string;
  x: number;
  y: number;
  ang: number;
  path?: Pt[];
  isLabel?: boolean;
  labelPos?: string;
  labelOffset?: Pt;
  circleScale?: number;
  arrowScale?: number;
  lineScale?: number;
  nameScale?: number;
};

type DrawOp =
  | { kind: 'pen'; color: string; width: number; points: Pt[] }
  | { kind: 'text'; color: string; size: number; x: number; y: number; text: string };

const COLORS = [
  { v: '#e74c3c', zh: '红' },
  { v: '#3498db', zh: '蓝' },
  { v: '#2ecc71', zh: '绿' },
  { v: '#f39c12', zh: '橙' },
  { v: '#9b59b6', zh: '紫' },
  { v: '#e91e90', zh: '粉' },
  { v: '#1abc9c', zh: '青' },
  { v: '#f1c40f', zh: '黄' },
  { v: '#ffffff', zh: '白' },
  { v: '#111827', zh: '黑' },
];

const LABEL_DIRS: Array<{ v: string; zh: string; en: string }> = [
  { v: 'auto', zh: '自动', en: 'Auto' },
  { v: 'top', zh: '上', en: 'Top' },
  { v: 'bottom', zh: '下', en: 'Bottom' },
  { v: 'right', zh: '右', en: 'Right' },
  { v: 'left', zh: '左', en: 'Left' },
  { v: 'topRight', zh: '右上', en: 'Top-R' },
  { v: 'topLeft', zh: '左上', en: 'Top-L' },
  { v: 'bottomRight', zh: '右下', en: 'Bot-R' },
  { v: 'bottomLeft', zh: '左下', en: 'Bot-L' },
];

// 通过 fetch→blob→objectURL 载入(src 应为已代理的同源 URL),这样导出 canvas
// (toBlob)不会因跨域被污染 —— 与 CustomNodes 的 loadImageElement 同一手法。
async function loadImage(src: string): Promise<HTMLImageElement> {
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = objectUrl;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function PositionStudio({
  imageUrl,
  zh,
  saving = false,
  onClose,
  onSave,
}: {
  imageUrl: string;
  zh: boolean;
  saving?: boolean;
  onClose: () => void;
  onSave: (blob: Blob) => void | Promise<void>;
}) {
  const t = (a: string, b: string) => (zh ? a : b);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<'draw' | 'position'>('position');
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // ── 人物站位数据(imperative refs,拖拽时直接改+重绘,不走 React 渲染)──────
  const marksRef = useRef<Mark[]>([]);
  const selectedRef = useRef<Mark | null>(null);
  const placingRef = useRef<Omit<Mark, 'x' | 'y' | 'ang'> | null>(null);
  const dragRef = useRef<Mark | null>(null);
  const modeRef = useRef<string | null>(null);
  const shiftPtsRef = useRef<Pt[]>([]);
  const dragStartRef = useRef<any>(null);
  const labelBoxesRef = useRef<Array<{ m: Mark; cx: number; cy: number; x1: number; y1: number; x2: number; y2: number }>>([]);
  const mHistRef = useRef<string[]>([]);
  const mRedoRef = useRef<string[]>([]);
  const defaultLabelPosRef = useRef('auto');

  // ── 自由画笔数据 ────────────────────────────────────────────────────────
  const opsRef = useRef<DrawOp[]>([]);
  const opsRedoRef = useRef<DrawOp[]>([]);
  const liveOpRef = useRef<Extract<DrawOp, { kind: 'pen' }> | null>(null);

  // ── 受控 UI 状态 ────────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0].v);
  const [labelMode, setLabelMode] = useState(false);
  const [circle, setCircle] = useState(100);
  const [arrow, setArrow] = useState(100);
  const [line, setLine] = useState(100);
  const [nameSize, setNameSize] = useState(100);
  // 锁定统一大小(默认锁):锁=滑块改所有角色;不锁=只改选中角色(该角色用自己的 scale)。
  const [circleLock, setCircleLock] = useState(true);
  const [arrowLock, setArrowLock] = useState(true);
  const [lineLock, setLineLock] = useState(true);
  const [nameLock, setNameLock] = useState(true);
  const [labelPos, setLabelPos] = useState('auto');
  // 「画移动轨迹」一次性模式:开启后从选中角色拖一条移动虚线(不必按 Shift)。
  const [pathDraw, setPathDraw] = useState(false);
  const pathDrawRef = useRef(false);
  pathDrawRef.current = pathDraw;
  const [drawTool, setDrawTool] = useState<'pen' | 'text'>('pen');
  const [drawColor, setDrawColor] = useState('#e74c3c');
  const [drawWidth, setDrawWidth] = useState(6);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  // ── 几何/尺寸(自然像素)──────────────────────────────────────────────────
  const baseUnit = () => (cvRef.current?.width ?? 1000) * 0.022;
  const circleRadius = (m?: Mark | null) => baseUnit() * (circleLock || !m ? circle / 100 : (m.circleScale ?? circle / 100));
  const arrowUnit = (m?: Mark | null) => baseUnit() * (arrowLock || !m ? arrow / 100 : (m.arrowScale ?? arrow / 100));
  const lineUnit = (m?: Mark | null) => baseUnit() * (lineLock || !m ? line / 100 : (m.lineScale ?? line / 100));
  const nameFont = (m?: Mark | null) => Math.round((cvRef.current?.width ?? 1000) * 0.024 * (nameLock || !m ? nameSize / 100 : (m.nameScale ?? nameSize / 100)));
  const arrowLength = (m: Mark) => Math.max(arrowUnit(m) * 2.4, circleRadius(m) + arrowUnit(m) * 1.4);

  const pointerPos = (e: React.PointerEvent): Pt => {
    const cv = cvRef.current!;
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height };
  };

  const snapMarks = () => {
    mHistRef.current.push(JSON.stringify(marksRef.current));
    if (mHistRef.current.length > 100) mHistRef.current.shift();
    mRedoRef.current = [];
  };
  const snapOps = () => {
    opsRedoRef.current = [];
  };

  const activePath = (m: Mark) => (m.path && m.path.length > 1 ? m.path : null);
  const arrowHead = (m: Mark): Pt => {
    const path = activePath(m);
    if (path) return path[path.length - 1];
    const len = arrowLength(m);
    return { x: m.x + Math.cos(m.ang) * len, y: m.y + Math.sin(m.ang) * len };
  };
  const hitCircle = (p: Pt, m: Mark) => {
    const r = Math.max(circleRadius(m) * 1.65, (cvRef.current?.width ?? 1000) * 0.025);
    return Math.hypot(m.x - p.x, m.y - p.y) < r;
  };
  const hitArrow = (p: Pt, m: Mark) => {
    if (m.isLabel) return false;
    const h = arrowHead(m);
    const tol = Math.max(arrowUnit(m) * 1.8, circleRadius(m) * 0.85, (cvRef.current?.width ?? 1000) * 0.018);
    return Math.hypot(h.x - p.x, h.y - p.y) < tol;
  };
  const findTarget = (p: Pt, shift: boolean): { m: Mark; part: string } | null => {
    const list = marksRef.current.slice().reverse();
    if (shift) {
      let m = list.find((x) => !x.isLabel && hitCircle(p, x));
      if (!m) m = list.find((x) => !x.isLabel && hitArrow(p, x));
      return m ? { m, part: 'shift' } : null;
    }
    const arrow = list.find((x) => hitArrow(p, x));
    if (arrow) return { m: arrow, part: 'arrow' };
    const body = list.find((x) => hitCircle(p, x));
    return body ? { m: body, part: 'body' } : null;
  };
  const findLabelTarget = (p: Pt) => {
    const boxes = labelBoxesRef.current;
    for (let i = boxes.length - 1; i >= 0; i -= 1) {
      const b = boxes[i];
      if (p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2) return b;
    }
    return null;
  };
  const labelCandidates = (m: Mark): number[][] => {
    const auto = [[0, -2.4], [0, 2.8], [2.6, 0], [-2.6, 0], [2.2, -2.2], [-2.2, -2.2], [2.2, 2.4], [-2.2, 2.4], [0, -4], [0, 4.2], [4, 0], [-4, 0]];
    const fixed: Record<string, number[][]> = {
      top: [[0, -2.4]], bottom: [[0, 2.8]], right: [[2.6, 0]], left: [[-2.6, 0]],
      topRight: [[2.2, -2.2]], topLeft: [[-2.2, -2.2]], bottomRight: [[2.2, 2.4]], bottomLeft: [[-2.2, 2.4]],
    };
    const pos = m.labelPos || defaultLabelPosRef.current;
    return pos === 'auto' ? auto : (fixed[pos] || auto);
  };

  // ── 主绘制 ────────────────────────────────────────────────────────────────
  const redraw = useCallback((previewPts?: Pt[] | null, forExport = false) => {
    const cv = cvRef.current;
    const img = imgRef.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !img || !ctx) return;
    labelBoxesRef.current = [];
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);

    // 自由画笔层(始终烘焙)
    const ops = liveOpRef.current ? [...opsRef.current, liveOpRef.current] : opsRef.current;
    for (const op of ops) {
      if (op.kind === 'pen') {
        if (!op.points.length) continue;
        ctx.strokeStyle = op.color; ctx.lineWidth = Math.max(1, op.width); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(op.points[0].x, op.points[0].y);
        for (let i = 1; i < op.points.length; i += 1) ctx.lineTo(op.points[i].x, op.points[i].y);
        if (op.points.length === 1) ctx.lineTo(op.points[0].x + 0.01, op.points[0].y);
        ctx.stroke();
      } else {
        if (!op.text) continue;
        ctx.fillStyle = op.color; ctx.font = `600 ${op.size}px system-ui, sans-serif`; ctx.textBaseline = 'top';
        ctx.fillText(op.text, op.x, op.y);
      }
    }

    // 人物站位层
    const marks = marksRef.current;
    const selected = forExport ? null : selectedRef.current;
    const rectOf = (cx: number, cy: number, hw: number, hh: number) => ({ x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh });
    const hit = (a: any, b: any) => !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);
    const dash = (pts: Pt[], c: string, L: number) => {
      ctx.setLineDash([L, L * 0.7]); ctx.strokeStyle = c; ctx.lineWidth = L * 0.28;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); pts.forEach((q) => ctx.lineTo(q.x, q.y)); ctx.stroke(); ctx.setLineDash([]);
    };
    const arrowAt = (x: number, y: number, ang: number, c: string, A: number) => {
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x - Math.cos(ang - 0.5) * A * 1.2, y - Math.sin(ang - 0.5) * A * 1.2);
      ctx.lineTo(x - Math.cos(ang + 0.5) * A * 1.2, y - Math.sin(ang + 0.5) * A * 1.2);
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();
    };
    const obstacles: any[] = [];
    marks.forEach((m) => {
      const R = circleRadius(m), A = arrowUnit(m), L = lineUnit(m);
      if (m.isLabel) { obstacles.push(rectOf(m.x, m.y, R, R)); return; }
      const livePts = previewPts && dragRef.current === m && previewPts.length > 1 ? previewPts : null;
      const path = livePts || (m.path && m.path.length > 1 ? m.path : null);
      if (path) {
        dash(path, m.color, L);
        path.forEach((q, i) => { if (i % 2 === 0) obstacles.push(rectOf(q.x, q.y, L * 0.6, L * 0.6)); });
        const ep = path[path.length - 1], pp = path[Math.max(0, path.length - 4)];
        arrowAt(ep.x, ep.y, Math.atan2(ep.y - pp.y, ep.x - pp.x), m.color, A);
        obstacles.push(rectOf(ep.x, ep.y, Math.max(A, L) * 1.5, Math.max(A, L) * 1.5));
      } else {
        const len = arrowLength(m);
        const ax = m.x + Math.cos(m.ang) * len, ay = m.y + Math.sin(m.ang) * len;
        ctx.strokeStyle = m.color; ctx.lineWidth = L * 0.35;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(ax, ay); ctx.stroke();
        arrowAt(ax, ay, m.ang, m.color, A);
        obstacles.push(rectOf((m.x + ax) / 2, (m.y + ay) / 2, Math.abs(ax - m.x) / 2 + Math.max(R, A, L), Math.abs(ay - m.y) / 2 + Math.max(R, A, L)));
        obstacles.push(rectOf(ax, ay, Math.max(A, L) * 1.5, Math.max(A, L) * 1.5));
      }
      ctx.beginPath(); ctx.arc(m.x, m.y, R, 0, 7); ctx.fillStyle = m.color; ctx.fill();
      if (m === selected) { ctx.beginPath(); ctx.arc(m.x, m.y, R * 1.48, 0, 7); ctx.lineWidth = Math.max(2, R * 0.18); ctx.strokeStyle = '#ffd166'; ctx.stroke(); }
      obstacles.push(rectOf(m.x, m.y, R * 1.3, R * 1.3));
    });

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const placedLabels: any[] = [];
    marks.forEach((m) => {
      const F = nameFont(m);
      ctx.font = `bold ${F}px sans-serif`;
      const R = circleRadius(m);
      const tw = ctx.measureText(m.name).width;
      if (m.isLabel) {
        const bw = tw / 2 + F * 0.5, bh = F * 0.85;
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(m.x - bw, m.y - bh, bw * 2, bh * 2);
        ctx.lineWidth = F * 0.1; ctx.strokeStyle = m.color; ctx.strokeRect(m.x - bw, m.y - bh, bw * 2, bh * 2);
        if (m === selected) { ctx.lineWidth = Math.max(2, F * 0.14); ctx.strokeStyle = '#ffd166'; ctx.strokeRect(m.x - bw - 4, m.y - bh - 4, bw * 2 + 8, bh * 2 + 8); }
        ctx.fillStyle = '#1a1a1e'; ctx.fillText(m.name, m.x, m.y);
        placedLabels.push(rectOf(m.x, m.y, bw, bh));
        labelBoxesRef.current.push({ m, cx: m.x, cy: m.y, x1: m.x - bw - 6, y1: m.y - bh - 6, x2: m.x + bw + 6, y2: m.y + bh + 6 });
        return;
      }
      const cand = labelCandidates(m);
      let lx = m.x, ly = m.y - R * 2.4;
      let placedBox: any = null;
      if (m.labelOffset) {
        let tx = m.x + m.labelOffset.x, ty = m.y + m.labelOffset.y;
        tx = Math.min(Math.max(tx, tw / 2 + 4), cv.width - tw / 2 - 4);
        ty = Math.min(Math.max(ty, F * 0.8), cv.height - F * 0.8);
        lx = tx; ly = ty; placedBox = rectOf(tx, ty, tw / 2 + F * 0.25, F * 0.75);
      } else {
        for (const [dx, dy] of cand) {
          let tx = m.x + dx * R, ty = m.y + dy * R;
          tx = Math.min(Math.max(tx, tw / 2 + 4), cv.width - tw / 2 - 4);
          ty = Math.min(Math.max(ty, F * 0.8), cv.height - F * 0.8);
          const bb = rectOf(tx, ty, tw / 2 + F * 0.25, F * 0.75);
          if (![...obstacles, ...placedLabels].some((o) => hit(bb, o))) { lx = tx; ly = ty; placedBox = bb; break; }
        }
        if (!placedBox) {
          let tx = m.x + cand[0][0] * R, ty = m.y + cand[0][1] * R;
          tx = Math.min(Math.max(tx, tw / 2 + 4), cv.width - tw / 2 - 4);
          ty = Math.min(Math.max(ty, F * 0.8), cv.height - F * 0.8);
          lx = tx; ly = ty; placedBox = rectOf(tx, ty, tw / 2 + F * 0.25, F * 0.75);
        }
      }
      placedLabels.push(placedBox);
      labelBoxesRef.current.push({ m, cx: lx, cy: ly, x1: placedBox.x1 - 6, y1: placedBox.y1 - 6, x2: placedBox.x2 + 6, y2: placedBox.y2 + 6 });
      ctx.lineWidth = F * 0.22; ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.strokeText(m.name, lx, ly); ctx.fillStyle = '#fff'; ctx.fillText(m.name, lx, ly);
    });
    ctx.textBaseline = 'alphabetic';

    if (marks.length) {
      const R = circleRadius(), lx = R, ly = cv.height - R * 1.2;
      ctx.font = `${Math.round(cv.width * 0.024) * 0.8}px sans-serif`; ctx.textAlign = 'left';
      const legend = '● 角色位置　→ 面朝方向　- -▶ 移动轨迹与方向';
      ctx.lineWidth = Math.round(cv.width * 0.024) * 0.2; ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.strokeText(legend, lx, ly); ctx.fillStyle = '#fff'; ctx.fillText(legend, lx, ly);
    }
  }, [circle, arrow, line, nameSize, circleLock, arrowLock, lineLock, nameLock]);

  // 载入图片
  useEffect(() => {
    let alive = true;
    loadImage(imageUrl).then((img) => {
      if (!alive) return;
      imgRef.current = img;
      const cv = cvRef.current;
      if (cv) { cv.width = img.naturalWidth || 1000; cv.height = img.naturalHeight || 1000; }
      setReady(true);
      requestAnimationFrame(() => redraw());
    }).catch(() => { if (alive) setLoadError(true); });
    return () => { alive = true; alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  useEffect(() => { if (ready) redraw(); }, [ready, redraw, tab]);

  // 选中变化时把尺寸滑块同步成该角色的值(未锁定单独调时)
  const syncSlidersToSelected = () => {
    const s = selectedRef.current;
    if (!s) return;
    // 仅在「未锁定」时把滑块同步成该角色自己的尺寸;锁定项保持全局值。
    if (!circleLock && s.circleScale) setCircle(Math.round(s.circleScale * 100));
    if (!arrowLock && s.arrowScale) setArrow(Math.round(s.arrowScale * 100));
    if (!lineLock && s.lineScale) setLine(Math.round(s.lineScale * 100));
    if (!nameLock && s.nameScale) setNameSize(Math.round(s.nameScale * 100));
    setLabelPos(s.labelOffset ? 'custom' : (s.labelPos || defaultLabelPosRef.current));
  };

  const deleteMark = (m: Mark) => {
    const idx = marksRef.current.indexOf(m);
    if (idx < 0) return;
    snapMarks();
    marksRef.current.splice(idx, 1);
    selectedRef.current = null; dragRef.current = null; modeRef.current = null;
    redraw(); rerender();
  };
  // 有选中就删选中，否则删最后一个(对齐 HTML 的「删除最后一个角色」)。
  const deleteLast = () => {
    if (selectedRef.current) { deleteMark(selectedRef.current); return; }
    if (!marksRef.current.length) return;
    snapMarks();
    marksRef.current.pop();
    selectedRef.current = null;
    redraw(); rerender();
  };

  // 键盘:Delete 删除选中 / Ctrl+Z 撤销 / Ctrl+Y 重做 / Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
      if (e.key === 'Escape') {
        if (typing) return; // 让输入框自己处理 Esc
        e.preventDefault(); e.stopPropagation();
        onClose();
        return;
      }
      if (typing) return; // 输入框里正常打字/删字，别拦
      // 编辑器打开期间，这些键一律吞掉、绝不冒泡到画布(capture 阶段先于画布的冒泡
      // 监听)——否则 Delete 会删画布节点、Ctrl+Z 会触发画布撤销。
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); e.stopPropagation();
        if (tabRef.current === 'position' && selectedRef.current) deleteMark(selectedRef.current);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault(); e.stopPropagation(); undo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault(); e.stopPropagation(); redo(); return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textDraft]);

  const undo = () => {
    if (tabRef.current === 'draw') {
      if (!opsRef.current.length) return;
      opsRedoRef.current.push(opsRef.current[opsRef.current.length - 1]);
      opsRef.current = opsRef.current.slice(0, -1);
    } else {
      if (!mHistRef.current.length) return;
      mRedoRef.current.push(JSON.stringify(marksRef.current));
      marksRef.current = JSON.parse(mHistRef.current.pop()!);
      selectedRef.current = null;
    }
    redraw(); rerender();
  };
  const redo = () => {
    if (tabRef.current === 'draw') {
      if (!opsRedoRef.current.length) return;
      opsRef.current = [...opsRef.current, opsRedoRef.current.pop()!];
    } else {
      if (!mRedoRef.current.length) return;
      mHistRef.current.push(JSON.stringify(marksRef.current));
      marksRef.current = JSON.parse(mRedoRef.current.pop()!);
      selectedRef.current = null;
    }
    redraw(); rerender();
  };

  const applyScale = (val: number, kind: 'circleScale' | 'arrowScale' | 'lineScale' | 'nameScale', locked: boolean) => {
    const scale = val / 100;
    if (locked) marksRef.current.forEach((m) => { m[kind] = scale; });
    else if (selectedRef.current) selectedRef.current[kind] = scale;
    redraw();
  };

  // ── 指针交互 ────────────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    if (!ready || e.button !== 0) return;
    e.preventDefault(); // 阻止浏览器对 canvas 的默认拖拽/选区，保证拖拽手感
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = pointerPos(e);
    if (tabRef.current === 'draw') {
      if (drawTool === 'text') { if (!textDraft) setTextDraft({ x: p.x, y: p.y, value: '' }); return; }
      snapOps();
      liveOpRef.current = { kind: 'pen', color: drawColor, width: Math.max(1, drawWidth * baseUnit() * 0.12), points: [p] };
      redraw();
      return;
    }
    // position tab
    if (placingRef.current) {
      snapMarks();
      const mark: Mark = { ...placingRef.current, x: p.x, y: p.y, ang: -Math.PI / 2, path: [], circleScale: circle / 100, arrowScale: arrow / 100, lineScale: line / 100, nameScale: nameSize / 100 };
      marksRef.current.push(mark); selectedRef.current = mark; placingRef.current = null;
      syncSlidersToSelected(); redraw(); rerender(); return;
    }
    // 画移动虚线:①按住 Shift 拖，或 ②开了「画移动轨迹」按钮。命中角色圆点或当前
    // 已选中角色即从该角色起拖(比「必须精确从圆点起拖」更宽容)。
    if (e.shiftKey || pathDrawRef.current) {
      const hit = findTarget(p, true);
      const m = hit?.m ?? selectedRef.current;
      if (m && !m.isLabel) {
        snapMarks();
        selectedRef.current = m; dragRef.current = m; modeRef.current = 'shift';
        shiftPtsRef.current = [{ x: m.x, y: m.y }];
        dragStartRef.current = { pointer: p, x: m.x, y: m.y, path: (m.path || []).map((q) => ({ ...q })) };
        syncSlidersToSelected(); rerender();
        return;
      }
      if (pathDrawRef.current) return; // 开了轨迹模式但没角色可拖，忽略这次点击
    }
    const labelTarget = findLabelTarget(p);
    if (labelTarget) {
      snapMarks(); selectedRef.current = labelTarget.m; dragRef.current = labelTarget.m; modeRef.current = 'label';
      dragStartRef.current = { pointer: p, labelOffset: { x: labelTarget.cx - labelTarget.m.x, y: labelTarget.cy - labelTarget.m.y } };
      syncSlidersToSelected(); rerender(); return;
    }
    const target = findTarget(p, false);
    if (target) {
      snapMarks(); selectedRef.current = target.m; dragRef.current = target.m;
      modeRef.current = target.part === 'arrow' ? (activePath(target.m) ? 'pathEnd' : 'angle') : 'move';
      dragStartRef.current = { pointer: p, x: target.m.x, y: target.m.y, path: (target.m.path || []).map((q) => ({ ...q })) };
      syncSlidersToSelected(); rerender();
    } else {
      selectedRef.current = null; redraw(); rerender();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointerPos(e);
    if (tabRef.current === 'draw') {
      if (!liveOpRef.current) return;
      liveOpRef.current.points.push(p); redraw();
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const mode = modeRef.current;
    const ds = dragStartRef.current;
    if (mode === 'move') {
      const dx = p.x - ds.pointer.x, dy = p.y - ds.pointer.y;
      drag.x = ds.x + dx; drag.y = ds.y + dy;
      if (ds.path.length) drag.path = ds.path.map((q: Pt) => ({ x: q.x + dx, y: q.y + dy }));
    } else if (mode === 'angle') {
      drag.ang = Math.atan2(p.y - drag.y, p.x - drag.x);
    } else if (mode === 'pathEnd') {
      const path = activePath(drag);
      if (path) { path[path.length - 1] = { x: p.x, y: p.y }; const pp = path[Math.max(0, path.length - 4)]; drag.ang = Math.atan2(p.y - pp.y, p.x - pp.x); }
    } else if (mode === 'label') {
      drag.labelOffset = { x: ds.labelOffset.x + p.x - ds.pointer.x, y: ds.labelOffset.y + p.y - ds.pointer.y };
      drag.labelPos = 'custom'; setLabelPos('custom');
    } else if (mode === 'shift') {
      shiftPtsRef.current.push(p);
      const a = shiftPtsRef.current[Math.max(0, shiftPtsRef.current.length - 6)];
      if (Math.hypot(p.x - a.x, p.y - a.y) > 2) drag.ang = Math.atan2(p.y - a.y, p.x - a.x);
    }
    redraw(mode === 'shift' ? shiftPtsRef.current : null);
  };

  const onPointerUp = () => {
    if (tabRef.current === 'draw') {
      const op = liveOpRef.current; liveOpRef.current = null;
      if (op) { opsRef.current = [...opsRef.current, op]; }
      redraw(); rerender(); return;
    }
    const drag = dragRef.current, mode = modeRef.current;
    if (drag && mode === 'shift' && !drag.isLabel) {
      const pts = shiftPtsRef.current, s = pts[0], ep = pts[pts.length - 1];
      if (Math.hypot(ep.x - s.x, ep.y - s.y) > (cvRef.current?.width ?? 1000) * 0.06) { drag.path = pts.filter((_, i) => i % 3 === 0); drag.path.push(ep); }
      drag.x = s.x; drag.y = s.y;
    }
    const wasShift = mode === 'shift';
    dragRef.current = null; modeRef.current = null; shiftPtsRef.current = []; dragStartRef.current = null;
    if (wasShift && pathDrawRef.current) setPathDraw(false); // 一次性:画完一条即退出轨迹模式
    redraw(); rerender();
  };

  const commitText = () => {
    const d = textDraft;
    setTextDraft(null);
    if (d && d.value.trim()) {
      snapOps();
      opsRef.current = [...opsRef.current, { kind: 'text', color: drawColor, size: Math.max(14, drawWidth * baseUnit() * 0.5), x: d.x, y: d.y, text: d.value.trim() }];
      redraw(); rerender();
    }
  };

  const addRole = () => {
    const n = name.trim();
    if (!n) return;
    placingRef.current = { name: n, color, isLabel: labelMode, labelPos: defaultLabelPosRef.current };
    rerender();
  };

  const handleSave = async () => {
    const cv = cvRef.current;
    if (!cv) return;
    redraw(null, true); // 去掉选中高亮
    const blob = await new Promise<Blob | null>((resolve) => cv.toBlob(resolve, 'image/png'));
    redraw();
    if (blob) await onSave(blob);
  };

  const hasContent = marksRef.current.length > 0 || opsRef.current.length > 0;
  const canUndo = tab === 'draw' ? opsRef.current.length > 0 : mHistRef.current.length > 0;
  const canRedo = tab === 'draw' ? opsRedoRef.current.length > 0 : mRedoRef.current.length > 0;
  const selected = selectedRef.current;

  const slider = (
    label: string,
    val: number,
    set: (n: number) => void,
    kind: 'circleScale' | 'arrowScale' | 'lineScale' | 'nameScale',
    locked: boolean,
    setLocked: (v: boolean) => void,
  ) => (
    <div className="flex items-center gap-1.5 text-xs text-neutral-300">
      <span>{label}</span>
      <input type="range" min={50} max={200} step={5} value={val}
        onChange={(e) => { const v = Number(e.target.value); set(v); applyScale(v, kind, locked); }}
        className="w-20 accent-sky-400" />
      <span className="w-9 text-right text-sky-300">{val}%</span>
      <label className="flex items-center gap-0.5 text-neutral-400" title={t('锁定统一大小(勾=所有角色一起改;不勾=只改选中角色)', 'Lock uniform size (on = all roles; off = selected only)')}>
        <input type="checkbox" checked={locked}
          onChange={(e) => { const c = e.target.checked; setLocked(c); if (c) applyScale(val, kind, true); else syncSlidersToSelected(); }} />
        {t('锁', 'Lock')}
      </label>
    </div>
  );

  const shell = (
    <div className="fixed inset-0 z-[120] flex flex-col bg-[#0e0f13]/95 text-neutral-100 backdrop-blur-sm">
      {/* 顶栏:tab + 关闭 */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] p-0.5">
          <button type="button" onClick={() => setTab('position')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition ${tab === 'position' ? 'bg-white/15 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}>
            <Users className="h-4 w-4" /> {t('人物站位', 'Positioning')}
          </button>
          <button type="button" onClick={() => setTab('draw')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition ${tab === 'draw' ? 'bg-white/15 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}>
            <Brush className="h-4 w-4" /> {t('自由画笔', 'Freehand')}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={saving || !ready || !hasContent}>
            {saving ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{t('保存中', 'Saving')}</> : t('保存为新图', 'Save as image')}
          </Button>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-neutral-400 transition hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-white/10 px-4 py-2 text-sm">
        {tab === 'position' ? (
          <>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addRole(); }}
              placeholder={t('角色名（如：摊主）', 'Role name')} className="w-36 rounded-md border border-white/15 bg-white/[0.08] px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-sky-400" />
            <select value={color} onChange={(e) => setColor(e.target.value)} className="rounded-md border border-white/15 bg-[#1b1c22] px-2 py-1.5 text-sm text-neutral-100">
              {COLORS.map((c) => <option key={c.v} value={c.v}>{c.zh}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-neutral-400"><input type="checkbox" checked={labelMode} onChange={(e) => setLabelMode(e.target.checked)} /> {t('纯文字标签', 'Text label')}</label>
            <Button size="sm" variant="secondary" onClick={addRole} disabled={!name.trim() || !ready}>{t('添加角色（然后点图放置）', 'Add role, then click')}</Button>
            <div className="mx-1 h-5 w-px bg-white/10" />
            {slider(t('圆圈', 'Dot'), circle, setCircle, 'circleScale', circleLock, setCircleLock)}
            {slider(t('箭头', 'Arrow'), arrow, setArrow, 'arrowScale', arrowLock, setArrowLock)}
            {slider(t('线条', 'Line'), line, setLine, 'lineScale', lineLock, setLineLock)}
            {slider(t('名字', 'Name'), nameSize, setNameSize, 'nameScale', nameLock, setNameLock)}
            <label className="flex items-center gap-1 text-xs text-neutral-300">{t('名字方向', 'Label dir')}
              <select value={labelPos} onChange={(e) => {
                const v = e.target.value; setLabelPos(v);
                const s = selectedRef.current;
                if (s) { s.labelPos = v; if (v !== 'custom') delete s.labelOffset; }
                else if (v !== 'custom') defaultLabelPosRef.current = v;
                redraw();
              }} className="rounded-md border border-white/15 bg-[#1b1c22] px-2 py-1.5 text-sm text-neutral-100">
                {LABEL_DIRS.map((d) => <option key={d.v} value={d.v}>{zh ? d.zh : d.en}</option>)}
                {labelPos === 'custom' ? <option value="custom">{t('自定义', 'Custom')}</option> : null}
              </select>
            </label>
            <Button
              size="sm"
              variant={pathDraw ? 'default' : 'secondary'}
              disabled={!selected}
              onClick={() => setPathDraw((v) => !v)}
              title={t('选中角色后开启，从角色拖到目标位置即成移动虚线(也可按住 Shift 直接拖)', 'Select a role, then drag from it to draw a movement path (or hold Shift and drag)')}
            >
              {pathDraw ? t('拖出轨迹…', 'Drag path…') : t('画移动轨迹', 'Draw path')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant={drawTool === 'pen' ? 'default' : 'secondary'} onClick={() => setDrawTool('pen')}><Brush className="mr-1 h-4 w-4" />{t('画笔', 'Pen')}</Button>
            <Button size="sm" variant={drawTool === 'text' ? 'default' : 'secondary'} onClick={() => setDrawTool('text')}><Type className="mr-1 h-4 w-4" />{t('文字', 'Text')}</Button>
            <div className="mx-1 h-5 w-px bg-white/10" />
            <div className="flex items-center gap-1">
              {['#e74c3c', '#f39c12', '#2ecc71', '#3498db', '#9b59b6', '#ffffff', '#111827'].map((c) => (
                <button key={c} type="button" onClick={() => setDrawColor(c)}
                  className={`h-5 w-5 rounded-full border ${drawColor === c ? 'border-sky-400 ring-1 ring-sky-400' : 'border-white/20'}`} style={{ background: c }} />
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-neutral-300">{t('粗细', 'Width')}
              <input type="range" min={2} max={20} step={1} value={drawWidth} onChange={(e) => setDrawWidth(Number(e.target.value))} className="w-24 accent-sky-400" />
            </label>
          </>
        )}
        <div className="mx-1 h-5 w-px bg-white/10" />
        <Button size="sm" variant="secondary" onClick={undo} disabled={!canUndo}><Undo2 className="h-4 w-4" /></Button>
        <Button size="sm" variant="secondary" onClick={redo} disabled={!canRedo}><Redo2 className="h-4 w-4" /></Button>
        {tab === 'position' ? (
          <Button size="sm" variant="secondary" onClick={deleteLast} className="text-red-400">
            <Trash2 className="mr-1 h-4 w-4" />{selected ? t('删除选中', 'Delete selected') : t('删除最后一个角色', 'Delete last')}
          </Button>
        ) : null}
      </div>

      {/* 画布 */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {loadError ? (
          <div className="text-sm text-neutral-400">{t('图片加载失败(可能跨域)', 'Image failed to load (CORS?)')}</div>
        ) : (
          <div className="relative">
            <canvas
              ref={cvRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="block max-h-[calc(100vh-190px)] max-w-full rounded-md"
              style={{ cursor: tab === 'draw' ? (drawTool === 'text' ? 'text' : 'crosshair') : (placingRef.current ? 'copy' : 'crosshair'), width: 'auto', height: 'auto' }}
            />
            {textDraft ? (
              <input autoFocus value={textDraft.value}
                onChange={(e) => setTextDraft((d) => (d ? { ...d, value: e.target.value } : d))}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitText(); if (e.key === 'Escape') setTextDraft(null); }}
                onBlur={commitText}
                placeholder={t('输入文字…', 'Text…')}
                className="absolute z-10 rounded border border-white/40 bg-black/70 px-1.5 py-0.5 text-sm outline-none"
                style={{ left: `${(textDraft.x / (cvRef.current?.width || 1)) * 100}%`, top: `${(textDraft.y / (cvRef.current?.height || 1)) * 100}%`, color: drawColor }}
              />
            ) : null}
          </div>
        )}
      </div>

      {/* 底栏 */}
      <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-2.5">
        <div className="min-w-0 flex-1 truncate text-xs text-neutral-500">
          {tab === 'position'
            ? t('填名字选颜色→点【添加角色】→点图放置｜拖圆点=移动，拖箭头尖=朝向，拖名字=挪位置｜移动虚线:选中角色后点【画移动轨迹】再拖(或按住 Shift 拖)｜Delete删除', 'Add role → click to place. Drag dot=move, arrow tip=facing, drag name=reposition. Path: select a role, click Draw path, then drag (or Shift-drag). Delete=remove')
            : t('画笔自由涂画 / 文字点击落字。两种模式的内容都会一起烘焙进导出图。', 'Freehand pen / click to add text. Both modes are baked into the export.')}
        </div>
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t('取消', 'Cancel')}</Button>
      </div>
    </div>
  );

  return createPortal(shell, document.body);
}
