import { useState } from 'react';
import { Handle, NodeProps, Position } from '@xyflow/react';
import { Layers3, Pencil, CheckCircle2, Plus } from 'lucide-react';
import clsx from 'clsx';

import Magnet from '../Magnet';
import { useStore } from '../../store';
import { toRenderableMediaUrl } from '../../reference-media';

/**
 * 3D 导演台节点 — inline 卡片,不持有 WebGL 上下文。
 *
 * 视觉上跟其他节点完全一致:
 *   - 全卡片是 target 命中区(从任意位置释放连接都接得住)
 *   - 左右 + 泡泡仅在 hover / 选中时浮出
 *   - 卡内主体显示 overlay 关闭时落下的「编辑器预览图」(editorPreview)
 *
 * 多机位输出不再挂在导演台自己身上 —— 「确认构图」第二次点击会**派生**
 * 出每机位一个 `compositionPreviewNode`,自动连线指向它们(neowow 同款)。
 */

export type ActorPose = {
  torso?: [number, number, number];
  head?: [number, number, number];
  shoulderL?: [number, number, number];
  shoulderR?: [number, number, number];
  elbowL?: [number, number, number];
  elbowR?: [number, number, number];
  hipL?: [number, number, number];
  hipR?: [number, number, number];
  kneeL?: [number, number, number];
  kneeR?: [number, number, number];
  // 2026-07 关节扩展：手腕 / 脚踝（老数据没有这些键 — 全部可选，缺省视为 0）。
  wristL?: [number, number, number];
  wristR?: [number, number, number];
  ankleL?: [number, number, number];
  ankleR?: [number, number, number];
};

export type DirectorStageData = {
  characters?: Array<{
    id: string;
    assetId: string;
    label: string;
    position: [number, number, number];
    rotationY: number;
    scale: number;
    pose?: ActorPose;
  }>;
  props?: Array<{
    id: string;
    assetId: string;
    position: [number, number, number];
    rotationY: number;
    scale: number;
  }>;
  lights?: Array<{
    id: string;
    type: 'directional' | 'point';
    position: [number, number, number];
    color: string;
    intensity: number;
  }>;
  cameras?: Array<{
    id: string;
    label: string;
    position: [number, number, number];
    lookAt: [number, number, number];
    fov: number;
    aspect: '16:9' | '9:16' | '1:1' | '4:3' | '21:9';
    /** 荷兰角(绕视轴滚转,弧度),只作用在出图/预览。 */
    roll?: number;
  }>;
  activeCameraId?: string;
  /** AI识图导入的站位参考层 —— 半透明平铺在舞台地面辅助摆位。 */
  referenceLayer?: {
    image: string;
    width: number;
    height: number;
    timestamp: number;
  } | null;
  /** 舞台环境设置(全景背景 / 标签 / 参考线)——关闭或确认构图时落盘。 */
  stageSettings?: {
    skyColor?: string;
    groundOpacity?: number;
    groundY?: number;
    groundVisible?: boolean;
    labelsVisible?: boolean;
    labelFontSize?: number;
    cameraGuides?: boolean;
  };
  /** overlay 关闭时落下的主视口快照,作为节点主图. */
  editorPreview?: string;
  /** 每个机位独立的快照(派生 compositionPreviewNode 时用). */
  lastCaptures?: Record<string, {
    image: string;
    depth?: string;
    pose?: string;
    normal?: string;
    timestamp: number;
  }>;
  /** 兼容老节点 —— 早期单 capture. */
  lastCapture?: {
    cameraId: string;
    image: string;
    depth?: string;
    pose?: string;
    normal?: string;
    timestamp: number;
  };
  status?: 'idle' | 'composing' | 'done';
  customTitle?: string;
};

export function DirectorStageNode({ id, data: rawData, selected }: NodeProps) {
  const data = (rawData ?? {}) as DirectorStageData;
  const language = useStore((state) => state.language);
  const openDirectorStage = useStore((state) => state.openDirectorStage);
  const isConnectionDragging = useStore((state) => state.isConnectionDragging);
  const connectionDragType = useStore((state) => state.connectionDragType);
  const title = data.customTitle || (language === 'zh' ? '导演台' : 'Director Stage');

  const previewUrl = data.editorPreview
    || data.lastCapture?.image
    || (data.lastCaptures ? Object.values(data.lastCaptures)[0]?.image : undefined);
  const hasComposed = !!data.editorPreview || !!data.lastCapture || (data.lastCaptures && Object.keys(data.lastCaptures).length > 0);
  const status = data.status ?? (hasComposed ? 'done' : 'idle');

  const handleOpen = () => openDirectorStage(id);

  // 与 BaseNode 一致的磁吸快连泡泡状态(hover / 选中常显,吸附半径 90px)。
  const [hovered, setHovered] = useState(false);
  const [leftPull, setLeftPull] = useState(false);
  const [rightPull, setRightPull] = useState(false);
  const magnetDisabled = !hovered && !selected && !leftPull && !rightPull;

  return (
    <div
      className="group w-[300px]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-neutral-200">
        <Pencil className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <div className="min-w-0 font-medium tracking-wide">{title}</div>
      </div>

      {/* relative 外壳:磁吸泡泡必须挂在这里 —— 卡片本体是 overflow-hidden,
          泡泡定位在卡外 8px 会被裁掉(既看不见也点不到,"拉不出线"的根因)。 */}
      <div className="relative">
      <div
        className={clsx(
          'relative overflow-hidden rounded-[20px] bg-[rgba(24,24,27,0.98)] transition-shadow',
          selected ? 'shadow-[0_0_0_1px_rgb(255,255,255)]' : '',
        )}
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
        {/* 贴边渲染锚点 —— 连好的线连到节点边缘(右/左缘垂直居中),而不是
            外侧 20px 的 `+` 泡泡。1px、透明、pointer-events:none 纯渲染锚点。 */}
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

        {/* 主体:editorPreview / 占位 + 编辑按钮 / 「打开导演台」 */}
        {previewUrl ? (
          <div className="flex flex-col">
            <div className="relative aspect-[16/10] w-full bg-black">
              {/* COS/OSS 直链在部分网络环境不可达(防盗链/超时)——统一走
                  后端媒体代理(与其他图片节点一致),相对 /uploads 原样保留。 */}
              <img
                src={toRenderableMediaUrl(previewUrl, { thumbWidth: 720 })}
                alt="director stage preview"
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
            <div className="flex items-center justify-between border-t border-white/[0.04] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11.5px] text-violet-300/90">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {language === 'zh' ? '构图完成' : 'Composition ready'}
              </div>
              <button
                type="button"
                onClick={handleOpen}
                className="flex items-center gap-1 rounded-md border border-white/12 bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-neutral-100 transition hover:border-white/20 hover:bg-white/[0.08]"
              >
                <Pencil className="h-3 w-3" />
                {language === 'zh' ? '编辑' : 'Edit'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex aspect-[16/11] flex-col items-center justify-center gap-3 px-5 py-6 text-center">
            <Layers3 className="h-7 w-7 text-violet-400" strokeWidth={1.5} />
            <div className="flex flex-col gap-0.5">
              <div className="text-[13px] font-semibold text-neutral-100">
                {language === 'zh' ? '导演台' : 'Director Stage'}
              </div>
              <div className="text-[11px] text-neutral-500">
                {language === 'zh' ? '3D 构图编辑器' : '3D composition editor'}
              </div>
            </div>
            <button
              type="button"
              onClick={handleOpen}
              className="rounded-md border border-violet-400/30 bg-violet-500/[0.08] px-3 py-1.5 text-[11.5px] text-violet-100 transition hover:border-violet-400/60 hover:bg-violet-500/[0.16]"
            >
              {language === 'zh' ? '打开导演台' : 'Open stage'}
            </button>
            <div className="text-[10px] text-neutral-600">
              {status === 'composing'
                ? (language === 'zh' ? '正在构图…' : 'composing…')
                : (language === 'zh' ? '未构图' : 'not composed')}
            </div>
          </div>
        )}

      </div>

      {/* 左 + 泡泡(target)—— 与 BaseNode 同款磁吸快连。 */}
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
            id="dir-target-left"
            className="!static !h-6 !w-6 !transform-none !rounded-full !border-0 !bg-transparent"
            style={{ pointerEvents: 'auto' }}
          >
            <div className="pointer-events-none flex h-6 w-6 items-center justify-center rounded-full border border-white/50 bg-[#1a1d22]/90 shadow-[0_0_10px_rgba(226,232,240,0.4)] backdrop-blur-md">
              <Plus className="h-3 w-3 text-slate-50" />
            </div>
          </Handle>
        </Magnet>
      </div>

      {/* 右 + 泡泡(source)—— 磁吸快连;直接拉线输出「退出时的镜头」,
          「确认构图」也从这里自动连到派生的构图预览节点。 */}
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
