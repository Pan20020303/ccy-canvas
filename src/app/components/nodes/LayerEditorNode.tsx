import { useState } from 'react';
import { Handle, NodeProps, Position } from '@xyflow/react';
import { Layers, Pencil, Plus } from 'lucide-react';
import clsx from 'clsx';

import Magnet from '../Magnet';
import { useStore } from '../../store';
import type { LayerCrop } from './layer-editor-crop';

/**
 * 图层编辑节点 —— inline 卡片(参考样式):
 *   - 未编辑:占位「双击开始编辑图层」+ 右下角编辑小按钮
 *   - 已保存:合成图全面屏显示(图即整卡),双击 / 编辑按钮重新进编辑器
 *   - 输出:data.url = 合成 PNG，下游拉线即作图片参考
 * 交互与其他节点一致:全卡 target 命中区、贴边渲染锚点、磁吸快连 + 泡泡。
 */

export type LayerEditorLayer = {
  id: string;
  /** 原始图层图片 URL 或 dataURL，裁切/导出不覆盖原图。 */
  image: string;
  /** 中心点相对 boardSize 的坐标，可为负数或超过 1；自由画板不设边界。 */
  xPct: number;
  yPct: number;
  /** 图层宽度占画布宽度的比例 */
  wPct: number;
  /** 独立调节后的高度占画布高度的比例；旧图层缺省时沿用原图比例。 */
  hPct?: number;
  /** 原图宽高比(w/h)，用于旧数据兼容与还原比例。 */
  aspect: number;
  /** 非破坏性裁切：原图坐标 0..1，保留原图以便重新裁切。 */
  crop?: LayerCrop;
};

export type LayerEditorData = {
  /** 保存后的合成图(也是下游引用的输出) */
  url?: string;
  output?: string;
  /** 可重进编辑的图层描述 */
  layers?: LayerEditorLayer[];
  /** 旧版底图比例，仅用于首次换算坐标；新画板不显示或限制此比例。 */
  ratio?: string;
  transparent?: boolean;
  bg?: string;
  snapEnabled?: boolean;
  /** 自由画板的坐标单位；仅用于兼容旧图层，不限制位置或导出比例。 */
  boardSize?: { width: number; height: number };
  editorMode?: 'free';
  status?: string;
  customTitle?: string;
};

export function LayerEditorNode({ id, data: rawData, selected }: NodeProps) {
  const data = (rawData ?? {}) as LayerEditorData;
  const language = useStore((state) => state.language);
  const openLayerEditor = useStore((state) => state.openLayerEditor);
  const isConnectionDragging = useStore((state) => state.isConnectionDragging);
  const connectionDragType = useStore((state) => state.connectionDragType);
  const title = data.customTitle || (language === 'zh' ? '图层编辑' : 'Layer Editor');
  const preview = data.url || data.output;

  const [hovered, setHovered] = useState(false);
  const [leftPull, setLeftPull] = useState(false);
  const [rightPull, setRightPull] = useState(false);
  const magnetDisabled = !hovered && !selected && !leftPull && !rightPull;

  const handleOpen = () => openLayerEditor(id);

  return (
    <div
      className="group w-[300px]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-neutral-200">
        <Layers className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <div className="min-w-0 font-medium tracking-wide">{title}</div>
      </div>

      {/* relative 外壳:磁吸泡泡挂这里(卡片 overflow-hidden 会裁掉卡外泡泡)。 */}
      <div className="relative">
      <div
        className={clsx(
          'relative',
          // 合成图本身就是节点：不加底色、圆角裁切或选中描边，保留 PNG 的透明通道。
          !preview && 'overflow-hidden rounded-[20px] bg-[rgba(24,24,27,0.98)] transition-shadow',
          !preview && selected && 'shadow-[0_0_0_1px_rgb(255,255,255)]',
        )}
        onDoubleClick={(event) => {
          event.stopPropagation();
          handleOpen();
        }}
      >
        {/* 全卡 target 命中区(正向拖线);反向拖线时换全卡 source 接。 */}
        <Handle
          type="target"
          position={Position.Left}
          className="!left-0 !top-0 !h-full !w-full !cursor-default !rounded-[20px] !border-0 !bg-transparent !opacity-0"
          style={{ transform: 'none', pointerEvents: isConnectionDragging && connectionDragType !== 'target' ? 'auto' : 'none' }}
        />
        <Handle
          type="source"
          position={Position.Right}
          id="edge-source-full"
          className="!left-0 !top-0 !h-full !w-full !cursor-default !rounded-[20px] !border-0 !bg-transparent !opacity-0"
          style={{ transform: 'none', pointerEvents: isConnectionDragging && connectionDragType === 'target' ? 'auto' : 'none' }}
        />
        {/* 贴边渲染锚点 */}
        <Handle
          type="source"
          position={Position.Right}
          id="edge-source-right"
          className="!h-px !w-px !min-h-0 !min-w-0 !cursor-default !border-0 !bg-transparent !opacity-0"
          style={{ pointerEvents: 'none' }}
        />
        <Handle
          type="target"
          position={Position.Left}
          id="edge-target-left"
          className="!h-px !w-px !min-h-0 !min-w-0 !cursor-default !border-0 !bg-transparent !opacity-0"
          style={{ pointerEvents: 'none' }}
        />

        {preview ? (
          <div className="relative w-full">
            <img src={preview} alt="layer composition" draggable={false} className="block h-auto w-full" />
            <button
              type="button"
              onClick={handleOpen}
              className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg border border-white/15 bg-black/60 text-neutral-200 opacity-0 backdrop-blur-sm transition group-hover:opacity-100 hover:border-white/35"
              title={language === 'zh' ? '编辑图层' : 'Edit layers'}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="relative flex aspect-[16/11] flex-col items-center justify-center gap-3 px-5 py-6 text-center">
            <Layers className="h-7 w-7 text-neutral-500" strokeWidth={1.5} />
            <div className="text-[11.5px] text-neutral-500">
              {language === 'zh' ? '双击开始编辑图层' : 'Double-click to edit layers'}
            </div>
            <button
              type="button"
              onClick={handleOpen}
              className="absolute bottom-3 right-3 flex h-7 w-7 items-center justify-center rounded-lg border border-white/12 bg-white/[0.04] text-neutral-300 transition hover:border-white/30 hover:bg-white/[0.08]"
              title={language === 'zh' ? '编辑图层' : 'Edit layers'}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* 左 + 泡泡(target)—— BaseNode 同款磁吸快连。 */}
      <div
        className={clsx(
          'pointer-events-none absolute -left-8 top-1/2 z-10 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100',
          (leftPull || selected) && 'opacity-100',
        )}
      >
        <Magnet disabled={magnetDisabled} release={isConnectionDragging} outward="left" padding={90} magnetStrength={1} activeTransition="none" onActiveChange={setLeftPull}>
          <Handle
            type="target"
            position={Position.Left}
            id="qc-target-left"
            className="!static !h-6 !w-6 !transform-none !rounded-full !border-0 !bg-transparent"
            style={{ pointerEvents: 'auto' }}
          >
            <div className="pointer-events-none flex h-6 w-6 items-center justify-center rounded-full border border-white/50 bg-[#1a1d22]/90 shadow-[0_0_10px_rgba(226,232,240,0.4)] backdrop-blur-md">
              <Plus className="h-3 w-3 text-slate-50" />
            </div>
          </Handle>
        </Magnet>
      </div>

      {/* 右 + 泡泡(source)—— 输出合成图给下游。 */}
      <div
        className={clsx(
          'pointer-events-none absolute -right-8 top-1/2 z-10 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100',
          (rightPull || selected) && 'opacity-100',
        )}
      >
        <Magnet disabled={magnetDisabled} release={isConnectionDragging} outward="right" padding={90} magnetStrength={1} activeTransition="none" onActiveChange={setRightPull}>
          <Handle
            type="source"
            position={Position.Right}
            id="qc-source-right"
            className="!static !h-6 !w-6 !transform-none !rounded-full !border-0 !bg-transparent"
            style={{ pointerEvents: 'auto' }}
          >
            <div className="pointer-events-none flex h-6 w-6 items-center justify-center rounded-full border border-white/50 bg-[#1a1d22]/90 shadow-[0_0_10px_rgba(226,232,240,0.4)] backdrop-blur-md">
              <Plus className="h-3 w-3 text-slate-50" />
            </div>
          </Handle>
        </Magnet>
      </div>
      </div>
    </div>
  );
}
