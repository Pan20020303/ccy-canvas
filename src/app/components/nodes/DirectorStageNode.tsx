import { Handle, NodeProps, Position } from '@xyflow/react';
import { Layers3, Pencil, CheckCircle2, Plus, Video as VideoIcon } from 'lucide-react';
import clsx from 'clsx';

import { useStore } from '../../store';

/**
 * 3D 导演台节点 — inline 卡片,不持有 WebGL 上下文。
 *
 * 设计参照 neowow `sceneComposer`:画布上的节点只放缩略图 + 状态徽章 +
 * 「打开导演台」按钮。点击后弹出全屏 overlay,overlay 关闭时把每个机位
 * 的快照写回 `lastCaptures`,卡片刷新缩略图网格,每个机位**独立一个 source
 * handle** —— 下游 imageNode 可以从任意机位连线引用画面。
 */

export type ActorPose = {
  /** 躯干俯仰/扭转/侧倾 */
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
  }>;
  activeCameraId?: string;
  /** 每个机位独立的快照,key 是 cameraId. 替代旧的单 lastCapture. */
  lastCaptures?: Record<string, {
    image: string;
    depth?: string;
    pose?: string;
    normal?: string;
    timestamp: number;
  }>;
  /** 兼容老节点 —— 早期只有单 capture. */
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
  const title = data.customTitle || (language === 'zh' ? '导演台' : 'Director Stage');

  // 兼容老数据:如果有 lastCapture 但没 lastCaptures,把它合并成单条 map.
  const cameras = data.cameras ?? [];
  const captures = data.lastCaptures
    ?? (data.lastCapture ? { [data.lastCapture.cameraId]: data.lastCapture } : {});
  const captureEntries = cameras
    .map((cam) => ({ cam, capture: captures[cam.id] }))
    .filter((row): row is { cam: typeof row.cam; capture: NonNullable<typeof row.capture> } => !!row.capture);
  const hasAnyCapture = captureEntries.length > 0;
  const status = data.status ?? (hasAnyCapture ? 'done' : 'idle');

  const handleOpen = () => openDirectorStage(id);

  return (
    <div className="group w-[300px]">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-neutral-200">
        <Pencil className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <div className="min-w-0 font-medium tracking-wide">{title}</div>
        {hasAnyCapture ? (
          <span className="ml-auto rounded bg-white/[0.04] px-1.5 py-px text-[9px] text-white/50">
            {captureEntries.length} {language === 'zh' ? '机位' : 'cams'}
          </span>
        ) : null}
      </div>

      <div
        className={clsx(
          'relative overflow-hidden rounded-[20px] bg-[rgba(24,24,27,0.98)] transition-shadow',
          selected ? 'shadow-[0_0_0_1px_rgb(255,255,255)]' : '',
        )}
      >
        {/* 整张卡片当作 target 命中区. */}
        <Handle
          type="target"
          position={Position.Left}
          className="!left-0 !top-0 !h-full !w-full !cursor-default !rounded-[20px] !border-0 !bg-transparent !opacity-0"
          style={{ transform: 'none', pointerEvents: isConnectionDragging ? 'auto' : 'none' }}
        />
        {/* 左侧 + 泡泡 —— 显式的 target 端口. */}
        <Handle
          type="target"
          position={Position.Left}
          id="dir-target-left"
          className={clsx(
            '!h-6 !w-6 !-left-8 !rounded-full !border-0 !bg-transparent opacity-0 transition-opacity group-hover:opacity-100',
            selected && '!opacity-100',
          )}
          style={{ transform: 'translate(0, -50%)' }}
        >
          <div className="pointer-events-none flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-[#1a1d22]/90 backdrop-blur-md">
            <Plus className="h-3 w-3 text-neutral-300" />
          </div>
        </Handle>

        {hasAnyCapture ? (
          // 「已构图」态:列出所有有快照的机位,每个机位**独立 source handle**.
          <div className="flex flex-col">
            <div className="grid gap-1 p-2" style={{ gridTemplateColumns: captureEntries.length === 1 ? '1fr' : 'repeat(2, 1fr)' }}>
              {captureEntries.map(({ cam, capture }) => (
                <CameraCaptureCard
                  key={cam.id}
                  cameraId={cam.id}
                  label={cam.label}
                  imageUrl={capture.image}
                  selected={selected}
                />
              ))}
            </div>
            <div className="flex items-center justify-between px-3 py-2.5 border-t border-white/[0.04]">
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
          // 「未构图」空态.
          <>
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
            {/* 未构图时右侧给一个通用 source handle,接 lastCapture 单图(老兼容). */}
            <Handle
              type="source"
              position={Position.Right}
              className={clsx(
                '!h-6 !w-6 !-right-8 !rounded-full !border-0 !bg-transparent opacity-0 transition-opacity group-hover:opacity-100',
                selected && '!opacity-100',
              )}
              style={{ transform: 'translate(0, -50%)' }}
            >
              <div className="pointer-events-none flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-[#1a1d22]/90 backdrop-blur-md">
                <Plus className="h-3 w-3 text-neutral-300" />
              </div>
            </Handle>
          </>
        )}
      </div>
    </div>
  );
}

/** 每个机位一张卡片,带自己的 source handle (id = `cam-<cameraId>`),
 *  下游 imageNode 可以从这条线连出去,引用这个机位的快照. */
function CameraCaptureCard({ cameraId, label, imageUrl, selected }: {
  cameraId: string;
  label: string;
  imageUrl: string;
  selected: boolean | undefined;
}) {
  return (
    <div className="relative overflow-hidden rounded-md bg-black">
      <div className="aspect-[16/9] w-full">
        <img
          src={imageUrl}
          alt={`camera ${label} capture`}
          className="h-full w-full object-cover"
        />
      </div>
      <div className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-white/90 backdrop-blur-sm">
        <VideoIcon className="h-2.5 w-2.5 text-violet-300" />
        {label}
      </div>
      {/* 每个机位独立的右侧 source handle —— 一定要给 id 才能区分. */}
      <Handle
        type="source"
        position={Position.Right}
        id={`cam-${cameraId}`}
        className={clsx(
          '!h-3 !w-3 !-right-1.5 !top-1/2 !rounded-full !border-2 !border-[#0a0a0a] !bg-violet-400 opacity-60 transition-opacity group-hover:opacity-100',
          selected && '!opacity-100',
        )}
        style={{ transform: 'translateY(-50%)' }}
        title={`Output: ${label}`}
      />
    </div>
  );
}
