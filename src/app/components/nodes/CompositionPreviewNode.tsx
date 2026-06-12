import { Handle, NodeProps, Position } from '@xyflow/react';
import { Image as ImageIcon, Plus, Video as VideoIcon } from 'lucide-react';
import clsx from 'clsx';

import { useStore } from '../../store';

/**
 * 构图预览节点 (compositionPreviewNode) —— 导演台「确认构图」后,每个机位
 * 各自生成一个此类节点,挂在画布上、连线指向下游 imageNode / videoNode 等
 * 生成节点。
 *
 * 设计与 neowow 的"构图预览"卡片对齐:
 *   - 头部:📷 构图预览 + 机位 label
 *   - 主体:对应机位的快照(就是 overlay 里逐机位渲染出的 PNG)
 *   - 左右 + 泡泡 handle:跟其他节点一样 hover 才浮出
 *
 * 不依赖 WebGL —— 它就是一张图片节点,只是 data 里多一份"来自哪个导演台 +
 * 哪个机位"的来源信息,后续如果要重新生成可以反向打开父导演台。
 */

export type CompositionPreviewData = {
  /** 父 directorStageNode 的 id */
  directorNodeId: string;
  /** 哪个机位 */
  cameraId: string;
  /** 显示用 */
  cameraLabel: string;
  /** 实际的快照(dataURL 或 http URL) */
  image: string;
  /** 可选 ControlNet condition 图(P7 用) */
  depth?: string;
  normal?: string;
  pose?: string;
  /** 创建时间戳,便于排序 / 缓存失效 */
  timestamp: number;
  /** 画幅,跟父 camera.aspect 同步,用来约束卡片比例 */
  aspect?: '16:9' | '9:16' | '1:1' | '4:3' | '21:9';
};

const ASPECT_TO_TAILWIND: Record<NonNullable<CompositionPreviewData['aspect']>, string> = {
  '16:9': 'aspect-[16/9]',
  '9:16': 'aspect-[9/16]',
  '1:1':  'aspect-square',
  '4:3':  'aspect-[4/3]',
  '21:9': 'aspect-[21/9]',
};

export function CompositionPreviewNode({ data: rawData, selected }: NodeProps) {
  const data = (rawData ?? {}) as CompositionPreviewData;
  const language = useStore((s) => s.language);
  const isConnectionDragging = useStore((s) => s.isConnectionDragging);
  const openDirectorStage = useStore((s) => s.openDirectorStage);

  const aspectClass = ASPECT_TO_TAILWIND[data.aspect ?? '16:9'];
  const hasImage = !!data.image;

  const onEditParent = () => {
    if (data.directorNodeId) openDirectorStage(data.directorNodeId);
  };

  return (
    <div className="group w-[300px]">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-neutral-200">
        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        <div className="min-w-0 font-medium tracking-wide">
          {language === 'zh' ? '构图预览' : 'Composition'}
        </div>
        <span className="ml-auto inline-flex items-center gap-1 rounded bg-white/[0.04] px-1.5 py-px text-[9px] text-violet-200">
          <VideoIcon className="h-2.5 w-2.5" />
          {data.cameraLabel}
        </span>
      </div>

      <div
        className={clsx(
          'relative overflow-hidden rounded-[20px] bg-[rgba(24,24,27,0.98)] transition-shadow',
          selected ? 'shadow-[0_0_0_1px_rgb(255,255,255)]' : '',
        )}
      >
        {/* 全卡 target 命中区 —— 与其他节点一致 */}
        <Handle
          type="target"
          position={Position.Left}
          className="!left-0 !top-0 !h-full !w-full !cursor-default !rounded-[20px] !border-0 !bg-transparent !opacity-0"
          style={{ transform: 'none', pointerEvents: isConnectionDragging ? 'auto' : 'none' }}
        />

        {/* 左 + 泡泡(显式 target 端口) */}
        <Handle
          type="target"
          position={Position.Left}
          id="comp-target-left"
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

        {/* 主体:快照图 */}
        <div className={clsx('w-full bg-black', aspectClass)}>
          {hasImage ? (
            <img
              src={data.image}
              alt={`composition from ${data.cameraLabel}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-white/40">
              {language === 'zh' ? '(无预览)' : '(no preview)'}
            </div>
          )}
        </div>

        {/* 底部 meta + 跳回父导演台 */}
        <div className="flex items-center justify-between border-t border-white/[0.04] px-3 py-2 text-[11px] text-white/60">
          <span className="font-mono text-[10px] text-white/40">
            {new Date(data.timestamp || 0).toLocaleTimeString()}
          </span>
          {data.directorNodeId ? (
            <button
              type="button"
              onClick={onEditParent}
              className="rounded border border-white/12 bg-white/[0.04] px-2 py-0.5 text-[10.5px] text-white/70 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white"
              title={language === 'zh' ? '回到父导演台编辑' : 'Edit parent stage'}
            >
              {language === 'zh' ? '回到导演台' : 'Edit stage'}
            </button>
          ) : null}
        </div>

        {/* 右 + 泡泡(source 端口) */}
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
      </div>
    </div>
  );
}
