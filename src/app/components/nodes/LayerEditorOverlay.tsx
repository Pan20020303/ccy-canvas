import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Download, Save, ChevronDown, ChevronUp, LayoutGrid, Folder, History as HistoryIcon,
  Plus, Loader2, Trash2,
} from 'lucide-react';
import clsx from 'clsx';

import { useStore } from '../../store';
import { uploadFile } from '../../api/projects';
import { toRenderableMediaUrl } from '../../reference-media';
import type { LayerEditorData, LayerEditorLayer } from './LayerEditorNode';

/**
 * 图层编辑器(参考交互):
 *   - 顶左:画布比例下拉 + 背景取色 + 「透明」开关
 *   - 顶右:下载 / 保存 / 关闭
 *   - 左侧:拼接(宫格拼接弹层)、画布图片、历史生成
 *   - 右侧:选中图层的上移 / 下移(绘制顺序即叠放顺序)
 *   - 画布:棋盘格透明底,图层可拖拽移动 / 角点缩放,Del 删除
 * 保存 = 合成 PNG 上传(COS URL)写回节点 data.url,下游拉线即图片参考。
 */

const RATIO_OPTIONS = ['Free', '1:1', '4:3', '3:4', '16:9', '9:16', '2:1', '2.35:1'] as const;

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

  const [layers, setLayers] = useState<LayerEditorLayer[]>(() => (Array.isArray(data.layers) ? data.layers : []));
  const [ratio, setRatio] = useState<string>(data.ratio ?? '16:9');
  const [transparent, setTransparent] = useState<boolean>(data.transparent ?? true);
  const [bg, setBg] = useState<string>(data.bg ?? '#000000');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ratioOpen, setRatioOpen] = useState(false);
  const [panel, setPanel] = useState<'grid' | 'images' | 'history' | null>(null);
  const [saving, setSaving] = useState(false);

  // 宫格拼接状态
  const [gridSize, setGridSize] = useState<2 | 3 | 4>(2);
  const [gridCells, setGridCells] = useState<(string | null)[]>(() => Array(4).fill(null));
  const [gridGap, setGridGap] = useState(4);
  const [gridBg, setGridBg] = useState('#000000');
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
  // 画布盒尺寸:按窗口一次性计算(比例切换时重算),不追求实时响应窗口缩放。
  const boxSize = useMemo(() => {
    const maxW = (typeof window !== 'undefined' ? window.innerWidth : 1600) * 0.62;
    const maxH = (typeof window !== 'undefined' ? window.innerHeight : 900) * 0.72;
    const w = Math.min(maxW, (maxH * rw) / rh);
    return { w: Math.round(w), h: Math.round((w * rh) / rw) };
  }, [rw, rh]);

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
    setLayers((prev) => prev.filter((l) => l.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  /** 上移/下移:数组顺序即绘制顺序(后画的在上层)。 */
  const moveLayer = useCallback((dir: 1 | -1) => {
    setLayers((prev) => {
      if (!selectedId) return prev;
      const idx = prev.findIndex((l) => l.id === selectedId);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      return copy;
    });
  }, [selectedId]);

  /** 拖拽移动 / 角点缩放:pointer capture + 画布矩形换算成百分比。 */
  const dragRef = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; x0: number; y0: number; w0: number } | null>(null);
  const onLayerPointerDown = (event: React.PointerEvent, layer: LayerEditorLayer, mode: 'move' | 'resize') => {
    event.stopPropagation();
    setSelectedId(layer.id);
    dragRef.current = { id: layer.id, mode, startX: event.clientX, startY: event.clientY, x0: layer.xPct, y0: layer.yPct, w0: layer.wPct };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onLayerPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const box = canvasBoxRef.current;
    if (!drag || !box) return;
    const rect = box.getBoundingClientRect();
    const dx = (event.clientX - drag.startX) / rect.width;
    const dy = (event.clientY - drag.startY) / rect.height;
    setLayers((prev) => prev.map((l) => {
      if (l.id !== drag.id) return l;
      if (drag.mode === 'move') return { ...l, xPct: drag.x0 + dx, yPct: drag.y0 + dy };
      return { ...l, wPct: Math.max(0.04, drag.w0 + dx) };
    }));
  };
  const onLayerPointerUp = () => { dragRef.current = null; };

  /** 合成导出:长边 1600,经代理加载保持画布未污染。 */
  const composeDataUrl = useCallback(async (): Promise<string> => {
    const longSide = 1600;
    const W = rw >= rh ? longSide : Math.round((longSide * rw) / rh);
    const H = rw >= rh ? Math.round((longSide * rh) / rw) : longSide;
    const cnv = document.createElement('canvas');
    cnv.width = W;
    cnv.height = H;
    const ctx = cnv.getContext('2d')!;
    if (!transparent) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }
    for (const layer of layers) {
      try {
        const img = await loadImage(layer.image);
        const w = layer.wPct * W;
        const h = w / layer.aspect;
        ctx.drawImage(img, layer.xPct * W - w / 2, layer.yPct * H - h / 2, w, h);
      } catch (err) {
        console.warn('[LayerEditor] skip layer in compose', err);
      }
    }
    return cnv.toDataURL('image/png');
  }, [layers, rw, rh, transparent, bg]);

  const handleDownload = useCallback(async () => {
    const dataUrl = await composeDataUrl();
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `layers-${Date.now()}.png`;
    a.click();
  }, [composeDataUrl]);

  /** 保存:合成 → 上传 COS → 写回节点(url = 输出) → 关闭。 */
  const handleSave = useCallback(async () => {
    if (!nodeId || saving) return;
    setSaving(true);
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
        status: 'done',
      });
      close();
    } catch (err) {
      console.warn('[LayerEditor] save failed', err);
    } finally {
      setSaving(false);
    }
  }, [nodeId, saving, composeDataUrl, updateNodeData, layers, ratio, transparent, bg, close]);

  /** 宫格拼接 → 合成一张图作为新图层铺满画布。 */
  const applyGridToCanvas = useCallback(async () => {
    if (gridBusy) return;
    setGridBusy(true);
    try {
      const longSide = 1600;
      const W = rw >= rh ? longSide : Math.round((longSide * rw) / rh);
      const H = rw >= rh ? Math.round((longSide * rh) / rw) : longSide;
      const cnv = document.createElement('canvas');
      cnv.width = W;
      cnv.height = H;
      const ctx = cnv.getContext('2d')!;
      ctx.fillStyle = gridBg;
      ctx.fillRect(0, 0, W, H);
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
        try {
          const img = await loadImage(url);
          // cover 裁剪:铺满格子,超出部分裁掉。
          const scale = Math.max(cellW / img.naturalWidth, cellH / img.naturalHeight);
          const sw = cellW / scale;
          const sh = cellH / scale;
          const sx = (img.naturalWidth - sw) / 2;
          const sy = (img.naturalHeight - sh) / 2;
          ctx.drawImage(img, sx, sy, sw, sh, x, y, cellW, cellH);
        } catch (err) {
          console.warn('[LayerEditor] grid cell load failed', err);
        }
      }
      const dataUrl = cnv.toDataURL('image/png');
      const layer: LayerEditorLayer = { id: newId(), image: dataUrl, xPct: 0.5, yPct: 0.5, wPct: 1, aspect: W / H };
      setLayers((prev) => [...prev, layer]);
      setSelectedId(layer.id);
      setPanel(null);
      setGridPick(null);
    } finally {
      setGridBusy(false);
    }
  }, [gridBusy, rw, rh, gridBg, gridGap, gridSize, gridCells]);

  // 键盘:Del 删图层,Esc 先取消选中/关面板再关闭。
  useEffect(() => {
    if (!nodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        if (panel) setPanel(null);
        else if (selectedId) setSelectedId(null);
        else close();
        return;
      }
      if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        if (selectedId) removeLayer(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nodeId, panel, selectedId, close, removeLayer]);

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

  const iconBtn = 'flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-neutral-300 transition hover:border-white/25 hover:text-white';

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-[#141518]">
      {/* 顶左:比例 + 背景色 + 透明开关 */}
      <div className="absolute left-5 top-5 z-20 flex items-center gap-2.5">
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
                  onClick={() => { setRatio(r); setRatioOpen(false); }}
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
          className={clsx(
            'rounded-full px-3 py-1.5 text-[12px] transition',
            transparent ? 'bg-white/[0.14] text-white' : 'bg-white/[0.05] text-neutral-400 hover:text-white',
          )}
        >
          {zh ? '透明' : 'Alpha'}
        </button>
      </div>

      {/* 顶右:下载 / 保存 / 关闭 */}
      <div className="absolute right-5 top-5 z-20 flex items-center gap-2.5">
        <button type="button" onClick={() => void handleDownload()} className={iconBtn} title={zh ? '下载 PNG' : 'Download PNG'}>
          <Download className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => void handleSave()} className={iconBtn} disabled={saving} title={zh ? '保存到节点' : 'Save to node'}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        </button>
        <button type="button" onClick={close} className={iconBtn} title="Esc">
          <X className="h-4 w-4" />
        </button>
      </div>

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

      {/* 右侧:图层排序 */}
      <div className="absolute right-5 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1 rounded-full border border-white/[0.06] bg-[#1a1b1f]/90 p-1.5 backdrop-blur-md">
        <button
          type="button"
          onClick={() => moveLayer(1)}
          disabled={selectedIdx < 0 || selectedIdx >= layers.length - 1}
          className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
          title={zh ? '上移一层' : 'Bring forward'}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => moveLayer(-1)}
          disabled={selectedIdx <= 0}
          className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
          title={zh ? '下移一层' : 'Send backward'}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {/* 画布 */}
      <div className="flex h-full w-full items-center justify-center">
        <div
          ref={canvasBoxRef}
          className="relative overflow-hidden"
          style={{
            width: boxSize.w,
            height: boxSize.h,
            background: transparent
              ? 'repeating-conic-gradient(#26262b 0% 25%, #19191d 0% 50%) 0 0 / 24px 24px'
              : bg,
          }}
          onPointerDown={() => setSelectedId(null)}
        >
          {layers.map((layer) => (
            <div
              key={layer.id}
              className={clsx(
                'absolute cursor-move select-none',
                selectedId === layer.id && 'outline outline-2 outline-indigo-400/90',
              )}
              style={{
                left: `${layer.xPct * 100}%`,
                top: `${layer.yPct * 100}%`,
                width: `${layer.wPct * 100}%`,
                transform: 'translate(-50%, -50%)',
              }}
              onPointerDown={(e) => onLayerPointerDown(e, layer, 'move')}
              onPointerMove={onLayerPointerMove}
              onPointerUp={onLayerPointerUp}
            >
              <img
                src={layer.image.startsWith('data:') ? layer.image : (toRenderableMediaUrl(layer.image) || layer.image)}
                alt=""
                draggable={false}
                className="block w-full"
              />
              {selectedId === layer.id ? (
                <>
                  {/* 角点缩放 */}
                  <div
                    className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border border-white bg-indigo-400"
                    onPointerDown={(e) => onLayerPointerDown(e, layer, 'resize')}
                    onPointerMove={onLayerPointerMove}
                    onPointerUp={onLayerPointerUp}
                  />
                  {/* 删除 */}
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeLayer(layer.id)}
                    className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white shadow hover:bg-rose-400"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </>
              ) : null}
            </div>
          ))}
          {layers.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-neutral-500">
              {zh ? '从左侧「画布图片 / 历史生成」添加图层,或用「拼接」生成宫格' : 'Add layers from the left panels, or build a grid collage'}
            </div>
          ) : null}
        </div>
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
              background: gridBg,
            }}
          >
            {Array.from({ length: gridSize * gridSize }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { setGridPick(i); setPanel('images'); }}
                className={clsx(
                  'relative flex items-center justify-center overflow-hidden bg-[#1a1b1f] text-neutral-500 transition hover:text-white',
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
              <input type="color" value={gridBg} onChange={(e) => setGridBg(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
              <div className="h-full w-full" style={{ background: gridBg }} />
            </label>
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
