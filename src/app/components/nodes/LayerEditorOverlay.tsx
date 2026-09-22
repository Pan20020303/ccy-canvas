import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Download, Save, ChevronDown, ChevronUp, LayoutGrid, Folder, History as HistoryIcon,
  Plus, Loader2, Trash2, Magnet, Scan, ChevronsUp, ChevronsDown, Layers,
} from 'lucide-react';
import clsx from 'clsx';

import { useStore } from '../../store';
import { uploadFile } from '../../api/projects';
import { toRenderableMediaUrl } from '../../reference-media';
import type { LayerEditorData, LayerEditorLayer } from './LayerEditorNode';
import { fitLayerRect, layerRect, layerSnapTargets, rectToLayer, reframeLayer, transformLayerRect, type LayerBounds, type LayerGuides, type LayerHandle, type LayerRect } from './layer-editor-geometry';

/**
 * 图层编辑器(参考交互):
 *   - 顶左:画布比例下拉 + 背景取色 + 「透明」开关
 *   - 顶右:下载 / 保存 / 关闭
 *   - 左侧:拼接(宫格拼接弹层)、画布图片、历史生成
 *   - 右侧:从顶到底的图层列表，可选择被遮挡的层并上移 / 下移 / 置顶 / 置底
 *   - 画布:棋盘格透明底,图层可拖拽移动 / 角点缩放,Del 删除
 * 保存 = 合成 PNG 上传(COS URL)写回节点 data.url,下游拉线即图片参考。
 */

const RATIO_OPTIONS = ['Free', '1:1', '4:3', '3:4', '16:9', '9:16', '2:1', '2.35:1'] as const;
const TRANSPARENCY_PREVIEW = 'repeating-conic-gradient(#26262b 0% 25%, #19191d 0% 50%) 0 0 / 24px 24px';
const RESIZE_HANDLES: { handle: LayerHandle; x: string; y: string; cursor: string; zh: string }[] = [
  { handle: 'nw', x: '0%', y: '0%', cursor: 'nwse-resize', zh: '左上' },
  { handle: 'n', x: '50%', y: '0%', cursor: 'ns-resize', zh: '上' },
  { handle: 'ne', x: '100%', y: '0%', cursor: 'nesw-resize', zh: '右上' },
  { handle: 'e', x: '100%', y: '50%', cursor: 'ew-resize', zh: '右' },
  { handle: 'se', x: '100%', y: '100%', cursor: 'nwse-resize', zh: '右下' },
  { handle: 's', x: '50%', y: '100%', cursor: 'ns-resize', zh: '下' },
  { handle: 'sw', x: '0%', y: '100%', cursor: 'nesw-resize', zh: '左下' },
  { handle: 'w', x: '0%', y: '50%', cursor: 'ew-resize', zh: '左' },
];
type LayerDrag = {
  id: string; pointerId: number; target: HTMLElement; mode: 'move' | LayerHandle;
  startX: number; startY: number; start: LayerRect; canvas: LayerBounds;
  targets: ReturnType<typeof layerSnapTargets>; snap: boolean;
};
type LayerOrderAction = 'forward' | 'backward' | 'front' | 'back';

function ratioWH(ratio: string): [number, number] {
  if (ratio === 'Free') return [16, 9];
  if (ratio === '2.35:1') return [235, 100];
  const [w, h] = ratio.split(':').map(Number);
  return w > 0 && h > 0 ? [w, h] : [16, 9];
}

/** 经媒体代理加载图片(同源,画到 canvas 上不会污染,导出才能 toDataURL)。 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url.slice(0, 80)}`));
    img.src = url.startsWith('data:') ? url : (toRenderableMediaUrl(url) || url);
  });
}

async function uploadComposedDataUrl(dataUrl: string, filename: string): Promise<string | null> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const res = await uploadFile(blob, filename);
    return res.url || null;
  } catch (err) {
    console.warn('[LayerEditor] upload failed', err);
    return null;
  }
}

const newId = () => `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export function LayerEditorOverlay() {
  const nodeId = useStore((s) => s.layerEditorNodeId);
  const close = useStore((s) => s.closeLayerEditor);
  const nodes = useStore((s) => s.nodes);
  const history = useStore((s) => s.history);
  const updateNodeData = useStore((s) => s.updateNodeData);
  const language = useStore((s) => s.language);
  const zh = language === 'zh';

  const node = useMemo(() => nodes.find((n) => n.id === nodeId), [nodes, nodeId]);
  const data = (node?.data ?? {}) as LayerEditorData;

  const [layers, setLayers] = useState<LayerEditorLayer[]>(() => {
    const [w, h] = ratioWH(data.ratio ?? '16:9');
    return (Array.isArray(data.layers) ? data.layers : []).map(layer => reframeLayer(layer, w / h, w / h));
  });
  const [ratio, setRatio] = useState<string>(data.ratio ?? '16:9');
  const [transparent, setTransparent] = useState<boolean>(data.transparent ?? true);
  const [bg, setBg] = useState<string>(data.bg ?? '#000000');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [panel, setPanel] = useState<'grid' | 'images' | 'history' | null>(null);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [snapEnabled, setSnapEnabled] = useState(data.snapEnabled ?? true);
  const [guides, setGuides] = useState<LayerGuides>({});
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const dragRef = useRef<LayerDrag | null>(null);
  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null; // Clear first: releasing capture can dispatch lostpointercapture synchronously.
    if (!drag) return;
    setGuides({});
    if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
  }, []);

  // 宫格拼接状态
  const [gridSize, setGridSize] = useState<2 | 3 | 4>(2);
  const [gridCells, setGridCells] = useState<(string | null)[]>(() => Array(4).fill(null));
  const [gridGap, setGridGap] = useState(4);
  const [gridBg, setGridBg] = useState('#000000');
  const [gridTransparent, setGridTransparent] = useState(true);
  const [gridPick, setGridPick] = useState<number | null>(null);
  const [gridBusy, setGridBusy] = useState(false);

  const canvasBoxRef = useRef<HTMLDivElement>(null);

  // 画布上的可用图片(按节点类型取各自的图字段,去重)。
  const canvasImages = useMemo(() => {
    const urls: string[] = [];
    for (const n of nodes) {
      const d = (n.data ?? {}) as Record<string, unknown>;
      let candidate: unknown = null;
      if (n.type === 'imageNode' || n.type === 'referenceImageNode' || n.type === 'panoramaNode' || n.type === 'layerEditorNode') {
        candidate = d.url;
      } else if (n.type === 'compositionPreviewNode') {
        candidate = d.image;
      } else if (n.type === 'directorStageNode') {
        candidate = d.editorPreview;
      }
      if (typeof candidate === 'string' && candidate && !urls.includes(candidate)) urls.push(candidate);
    }
    return urls;
  }, [nodes]);

  const historyImages = useMemo(
    () => history
      .filter((h) => h.mediaType === 'image' && (h.content || h.thumbnail))
      .map((h) => ({ id: h.id, url: (h.content || h.thumbnail) as string, thumb: (h.thumbnail || h.content) as string })),
    [history],
  );

  const [rw, rh] = ratioWH(ratio);
  const layerPanelWidth = Math.min(224, Math.max(168, viewport.width * 0.18));
  // 窗口缩放时更新画布显示尺寸，图层仍保留归一化坐标。
  const boxSize = useMemo(() => {
    const maxW = Math.min(viewport.width * 0.62, Math.max(120, viewport.width - 2 * (layerPanelWidth + 32)));
    const maxH = viewport.height * 0.72;
    const w = Math.min(maxW, (maxH * rw) / rh);
    return { w: Math.round(w), h: Math.round((w * rh) / rw) };
  }, [rw, rh, viewport, layerPanelWidth]);

  const changeRatio = (next: string) => {
    finishDrag();
    const [w, h] = ratioWH(next);
    setLayers(current => current.map(layer => reframeLayer(layer, rw / rh, w / h)));
    setRatio(next); setRatioOpen(false);
  };

  /** 添加图层:预载拿到宽高比,初始摆中间、宽度占画布 55%(超宽图适当收)。 */
  const addLayer = useCallback(async (url: string) => {
    try {
      const img = await loadImage(url);
      const aspect = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
      const layer: LayerEditorLayer = {
        id: newId(),
        image: url,
        xPct: 0.5,
        yPct: 0.5,
        wPct: Math.min(0.55, (0.7 * aspect * rh) / rw),
        aspect,
      };
      setLayers((prev) => [...prev, layer]);
      setSelectedId(layer.id);
    } catch (err) {
      console.warn('[LayerEditor] addLayer failed', err);
    }
  }, [rw, rh]);

  /** 点击素材图:宫格取图模式下填格子,否则加图层。 */
  const onPickImage = useCallback((url: string) => {
    if (gridPick !== null) {
      setGridCells((prev) => prev.map((c, i) => (i === gridPick ? url : c)));
      setGridPick(null);
      setPanel('grid');
      return;
    }
    void addLayer(url);
  }, [gridPick, addLayer]);

  const removeLayer = useCallback((id: string) => {
    finishDrag();
    setLayers((prev) => prev.filter((l) => l.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, [finishDrag]);

  /** One canonical bottom-to-top array drives preview, saved data and PNG export. */
  const moveLayer = useCallback((action: LayerOrderAction) => {
    if (saving || downloading || gridBusy) return;
    finishDrag();
    setLayers((prev) => {
      if (!selectedId) return prev;
      const idx = prev.findIndex((l) => l.id === selectedId);
      const next = action === 'front' ? prev.length - 1 : action === 'back' ? 0 : idx + (action === 'forward' ? 1 : -1);
      if (idx < 0 || next < 0 || next >= prev.length) return prev;
      if (idx === next) return prev;
      const copy = [...prev];
      const [moving] = copy.splice(idx, 1);
      copy.splice(next, 0, moving);
      return copy;
    });
  }, [selectedId, saving, downloading, gridBusy, finishDrag]);

  /** Eight anchored handles; only the captured pointer may move the selected layer. */
  const onLayerPointerDown = (event: React.PointerEvent, layer: LayerEditorLayer, mode: 'move' | LayerHandle) => {
    event.stopPropagation();
    if (event.button !== 0 || dragRef.current || saving || downloading) return;
    const box = canvasBoxRef.current?.getBoundingClientRect();
    if (!box?.width || !box.height) return;
    event.preventDefault();
    setSelectedId(layer.id);
    const canvas = { width: box.width, height: box.height };
    dragRef.current = {
      id: layer.id, pointerId: event.pointerId, target: event.currentTarget as HTMLElement, mode,
      startX: event.clientX, startY: event.clientY, start: fitLayerRect(layerRect(layer, canvas), canvas), canvas,
      targets: layerSnapTargets(canvas, layers.filter(l => l.id !== layer.id).map(l => layerRect(l, canvas))), snap: snapEnabled,
    };
    // Global listeners below also cover release outside the element/window.
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* A detached handle can lose capture during a render. */ }
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if ((event.buttons & 1) === 0) { finishDrag(); return; }
      if (event.cancelable) event.preventDefault();
      const result = transformLayerRect(drag.start, drag.mode, event.clientX - drag.startX, event.clientY - drag.startY, drag.canvas, drag.targets, drag.snap && !event.altKey);
      setLayers(current => current.map(layer => layer.id === drag.id ? rectToLayer(layer, result.rect, drag.canvas) : layer));
      setGuides({ x: result.guides.x === undefined ? undefined : result.guides.x / drag.canvas.width, y: result.guides.y === undefined ? undefined : result.guides.y / drag.canvas.height });
    };
    const end = (event: PointerEvent) => { if (event.pointerId === dragRef.current?.pointerId) finishDrag(); };
    const hidden = () => { if (document.visibilityState === 'hidden') finishDrag(); };
    const resize = () => { finishDrag(); setViewport({ width: window.innerWidth, height: window.innerHeight }); };
    window.addEventListener('pointermove', move, { passive: false, capture: true });
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('lostpointercapture', end, true);
    window.addEventListener('blur', finishDrag);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      finishDrag();
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      window.removeEventListener('lostpointercapture', end, true);
      window.removeEventListener('blur', finishDrag);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [finishDrag]);

  const fitSelectedLayer = () => {
    finishDrag();
    setLayers(current => current.map(layer => {
      if (layer.id !== selectedId) return layer;
      const width = Math.min(rw, rh * layer.aspect), height = width / layer.aspect;
      return rectToLayer(layer, { x: (rw - width) / 2, y: (rh - height) / 2, width, height }, { width: rw, height: rh });
    }));
  };

  /** 合成导出:长边 1600,经代理加载保持画布未污染。 */
  const composeDataUrl = useCallback(async (): Promise<string> => {
    const longSide = 1600;
    const W = rw >= rh ? longSide : Math.round((longSide * rw) / rh);
    const H = rw >= rh ? Math.round((longSide * rh) / rw) : longSide;
    const cnv = document.createElement('canvas');
    cnv.width = W;
    cnv.height = H;
    // 棋盘格只存在于编辑器 CSS；导出始终使用带 alpha 的 PNG 画布。
    const ctx = cnv.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.clearRect(0, 0, W, H);
    if (!transparent) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }
    for (const layer of layers) {
      // 图片没加载完时不能静默丢层，再把缺失的结果保存回节点。
      const img = await loadImage(layer.image);
      const rect = layerRect(layer, { width: W, height: H });
      ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height);
    }
    return cnv.toDataURL('image/png');
  }, [layers, rw, rh, transparent, bg]);

  const handleDownload = useCallback(async () => {
    if (downloading || saving) return;
    setDownloading(true);
    setExportError('');
    try {
      const dataUrl = await composeDataUrl();
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `layers-${Date.now()}.png`;
      a.click();
    } catch {
      setExportError(zh ? '导出失败，请确认所有图层图片可加载后重试。' : 'Export failed. Check that every layer image can load and try again.');
    } finally {
      setDownloading(false);
    }
  }, [composeDataUrl, downloading, saving, zh]);

  /** 保存:合成 → 上传 COS → 写回节点(url = 输出) → 关闭。 */
  const handleSave = useCallback(async () => {
    if (!nodeId || saving || downloading) return;
    setSaving(true);
    setExportError('');
    try {
      const dataUrl = await composeDataUrl();
      const uploaded = await uploadComposedDataUrl(dataUrl, `layers-${nodeId}.png`);
      updateNodeData(nodeId, {
        url: uploaded ?? dataUrl,
        output: uploaded ?? dataUrl,
        layers,
        ratio,
        transparent,
        bg,
        snapEnabled,
        status: 'done',
      });
      close();
    } catch (err) {
      console.warn('[LayerEditor] save failed', err);
      setExportError(zh ? '保存失败，原节点未改动。请检查图层图片后重试。' : 'Save failed. The original node is unchanged. Check layer images and try again.');
    } finally {
      setSaving(false);
    }
  }, [nodeId, saving, downloading, composeDataUrl, updateNodeData, layers, ratio, transparent, bg, snapEnabled, close, zh]);

  /** 宫格拼接 → 合成一张图作为新图层铺满画布。 */
  const applyGridToCanvas = useCallback(async () => {
    if (gridBusy) return;
    setGridBusy(true);
    setExportError('');
    try {
      const longSide = 1600;
      const W = rw >= rh ? longSide : Math.round((longSide * rw) / rh);
      const H = rw >= rh ? Math.round((longSide * rh) / rw) : longSide;
      const cnv = document.createElement('canvas');
      cnv.width = W;
      cnv.height = H;
      const ctx = cnv.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('Canvas is unavailable');
      ctx.clearRect(0, 0, W, H);
      if (!gridTransparent) {
        ctx.fillStyle = gridBg;
        ctx.fillRect(0, 0, W, H);
      }
      const gapPx = Math.round((gridGap / 400) * W); // 间距按预览 400px 宽等比换算
      const cellW = (W - gapPx * (gridSize + 1)) / gridSize;
      const cellH = (H - gapPx * (gridSize + 1)) / gridSize;
      for (let i = 0; i < gridSize * gridSize; i++) {
        const url = gridCells[i];
        if (!url) continue;
        const col = i % gridSize;
        const row = Math.floor(i / gridSize);
        const x = gapPx + col * (cellW + gapPx);
        const y = gapPx + row * (cellH + gapPx);
        const img = await loadImage(url);
        // cover 裁剪:铺满格子,超出部分裁掉。
        const scale = Math.max(cellW / img.naturalWidth, cellH / img.naturalHeight);
        const sw = cellW / scale;
        const sh = cellH / scale;
        const sx = (img.naturalWidth - sw) / 2;
        const sy = (img.naturalHeight - sh) / 2;
        ctx.drawImage(img, sx, sy, sw, sh, x, y, cellW, cellH);
      }
      const dataUrl = cnv.toDataURL('image/png');
      const layer: LayerEditorLayer = { id: newId(), image: dataUrl, xPct: 0.5, yPct: 0.5, wPct: 1, hPct: 1, aspect: W / H };
      setLayers((prev) => [...prev, layer]);
      setSelectedId(layer.id);
      setPanel(null);
      setGridPick(null);
    } catch {
      setExportError(zh ? '拼接失败，请检查所选图片后重试。' : 'Collage failed. Check the selected images and try again.');
    } finally {
      setGridBusy(false);
    }
  }, [gridBusy, rw, rh, gridBg, gridTransparent, gridGap, gridSize, gridCells, zh]);

  // 键盘:Del 删图层,Esc 先取消选中/关面板再关闭。
  useEffect(() => {
    if (!nodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && (e.target.matches('input, textarea, select') || e.target.isContentEditable)) return;
      if (saving || downloading || gridBusy) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        if (dragRef.current) finishDrag();
        else if (panel) setPanel(null);
        else if (selectedId) setSelectedId(null);
        else close();
        return;
      }
      if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        if (selectedId) removeLayer(selectedId);
      }
      if ((e.ctrlKey || e.metaKey) && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault();
        e.stopPropagation();
        moveLayer(e.code === 'BracketRight' ? (e.shiftKey ? 'front' : 'forward') : (e.shiftKey ? 'back' : 'backward'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nodeId, panel, selectedId, close, removeLayer, finishDrag, moveLayer, saving, downloading, gridBusy]);

  // 切宫格尺寸时重置格子数(保留已选的前 N 格)。
  useEffect(() => {
    setGridCells((prev) => {
      const total = gridSize * gridSize;
      const next = Array<string | null>(total).fill(null);
      for (let i = 0; i < Math.min(prev.length, total); i++) next[i] = prev[i];
      return next;
    });
    setGridPick(null);
  }, [gridSize]);

  if (!nodeId || !node) return null;

  const selectedIdx = selectedId ? layers.findIndex((l) => l.id === selectedId) : -1;
  const selectedLayer = layers[selectedIdx];
  const layerStyle = (layer: LayerEditorLayer) => ({
    left: `${layer.xPct * 100}%`, top: `${layer.yPct * 100}%`, width: `${layer.wPct * 100}%`,
    height: `${(layer.hPct ?? layer.wPct * rw / rh / layer.aspect) * 100}%`, transform: 'translate(-50%, -50%)',
  });

  const iconBtn = 'flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-neutral-300 transition hover:border-white/25 hover:text-white';

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-[#141518]">
      {/* 顶左:比例 + 背景色 + 透明开关 */}
      <div className="absolute left-5 top-5 z-20 flex flex-wrap items-center gap-2.5" style={{ maxWidth: 'calc(100% - 180px)' }}>
        <div className="relative">
          <button
            type="button"
            onClick={() => setRatioOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-2 text-[13px] font-medium text-white transition hover:bg-white/[0.1]"
          >
            {ratio}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </button>
          {ratioOpen ? (
            <div className="absolute left-0 top-11 z-30 w-[140px] rounded-xl border border-white/10 bg-[#101114] py-1.5 shadow-2xl">
              {RATIO_OPTIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => changeRatio(r)}
                  className={clsx(
                    'block w-full px-4 py-2 text-left text-[13px] transition',
                    r === ratio ? 'bg-white/[0.08] text-white' : 'text-neutral-300 hover:bg-white/[0.05]',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {/* 背景取色(透明关闭时生效) */}
        <label className={clsx('relative h-8 w-8 cursor-pointer overflow-hidden rounded-full border border-white/20', transparent && 'opacity-50')} title={zh ? '背景颜色' : 'Background color'}>
          <input type="color" value={bg} onChange={(e) => { setBg(e.target.value); setTransparent(false); }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
          <div className="h-full w-full" style={{ background: bg }} />
        </label>
        <button
          type="button"
          onClick={() => setTransparent((v) => !v)}
          aria-label={zh ? '透明背景' : 'Transparent background'}
          aria-pressed={transparent}
          title={zh ? '开启后，下载和保存的 PNG 保留空白背景透明；不会移除原图背景' : 'Keep empty areas transparent in downloaded and saved PNGs; original image backgrounds are unchanged'}
          className={clsx(
            'rounded-full px-3 py-1.5 text-[12px] transition',
            transparent ? 'bg-white/[0.14] text-white' : 'bg-white/[0.05] text-neutral-400 hover:text-white',
          )}
        >
          {zh ? '透明' : 'Alpha'}
        </button>
        <button type="button" aria-label={zh ? '磁吸对齐' : 'Snap alignment'} aria-pressed={snapEnabled} onClick={() => { finishDrag(); setSnapEnabled(v => !v); }} title={zh ? '对齐底图与其他图层的边缘、中心；按住 Alt 临时关闭' : 'Snap to canvas and layer edges/centers; hold Alt to bypass'} className={clsx('flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs', snapEnabled ? 'bg-cyan-400/15 text-cyan-200' : 'bg-white/5 text-neutral-400')}>
          <Magnet className="h-3.5 w-3.5" />{zh ? '磁吸' : 'Snap'}
        </button>
        <button type="button" onClick={fitSelectedLayer} disabled={!selectedLayer} title={zh ? '恢复原图比例并完整放入底图' : 'Restore image aspect and fit inside the canvas'} className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs text-neutral-300 disabled:opacity-30">
          <Scan className="h-3.5 w-3.5" />{zh ? '适应底图' : 'Fit canvas'}
        </button>
      </div>

      {/* 顶右:下载 / 保存 / 关闭 */}
      <div className="absolute right-5 top-5 z-20 flex items-center gap-2.5">
        <button type="button" onClick={() => void handleDownload()} disabled={saving || downloading || gridBusy} className={iconBtn} title={zh ? '下载 PNG' : 'Download PNG'}>
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => void handleSave()} className={iconBtn} disabled={saving || downloading || gridBusy} title={zh ? '保存到节点' : 'Save to node'}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        </button>
        <button type="button" onClick={close} className={iconBtn} title="Esc">
          <X className="h-4 w-4" />
        </button>
      </div>

      {exportError ? (
        <div role="alert" className="absolute bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-rose-950 px-4 py-2 text-sm text-rose-100">
          {exportError}
        </div>
      ) : null}

      {/* 左侧工具:拼接 / 画布图片 / 历史生成 */}
      <div className="absolute left-5 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1 rounded-full border border-white/[0.06] bg-[#1a1b1f]/90 p-1.5 backdrop-blur-md">
        <button
          type="button"
          onClick={() => setPanel((p) => (p === 'grid' ? null : 'grid'))}
          className={clsx(
            'flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-full transition',
            panel === 'grid' ? 'bg-indigo-500/80 text-white' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white',
          )}
          title={zh ? '宫格拼接' : 'Grid collage'}
        >
          <LayoutGrid className="h-4 w-4" />
          <span className="text-[9px] leading-none">{zh ? '拼接' : 'Grid'}</span>
        </button>
        <button
          type="button"
          onClick={() => { setPanel((p) => (p === 'images' ? null : 'images')); setGridPick(null); }}
          className={clsx(
            'flex h-10 w-10 items-center justify-center rounded-full transition',
            panel === 'images' ? 'bg-indigo-500/80 text-white' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white',
          )}
          title={zh ? '画布图片' : 'Canvas images'}
        >
          <Folder className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => { setPanel((p) => (p === 'history' ? null : 'history')); setGridPick(null); }}
          className={clsx(
            'flex h-10 w-10 items-center justify-center rounded-full transition',
            panel === 'history' ? 'bg-indigo-500/80 text-white' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-white',
          )}
          title={zh ? '历史生成' : 'History'}
        >
          <HistoryIcon className="h-4 w-4" />
        </button>
      </div>

      {/* The list can select covered layers; selecting never changes their stacking order. */}
      <aside aria-label={zh ? '图层层级' : 'Layer order'} className="absolute right-5 top-1/2 z-20 flex max-h-[70vh] -translate-y-1/2 flex-col rounded-xl border border-white/10 bg-[#1a1b1f]/95 p-3 shadow-xl backdrop-blur-md" style={{ width: layerPanelWidth }}>
        <div className="flex items-center gap-2 text-sm font-medium text-neutral-200"><Layers className="h-4 w-4" />{zh ? '图层' : 'Layers'}<span className="ml-auto text-xs text-neutral-500">{layers.length}</span></div>
        <p className="mb-2 mt-1 text-[11px] leading-relaxed text-neutral-500">{zh ? '上方图层遮盖下方，点击缩略图选中' : 'Top layers cover those below. Click to select.'}</p>
        <div role="group" aria-label={zh ? '图层列表（从顶到底）' : 'Layers (top to bottom)'} className="min-h-0 space-y-1 overflow-y-auto">
          {[...layers].reverse().map((layer, topIndex) => {
            const selected = layer.id === selectedId;
            const label = zh ? `第 ${topIndex + 1} 层` : `Layer ${topIndex + 1}`;
            return <button key={layer.id} type="button" data-layer-row={layer.id} aria-label={label} aria-pressed={selected} disabled={saving || downloading || gridBusy} onClick={() => { finishDrag(); setSelectedId(layer.id); }} className={clsx('flex w-full items-center gap-2 rounded-lg border p-1.5 text-left text-xs transition disabled:opacity-50', selected ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100' : 'border-transparent text-neutral-400 hover:bg-white/5 hover:text-white')}>
              <span className="h-9 w-10 shrink-0 overflow-hidden rounded" style={{ background: TRANSPARENCY_PREVIEW }}><img src={layer.image.startsWith('data:') ? layer.image : (toRenderableMediaUrl(layer.image) || layer.image)} alt="" draggable={false} className="h-full w-full object-contain" /></span>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {topIndex === 0 || topIndex === layers.length - 1 ? <span className="shrink-0 text-[10px] text-neutral-500">{topIndex === 0 ? (zh ? '顶层' : 'Top') : (zh ? '底层' : 'Bottom')}</span> : null}
            </button>;
          })}
          {!layers.length && <p className="py-4 text-center text-xs text-neutral-500">{zh ? '暂无图层' : 'No layers'}</p>}
        </div>
        <div className="mt-3 grid shrink-0 grid-cols-2 gap-1.5 border-t border-white/10 pt-3">
          {([
            ['forward', ChevronUp, zh ? '上移一层' : 'Forward', selectedIdx < 0 || selectedIdx >= layers.length - 1, 'Ctrl/⌘ + ]'],
            ['backward', ChevronDown, zh ? '下移一层' : 'Backward', selectedIdx <= 0, 'Ctrl/⌘ + ['],
            ['front', ChevronsUp, zh ? '置顶' : 'To front', selectedIdx < 0 || selectedIdx >= layers.length - 1, 'Ctrl/⌘ + Shift + ]'],
            ['back', ChevronsDown, zh ? '置底' : 'To back', selectedIdx <= 0, 'Ctrl/⌘ + Shift + ['],
          ] as const).map(([action, Icon, label, disabled, shortcut]) => <button key={action} type="button" aria-label={label} title={`${label} (${shortcut})`} onClick={() => moveLayer(action)} disabled={disabled || saving || downloading || gridBusy} className="flex min-h-8 items-center justify-center gap-1 rounded-md bg-white/5 px-1 py-1.5 text-[11px] text-neutral-300 transition hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/5"><Icon className="h-3.5 w-3.5 shrink-0" />{label}</button>)}
        </div>
        <p role="status" className="mt-2 shrink-0 text-[11px] text-neutral-500">{selectedIdx < 0 ? (zh ? '先选择需要调整的图层' : 'Select a layer to reorder') : (zh ? `已选：从顶部数第 ${layers.length - selectedIdx} 层` : `Selected: ${layers.length - selectedIdx} from top`)}</p>
      </aside>

      {/* 画布 */}
      <div className="flex h-full w-full items-center justify-center">
        <div
          ref={canvasBoxRef}
          data-layer-canvas="true"
          className="relative touch-none"
          style={{
            width: boxSize.w,
            height: boxSize.h,
            background: transparent
              ? TRANSPARENCY_PREVIEW
              : bg,
          }}
          onPointerDown={() => setSelectedId(null)}
        >
          {layers.map((layer) => (
            <div
              key={layer.id}
              data-layer-id={layer.id}
              className="absolute touch-none cursor-move select-none"
              style={layerStyle(layer)}
              onPointerDown={(e) => onLayerPointerDown(e, layer, 'move')}
            >
              <img
                src={layer.image.startsWith('data:') ? layer.image : (toRenderableMediaUrl(layer.image) || layer.image)}
                alt=""
                draggable={false}
                className="pointer-events-none block h-full w-full max-w-none object-fill"
              />
            </div>
          ))}
          {/* Controls live above all layers without changing the actual image/export stacking order. */}
          {selectedLayer ? (
            <div className="pointer-events-none absolute z-20 outline outline-1 outline-cyan-300" style={layerStyle(selectedLayer)}>
              {RESIZE_HANDLES.map(({ handle, x, y, cursor, zh: direction }) => (
                <button
                  key={handle}
                  type="button"
                  data-resize-handle={handle}
                  aria-label={zh ? `向${direction}缩放图层` : `Resize layer ${handle}`}
                  title={zh ? `${direction}：${handle.length === 2 ? '固定对角，等比缩放' : '固定对边，单独调整宽高'}` : handle.length === 2 ? 'Proportional resize from the opposite corner' : 'Resize this edge independently'}
                  className="pointer-events-auto absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center"
                  style={{ left: x, top: y, cursor }}
                  onPointerDown={e => onLayerPointerDown(e, selectedLayer, handle)}
                ><span className="h-2.5 w-2.5 rounded-sm border border-cyan-100 bg-cyan-400 shadow-sm" /></button>
              ))}
              <button
                type="button"
                aria-label={zh ? '删除选中图层' : 'Delete selected layer'}
                onPointerDown={e => e.stopPropagation()}
                onClick={() => removeLayer(selectedLayer.id)}
                className="pointer-events-auto absolute -right-2 -top-9 flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-white shadow hover:bg-rose-400"
              ><Trash2 className="h-3 w-3" /></button>
            </div>
          ) : null}
          {guides.x !== undefined && <div data-snap-guide="x" className="pointer-events-none absolute inset-y-0 z-20 border-l border-dashed border-cyan-300" style={{ left: `${guides.x * 100}%` }} />}
          {guides.y !== undefined && <div data-snap-guide="y" className="pointer-events-none absolute inset-x-0 z-20 border-t border-dashed border-cyan-300" style={{ top: `${guides.y * 100}%` }} />}
          {layers.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-neutral-500">
              {zh ? '从左侧「画布图片 / 历史生成」添加图层,或用「拼接」生成宫格' : 'Add layers from the left panels, or build a grid collage'}
            </div>
          ) : null}
        </div>
      </div>

      {!exportError && selectedLayer && <p className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 text-xs text-neutral-400">{zh ? '四角等比缩放 · 四边单独调节（拉伸） · Alt 临时关闭磁吸 · 自动限制在底图内' : 'Corners: proportional · Edges: stretch · Alt: bypass snapping · Kept inside canvas'}</p>}

      {/* 宫格拼接弹层 */}
      {panel === 'grid' ? (
        <div className="absolute left-1/2 top-1/2 z-30 w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/10 bg-[#101114]/98 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between pb-3">
            <span className="text-[13px] font-medium text-white">{zh ? '宫格拼接' : 'Grid collage'}</span>
            <button type="button" onClick={() => { setPanel(null); setGridPick(null); }} className="rounded p-0.5 text-white/40 transition hover:bg-white/[0.08] hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5 pb-3">
            {([2, 3, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setGridSize(n)}
                className={clsx(
                  'rounded-md border px-2 py-1.5 text-[12px] transition',
                  gridSize === n ? 'border-white/30 bg-white/[0.12] text-white' : 'border-white/10 bg-white/[0.03] text-neutral-400 hover:text-white',
                )}
              >
                {n}×{n}
              </button>
            ))}
          </div>
          <div
            className="grid rounded-md border border-white/[0.08] p-[var(--gap)]"
            style={{
              gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))`,
              gap: gridGap,
              ['--gap' as never]: `${gridGap}px`,
              background: gridTransparent ? TRANSPARENCY_PREVIEW : gridBg,
            }}
          >
            {Array.from({ length: gridSize * gridSize }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { setGridPick(i); setPanel('images'); }}
                className={clsx(
                  'relative flex items-center justify-center overflow-hidden text-neutral-500 transition hover:text-white',
                  gridSize === 2 ? 'h-[86px]' : gridSize === 3 ? 'h-[56px]' : 'h-[40px]',
                )}
                title={zh ? '选择这一格的图片' : 'Pick image for this cell'}
              >
                {gridCells[i] ? (
                  <img src={gridCells[i]!.startsWith('data:') ? gridCells[i]! : (toRenderableMediaUrl(gridCells[i]!) || gridCells[i]!)} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-3">
            <span className="w-8 shrink-0 text-[11px] text-neutral-400">{zh ? '间距' : 'Gap'}</span>
            <input type="range" min={0} max={32} step={1} value={gridGap} onChange={(e) => setGridGap(Number(e.target.value))} className="flex-1 accent-indigo-400" />
            <span className="w-9 text-right font-mono text-[11px] text-neutral-400">{gridGap}px</span>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <span className="w-8 shrink-0 text-[11px] text-neutral-400">{zh ? '背景' : 'BG'}</span>
            <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-white/20">
              <input type="color" aria-label={zh ? '宫格背景颜色' : 'Collage background color'} value={gridBg} onChange={(e) => { setGridBg(e.target.value); setGridTransparent(false); }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
              <div className="h-full w-full" style={{ background: gridBg }} />
            </label>
            <button
              type="button"
              aria-label={zh ? '宫格透明背景' : 'Transparent collage background'}
              aria-pressed={gridTransparent}
              onClick={() => setGridTransparent((v) => !v)}
              className={clsx('rounded-full px-3 py-1 text-xs', gridTransparent ? 'bg-white/15 text-white' : 'bg-white/5 text-neutral-400')}
            >
              {zh ? '透明' : 'Alpha'}
            </button>
            <span className="text-[10px] text-neutral-500">{zh ? '空格与间距' : 'Empty cells and gaps'}</span>
          </div>
          <button
            type="button"
            onClick={() => void applyGridToCanvas()}
            disabled={gridBusy || gridCells.every((c) => !c)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-indigo-500/80 to-violet-500/80 py-2 text-[13px] text-white transition hover:from-indigo-500 hover:to-violet-500 disabled:opacity-40"
          >
            {gridBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {zh ? '应用到画布' : 'Apply to canvas'}
          </button>
        </div>
      ) : null}

      {/* 画布图片 / 历史生成 面板 */}
      {panel === 'images' || panel === 'history' ? (
        <div className="absolute left-24 top-16 z-30 flex max-h-[76vh] w-[320px] flex-col rounded-xl border border-white/10 bg-[#101114]/98 p-3 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between pb-2">
            <span className="text-[13px] font-medium text-white">
              {panel === 'images' ? (zh ? '画布图片' : 'Canvas images') : (zh ? '历史生成' : 'History')}
              {gridPick !== null ? (
                <span className="ml-2 rounded bg-indigo-500/30 px-1.5 py-0.5 text-[10px] text-indigo-200">
                  {zh ? `选给第 ${gridPick + 1} 格` : `for cell ${gridPick + 1}`}
                </span>
              ) : null}
            </span>
            <button type="button" onClick={() => { setPanel(null); setGridPick(null); }} className="rounded p-0.5 text-white/40 transition hover:bg-white/[0.08] hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="prompt-editor-scroll grid flex-1 grid-cols-3 gap-1.5 overflow-y-auto pr-1">
            {(panel === 'images' ? canvasImages.map((u) => ({ key: u, url: u, thumb: u })) : historyImages.map((h) => ({ key: h.id, url: h.url, thumb: h.thumb }))).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onPickImage(item.url)}
                className="relative aspect-square overflow-hidden rounded-md border border-white/[0.06] bg-black/40 transition hover:border-white/30"
              >
                <img src={item.thumb.startsWith('data:') ? item.thumb : (toRenderableMediaUrl(item.thumb) || item.thumb)} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
              </button>
            ))}
            {(panel === 'images' ? canvasImages.length : historyImages.length) === 0 ? (
              <div className="col-span-3 py-10 text-center text-[11.5px] text-neutral-500">
                {panel === 'images' ? (zh ? '画布上还没有图片' : 'No images on canvas yet') : (zh ? '暂无历史生成' : 'No history yet')}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
