import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Download, Save, ChevronDown, ChevronUp, LayoutGrid, Folder, History as HistoryIcon,
  Plus, Minus, Hand, MousePointer2, Loader2, Trash2, Magnet, Scan, ChevronsUp, ChevronsDown, Layers, Crop,
} from 'lucide-react';
import clsx from 'clsx';

import { useStore } from '../../store';
import { uploadFile } from '../../api/projects';
import { toRenderableMediaUrl } from '../../reference-media';
import type { LayerEditorData, LayerEditorLayer } from './LayerEditorNode';
import { applyLayerCrop, layerRect, layerSnapTargets, rectToLayer, transformLayerRect, type LayerBounds, type LayerGuides, type LayerHandle, type LayerRect } from './layer-editor-geometry';
import { croppedAspect, FULL_CROP, normalizeCrop, transformCrop, type LayerCrop } from './layer-editor-crop';
import { LayerEditorImage } from './LayerEditorImage';
import { boardExport, boardUnits, contentBounds, fitBoardView, sourceRect, zoomBoard, type BoardView } from './layer-editor-board';

/**
 * 图层编辑器(参考交互):
 *   - 整屏自由画板，无固定比例或导出背景；在图片原位拖边裁切
 *   - 顶右:下载 / 保存 / 关闭
 *   - 左侧:拼接(宫格拼接弹层)、画布图片、历史生成
 *   - 右侧:从顶到底的图层列表，可选择被遮挡的层并上移 / 下移 / 置顶 / 置底
 *   - 平移 / 缩放仅影响视图；导出使用全部图片的可见包围框，空隙透明
 * 保存 = 合成 PNG 上传媒体存储并写回节点 data.url，下游拉线即图片参考。
 */

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
  targets: ReturnType<typeof layerSnapTargets>; snap: boolean; scale: number;
};
type CropDrag = { pointerId: number; target: HTMLElement; mode: 'move' | LayerHandle; startX: number; startY: number; width: number; height: number; start: LayerCrop };
type PanDrag = { pointerId: number; target: HTMLElement; startX: number; startY: number; view: BoardView; button: number };
type LayerOrderAction = 'forward' | 'backward' | 'front' | 'back';

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

  const [units] = useState(() => boardUnits(data));
  const [layers, setLayers] = useState<LayerEditorLayer[]>(() => Array.isArray(data.layers) ? data.layers : []);
  const [view, setView] = useState(() => fitBoardView(contentBounds(Array.isArray(data.layers) ? data.layers : [], boardUnits(data)), { width: window.innerWidth, height: window.innerHeight }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cropId, setCropId] = useState<string | null>(null);
  const [cropDraft, setCropDraft] = useState<LayerCrop>(FULL_CROP);
  const [cropFailed, setCropFailed] = useState(false);
  const [panMode, setPanMode] = useState(false);
  const [panel, setPanel] = useState<'grid' | 'images' | 'history' | null>(null);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [snapEnabled, setSnapEnabled] = useState(data.snapEnabled ?? true);
  const [guides, setGuides] = useState<LayerGuides>({});
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const dragRef = useRef<LayerDrag | null>(null);
  const cropDragRef = useRef<CropDrag | null>(null);
  const panDragRef = useRef<PanDrag | null>(null);
  const spaceHeld = useRef(false);
  const finishDrag = useCallback(() => {
    const active = [dragRef.current, cropDragRef.current, panDragRef.current];
    dragRef.current = null; cropDragRef.current = null; panDragRef.current = null;
    setGuides({});
    for (const drag of active) if (drag?.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
  }, []);

  // 宫格拼接状态
  const [gridSize, setGridSize] = useState<2 | 3 | 4>(2);
  const [gridCells, setGridCells] = useState<(string | null)[]>(() => Array(4).fill(null));
  const [gridGap, setGridGap] = useState(4);
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

  const layerPanelWidth = Math.min(224, Math.max(168, viewport.width * 0.18));

  /** 添加图层：保留原图比例，放在当前视图中心。 */
  const addLayer = useCallback(async (url: string) => {
    try {
      const img = await loadImage(url);
      const aspect = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
      const layer: LayerEditorLayer = {
        id: newId(),
        image: url,
        xPct: (viewport.width / 2 - view.x) / view.scale / units.width,
        yPct: (viewport.height / 2 - view.y) / view.scale / units.height,
        wPct: Math.min(600, 450 * aspect) / units.width,
        aspect,
      };
      setLayers((prev) => [...prev, layer]);
      setSelectedId(layer.id);
    } catch (err) {
      console.warn('[LayerEditor] addLayer failed', err);
    }
  }, [units, view, viewport]);

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
    if (saving || downloading || gridBusy || cropId) return;
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
  }, [selectedId, saving, downloading, gridBusy, cropId, finishDrag]);

  /** Eight anchored handles; only the captured pointer may move the selected layer. */
  const onLayerPointerDown = (event: React.PointerEvent, layer: LayerEditorLayer, mode: 'move' | LayerHandle) => {
    event.stopPropagation();
    if (event.button !== 0 || dragRef.current || cropDragRef.current || panDragRef.current || saving || downloading || gridBusy || cropId) return;
    event.preventDefault();
    setSelectedId(layer.id);
    const canvas = units;
    const otherRects = layers.filter(l => l.id !== layer.id).map(l => layerRect(l, canvas));
    const targets = { x: otherRects.flatMap(r => [r.x, r.x + r.width / 2, r.x + r.width]), y: otherRects.flatMap(r => [r.y, r.y + r.height / 2, r.y + r.height]) };
    dragRef.current = {
      id: layer.id, pointerId: event.pointerId, target: event.currentTarget as HTMLElement, mode,
      startX: event.clientX, startY: event.clientY, start: layerRect(layer, canvas), canvas,
      targets, snap: snapEnabled, scale: view.scale,
    };
    // Global listeners below also cover release outside the element/window.
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* A detached handle can lose capture during a render. */ }
  };

  const beginPan = (event: React.PointerEvent) => {
    if (![0, 1].includes(event.button) || saving || downloading || gridBusy) return;
    event.preventDefault(); event.stopPropagation(); finishDrag();
    panDragRef.current = { pointerId: event.pointerId, target: event.currentTarget as HTMLElement, startX: event.clientX, startY: event.clientY, view, button: event.button === 1 ? 4 : 1 };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window release is also handled. */ }
  };
  const startCrop = () => {
    const layer = layers.find(l => l.id === selectedId);
    if (!layer || saving || downloading || gridBusy) return;
    finishDrag(); setPanel(null); setCropId(layer.id); setCropDraft(normalizeCrop(layer.crop)); setPanMode(false); setCropFailed(false);
  };
  const cancelCrop = useCallback(() => { finishDrag(); setCropId(null); setCropFailed(false); }, [finishDrag]);
  const applyCrop = useCallback(() => {
    if (cropFailed) return;
    finishDrag();
    setLayers(current => current.map(layer => layer.id === cropId ? applyLayerCrop(layer, cropDraft, units, false) : layer));
    setCropId(null);
  }, [cropId, cropDraft, units, finishDrag, cropFailed]);
  const beginCrop = (event: React.PointerEvent, mode: CropDrag['mode']) => {
    event.stopPropagation(); event.preventDefault();
    const layer = layers.find(l => l.id === cropId);
    if (!layer || event.button !== 0 || cropDragRef.current || cropFailed) return;
    const rect = sourceRect(layer, units);
    cropDragRef.current = { pointerId: event.pointerId, target: event.currentTarget as HTMLElement, mode, startX: event.clientX, startY: event.clientY, width: rect.width * view.scale, height: rect.height * view.scale, start: cropDraft };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window release is also handled. */ }
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const pan = panDragRef.current;
      if (pan && event.pointerId === pan.pointerId) {
        if (!(event.buttons & pan.button)) { finishDrag(); return; }
        if (event.cancelable) event.preventDefault();
        setView({ ...pan.view, x: pan.view.x + event.clientX - pan.startX, y: pan.view.y + event.clientY - pan.startY }); return;
      }
      const crop = cropDragRef.current;
      if (crop && event.pointerId === crop.pointerId) {
        if (!(event.buttons & 1)) { finishDrag(); return; }
        if (event.cancelable) event.preventDefault();
        setCropDraft(transformCrop(crop.start, crop.mode, (event.clientX - crop.startX) / crop.width, (event.clientY - crop.startY) / crop.height)); return;
      }
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if ((event.buttons & 1) === 0) { finishDrag(); return; }
      if (event.cancelable) event.preventDefault();
      const result = transformLayerRect(drag.start, drag.mode, (event.clientX - drag.startX) / drag.scale, (event.clientY - drag.startY) / drag.scale, drag.canvas, drag.targets, drag.snap && !event.altKey, 7 / drag.scale, false);
      setLayers(current => current.map(layer => layer.id === drag.id ? rectToLayer(layer, result.rect, drag.canvas) : layer));
      setGuides(result.guides);
    };
    const end = (event: PointerEvent) => { if ([dragRef.current, cropDragRef.current, panDragRef.current].some(d => d?.pointerId === event.pointerId)) finishDrag(); };
    const hidden = () => { if (document.visibilityState === 'hidden') finishDrag(); };
    const resize = () => { finishDrag(); setViewport({ width: window.innerWidth, height: window.innerHeight }); };
    const blur = () => { spaceHeld.current = false; finishDrag(); };
    window.addEventListener('pointermove', move, { passive: false, capture: true });
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('lostpointercapture', end, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      finishDrag();
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      window.removeEventListener('lostpointercapture', end, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [finishDrag]);

  useEffect(() => {
    const element = canvasBoxRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); finishDrag();
      setView(current => zoomBoard(current, current.scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [finishDrag]);

  const fitSelectedLayer = () => {
    finishDrag();
    setLayers(current => current.map(layer => {
      if (layer.id !== selectedId) return layer;
      const aspect = croppedAspect(layer.aspect, layer.crop);
      const rect = layerRect(layer, units), height = rect.width / aspect;
      return rectToLayer(layer, { ...rect, y: rect.y + (rect.height - height) / 2, height }, units);
    }));
  };

  /** 合成导出:长边 1600,经代理加载保持画布未污染。 */
  const composeDataUrl = useCallback(async (): Promise<string> => {
    if (!layers.length) throw new Error('No layers to export');
    const output = boardExport(layers, units), W = output.width, H = output.height;
    const cnv = document.createElement('canvas');
    cnv.width = W;
    cnv.height = H;
    // 棋盘格只存在于编辑器 CSS；导出始终使用带 alpha 的 PNG 画布。
    const ctx = cnv.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.clearRect(0, 0, W, H);
    for (const layer of layers) {
      // 图片没加载完时不能静默丢层，再把缺失的结果保存回节点。
      const img = await loadImage(layer.image);
      const world = layerRect(layer, units);
      const rect = { x: (world.x - output.bounds.x) * output.scale, y: (world.y - output.bounds.y) * output.scale, width: world.width * output.scale, height: world.height * output.scale };
      if (layer.crop) {
        const c = normalizeCrop(layer.crop);
        ctx.drawImage(img, c.x * img.naturalWidth, c.y * img.naturalHeight, c.width * img.naturalWidth, c.height * img.naturalHeight, rect.x, rect.y, rect.width, rect.height);
      } else ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height);
    }
    return cnv.toDataURL('image/png');
  }, [layers, units]);

  const handleDownload = useCallback(async () => {
    if (downloading || saving || cropId) return;
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
  }, [composeDataUrl, downloading, saving, cropId, zh]);

  /** 保存：合成 → 上传媒体存储 → 写回节点(url = 输出) → 关闭。 */
  const handleSave = useCallback(async () => {
    if (!nodeId || saving || downloading || cropId) return;
    setSaving(true);
    setExportError('');
    try {
      const dataUrl = await composeDataUrl();
      const uploaded = await uploadComposedDataUrl(dataUrl, `layers-${nodeId}.png`);
      updateNodeData(nodeId, {
        url: uploaded ?? dataUrl,
        output: uploaded ?? dataUrl,
        layers,
        boardSize: units,
        editorMode: 'free',
        transparent: true,
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
  }, [nodeId, saving, downloading, cropId, composeDataUrl, updateNodeData, layers, units, snapEnabled, close, zh]);

  /** 宫格拼接 → 合成一张透明底图片，作为独立图层放入画板。 */
  const applyGridToCanvas = useCallback(async () => {
    if (gridBusy) return;
    setGridBusy(true);
    setExportError('');
    try {
      const W = 1600, H = 1600;
      const cnv = document.createElement('canvas');
      cnv.width = W;
      cnv.height = H;
      const ctx = cnv.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('Canvas is unavailable');
      ctx.clearRect(0, 0, W, H);
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
      const layer: LayerEditorLayer = { id: newId(), image: dataUrl, xPct: (viewport.width / 2 - view.x) / view.scale / units.width, yPct: (viewport.height / 2 - view.y) / view.scale / units.height, wPct: 800 / units.width, aspect: W / H };
      setLayers((prev) => [...prev, layer]);
      setSelectedId(layer.id);
      setPanel(null);
      setGridPick(null);
    } catch {
      setExportError(zh ? '拼接失败，请检查所选图片后重试。' : 'Collage failed. Check the selected images and try again.');
    } finally {
      setGridBusy(false);
    }
  }, [gridBusy, gridGap, gridSize, gridCells, zh, units, view, viewport]);

  // 键盘:Del 删图层,Esc 先取消选中/关面板再关闭。
  useEffect(() => {
    if (!nodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && (e.target.matches('input, textarea, select') || e.target.isContentEditable)) return;
      if (saving || downloading || gridBusy) return;
      const k = e.key.toLowerCase();
      const onButton = e.target instanceof HTMLElement && !!e.target.closest('button');
      const onCropHandle = e.target instanceof HTMLElement && e.target.hasAttribute('data-crop-handle');
      if (e.code === 'Space' && !onButton) { e.preventDefault(); spaceHeld.current = true; return; }
      if (cropId) {
        if (k === 'escape') { e.preventDefault(); cancelCrop(); }
        else if (k === 'enter' && (!onButton || onCropHandle)) { e.preventDefault(); applyCrop(); }
        return;
      }
      if (k === 'escape') {
        if (dragRef.current || panDragRef.current) finishDrag();
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
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeld.current = false; };
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', up); };
  }, [nodeId, panel, selectedId, close, removeLayer, finishDrag, moveLayer, saving, downloading, gridBusy, cropId, applyCrop, cancelCrop]);

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
  const cropLayer = layers.find(layer => layer.id === cropId);
  const screenRect = (rect: LayerRect) => ({ left: view.x + rect.x * view.scale, top: view.y + rect.y * view.scale, width: rect.width * view.scale, height: rect.height * view.scale });
  const layerStyle = (layer: LayerEditorLayer) => screenRect(layerRect(layer, units));
  const cropSource = cropLayer ? sourceRect(cropLayer, units) : null;
  const blocked = saving || downloading || gridBusy;

  const iconBtn = 'flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 bg-white text-neutral-600 shadow-sm transition hover:bg-neutral-100 disabled:opacity-30';

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-hidden bg-white" data-free-artboard="true">
      <div className="absolute left-5 top-5 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-white/95 p-2 shadow-lg" style={{ maxWidth: 'calc(100% - 180px)' }}>
        <span className="px-2 text-sm font-medium text-neutral-700">{zh ? '自由画板' : 'Artboard'}</span>
        <button type="button" aria-label={zh ? '磁吸对齐' : 'Snap alignment'} aria-pressed={snapEnabled} onClick={() => { finishDrag(); setSnapEnabled(v => !v); }} title={zh ? '对齐其他图层的边缘、中心；按住 Alt 临时关闭' : 'Snap to layer edges/centers; hold Alt to bypass'} className={clsx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs', snapEnabled ? 'bg-cyan-50 text-cyan-700' : 'text-neutral-500')}>
          <Magnet className="h-3.5 w-3.5" />{zh ? '磁吸' : 'Snap'}
        </button>
        <button type="button" onClick={fitSelectedLayer} disabled={!selectedLayer || blocked || !!cropId} title={zh ? '恢复所选图片的自然比例，不改变裁切范围' : 'Restore image proportions without changing the crop'} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-30">
          <Scan className="h-3.5 w-3.5" />{zh ? '还原比例' : 'Restore aspect'}
        </button>
        <button type="button" disabled={!selectedLayer || blocked || !!cropId} onClick={startCrop} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-30">
          <Crop className="h-3.5 w-3.5" />{zh ? '裁切图片' : 'Crop image'}
        </button>
        {cropId && <div role="toolbar" aria-label={zh ? '原位裁切' : 'Inline crop'} className="flex items-center gap-2 border-l border-neutral-200 pl-2 text-xs">
          <button type="button" onClick={() => { finishDrag(); setCropDraft({ ...FULL_CROP }); }} className="rounded px-2 py-1.5 text-neutral-600 hover:bg-neutral-100">{zh ? '恢复完整原图' : 'Restore full image'}</button>
          <button type="button" onClick={cancelCrop} className="rounded px-2 py-1.5 text-neutral-600 hover:bg-neutral-100">{zh ? '取消裁切' : 'Cancel crop'}</button>
          <button type="button" onClick={applyCrop} disabled={cropFailed} className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-30">{zh ? '应用裁切' : 'Apply crop'}</button>
        </div>}
      </div>

      {/* 顶右:下载 / 保存 / 关闭 */}
      <div className="absolute right-5 top-5 z-20 flex items-center gap-2.5">
        <button type="button" onClick={() => void handleDownload()} disabled={blocked || !!cropId || !layers.length} className={iconBtn} title={zh ? '下载 PNG' : 'Download PNG'}>
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => void handleSave()} className={iconBtn} disabled={blocked || !!cropId || !layers.length} title={zh ? '保存到节点' : 'Save to node'}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => { if (cropId) cancelCrop(); else close(); }} disabled={blocked} className={iconBtn} title="Esc">
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
          disabled={blocked || !!cropId}
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
          disabled={blocked || !!cropId}
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
          disabled={blocked || !!cropId}
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
            return <button key={layer.id} type="button" data-layer-row={layer.id} aria-label={label} aria-pressed={selected} disabled={blocked || !!cropId} onClick={() => { finishDrag(); setSelectedId(layer.id); }} className={clsx('flex w-full items-center gap-2 rounded-lg border p-1.5 text-left text-xs transition disabled:opacity-50', selected ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100' : 'border-transparent text-neutral-400 hover:bg-white/5 hover:text-white')}>
              <span className="h-9 w-10 shrink-0 overflow-hidden rounded" style={{ background: TRANSPARENCY_PREVIEW }}><LayerEditorImage layer={layer} /></span>
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
          ] as const).map(([action, Icon, label, disabled, shortcut]) => <button key={action} type="button" aria-label={label} title={`${label} (${shortcut})`} onClick={() => moveLayer(action)} disabled={disabled || blocked || !!cropId} className="flex min-h-8 items-center justify-center gap-1 rounded-md bg-white/5 px-1 py-1.5 text-[11px] text-neutral-300 transition hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-white/5"><Icon className="h-3.5 w-3.5 shrink-0" />{label}</button>)}
        </div>
        <p role="status" className="mt-2 shrink-0 text-[11px] text-neutral-500">{selectedIdx < 0 ? (zh ? '先选择需要调整的图层' : 'Select a layer to reorder') : (zh ? `已选：从顶部数第 ${layers.length - selectedIdx} 层` : `Selected: ${layers.length - selectedIdx} from top`)}</p>
      </aside>

      {/* 画布 */}
      <div className="h-full w-full">
        <div
          ref={canvasBoxRef}
          data-layer-canvas="true"
          data-board-scale={view.scale}
          className={clsx('absolute inset-0 touch-none overflow-hidden', panMode ? 'cursor-grab' : 'cursor-default')}
          onPointerDownCapture={e => { if (e.button === 1 || spaceHeld.current || panMode) beginPan(e); }}
          onPointerDown={e => { if (!cropId) setSelectedId(null); beginPan(e); }}
        >
          {layers.map((layer) => (
            <div
              key={layer.id}
              data-layer-id={layer.id}
              className="absolute touch-none cursor-move select-none"
              style={{ ...layerStyle(layer), visibility: layer.id === cropId ? 'hidden' : 'visible' }}
              onPointerDown={(e) => onLayerPointerDown(e, layer, 'move')}
            >
              <LayerEditorImage layer={layer} />
            </div>
          ))}
          {/* Controls live above all layers without changing the actual image/export stacking order. */}
          {selectedLayer && !cropId ? (
            <div className="pointer-events-none absolute z-20 outline outline-1 outline-cyan-300" style={layerStyle(selectedLayer)}>
              {RESIZE_HANDLES.map(({ handle, x, y, cursor, zh: direction }) => (
                <button
                  key={handle}
                  type="button"
                  disabled={blocked}
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
                disabled={blocked}
                onPointerDown={e => e.stopPropagation()}
                onClick={() => removeLayer(selectedLayer.id)}
                className="pointer-events-auto absolute -right-2 -top-9 flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-white shadow hover:bg-rose-400"
              ><Trash2 className="h-3 w-3" /></button>
            </div>
          ) : null}
          {cropLayer && cropSource && <div data-crop-source="true" className="absolute z-10 select-none outline outline-1 outline-blue-400/60" style={screenRect(cropSource)}>
            <img src={cropLayer.image.startsWith('data:') ? cropLayer.image : (toRenderableMediaUrl(cropLayer.image) || cropLayer.image)} alt="" draggable={false} onError={() => setCropFailed(true)} onLoad={() => setCropFailed(false)} className="pointer-events-none h-full w-full object-fill opacity-25"
              style={{ clipPath: `polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${cropDraft.x * 100}% ${cropDraft.y * 100}%, ${(cropDraft.x + cropDraft.width) * 100}% ${cropDraft.y * 100}%, ${(cropDraft.x + cropDraft.width) * 100}% ${(cropDraft.y + cropDraft.height) * 100}%, ${cropDraft.x * 100}% ${(cropDraft.y + cropDraft.height) * 100}%, ${cropDraft.x * 100}% ${cropDraft.y * 100}%)` }} />
            <div data-crop-selection="true" className="absolute cursor-move outline outline-1 outline-dashed outline-neutral-800" style={{ left: `${cropDraft.x * 100}%`, top: `${cropDraft.y * 100}%`, width: `${cropDraft.width * 100}%`, height: `${cropDraft.height * 100}%` }} onPointerDown={e => beginCrop(e, 'move')}>
              <LayerEditorImage layer={{ ...cropLayer, crop: cropDraft }} />
              {RESIZE_HANDLES.map(({ handle, x, y, cursor, zh: direction }) => <button key={handle} type="button" data-crop-handle={handle} aria-label={zh ? `裁切${direction}边缘` : `Crop ${handle} edge`} title={zh ? '拖动裁切边缘；方向键微调，Shift 加速' : 'Drag edge or nudge with arrow keys; Shift for larger steps'} onPointerDown={e => beginCrop(e, handle)}
                onKeyDown={e => { if (e.key.startsWith('Arrow')) { e.preventDefault(); e.stopPropagation(); finishDrag(); const step = (e.shiftKey ? 10 : 1) / view.scale; setCropDraft(c => transformCrop(c, handle, (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0) / cropSource.width, (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) / cropSource.height)); } }}
                className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center" style={{ left: x, top: y, cursor }}><span className={clsx('block bg-neutral-900 ring-1 ring-white', handle.length === 2 ? 'h-3 w-3' : handle === 'n' || handle === 's' ? 'h-1 w-6' : 'h-6 w-1')} /></button>)}
            </div>
          </div>}
          {guides.x !== undefined && <div data-snap-guide="x" className="pointer-events-none absolute inset-y-0 z-20 border-l border-dashed border-cyan-500" style={{ left: view.x + guides.x * view.scale }} />}
          {guides.y !== undefined && <div data-snap-guide="y" className="pointer-events-none absolute inset-x-0 z-20 border-t border-dashed border-cyan-500" style={{ top: view.y + guides.y * view.scale }} />}
          {layers.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-neutral-500">
              {zh ? '从左侧「画布图片 / 历史生成」添加图层,或用「拼接」生成宫格' : 'Add layers from the left panels, or build a grid collage'}
            </div>
          ) : null}
        </div>
      </div>

      {!exportError && <p role={cropFailed ? 'alert' : undefined} className="pointer-events-none absolute bottom-5 left-5 max-w-[50vw] text-xs text-neutral-500">{cropFailed ? (zh ? '原图加载失败，请取消裁切后重试。' : 'Source image failed to load. Cancel and retry.') : cropId ? (zh ? '拖动黑色边缘裁切 · 框外淡化部分不会导出 · Enter 确认 / Esc 取消' : 'Drag black edges to crop · Faded areas are excluded · Enter to apply / Esc to cancel') : (zh ? '空白处拖动平移 · 滚轮缩放 · 空格临时抓手 · 导出自动贴合内容，空隙透明' : 'Drag blank space to pan · Wheel to zoom · Space to pan · Export fits content with transparent gaps')}</p>}
      <div className="absolute bottom-4 right-5 z-30 flex items-center gap-2 rounded-xl border border-neutral-200 bg-white/95 p-2 shadow-lg">
        <button type="button" aria-label={zh ? '抓手平移' : 'Pan tool'} aria-pressed={panMode} onClick={() => { finishDrag(); setPanMode(v => !v); }} className={iconBtn}>{panMode ? <Hand className="h-4 w-4" /> : <MousePointer2 className="h-4 w-4" />}</button>
        <button type="button" aria-label={zh ? '缩小画板' : 'Zoom out'} className={iconBtn} onClick={() => { finishDrag(); setView(v => zoomBoard(v, v.scale / 1.2, viewport.width / 2, viewport.height / 2)); }}><Minus className="h-4 w-4" /></button>
        <span className="min-w-10 text-center text-xs text-neutral-600">{Math.round(view.scale * 100)}%</span>
        <button type="button" aria-label={zh ? '放大画板' : 'Zoom in'} className={iconBtn} onClick={() => { finishDrag(); setView(v => zoomBoard(v, v.scale * 1.2, viewport.width / 2, viewport.height / 2)); }}><Plus className="h-4 w-4" /></button>
        <button type="button" title={zh ? '查看全部图片' : 'Fit all images'} className="px-2 py-1 text-xs text-neutral-600" onClick={() => { finishDrag(); setView(fitBoardView(cropSource || contentBounds(layers, units), viewport)); }}>{zh ? '适应内容' : 'Fit content'}</button>
      </div>

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
              background: TRANSPARENCY_PREVIEW,
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
          <p className="pt-2 text-[10px] text-neutral-500">{zh ? '空格与间距保持透明' : 'Empty cells and gaps stay transparent'}</p>
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
