import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, CheckCircle2, ImageOff } from 'lucide-react';
import clsx from 'clsx';

import { toRenderableMediaUrl } from '../../reference-media';
import { useStore, type NodeVersion } from '../../store';

/**
 * 节点版本历史 —— 两个组件:
 *
 * NodeVersionsBadge: 节点右上角的「N 个 ▾」小徽章. 当节点有 1+ 历史
 * 版本(versions[].length > 0)时浮出. 点击展开 NodeVersionsModal.
 *
 * NodeVersionsModal: 全屏遮罩 + 横向画廊,把"当前主图"和所有 versions
 * 并排展示. 用户点其中任意一张 →「设为主图」,store 会把现主图压回
 * versions 顶端、那张提升为新主图(原子的 setActiveVersion action).
 */

export type NodeMediaKind = 'image' | 'video';

export function NodeVersionsBadge({
  nodeId,
  activeUrl,
  activePrompt,
  activeModel,
  versions,
  mediaKind,
}: {
  nodeId: string;
  activeUrl: string;
  activePrompt?: string;
  activeModel?: string;
  versions: NodeVersion[];
  mediaKind: NodeMediaKind;
}) {
  const [open, setOpen] = useState(false);
  // 主图 + history 一共多少个
  const total = (activeUrl ? 1 : 0) + versions.length;
  if (total <= 1) return null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="pointer-events-auto absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-white/14 bg-black/72 px-2 py-1 text-[10.5px] font-medium text-white/90 shadow-md backdrop-blur-md transition hover:border-white/30 hover:bg-black/88"
        title="切换历史版本"
      >
        <span>{total}个</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <NodeVersionsModal
          nodeId={nodeId}
          activeUrl={activeUrl}
          activePrompt={activePrompt}
          activeModel={activeModel}
          versions={versions}
          mediaKind={mediaKind}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function NodeVersionsModal({
  nodeId, activeUrl, activePrompt, activeModel, versions, mediaKind, onClose,
}: {
  nodeId: string;
  activeUrl: string;
  activePrompt?: string;
  activeModel?: string;
  versions: NodeVersion[];
  mediaKind: NodeMediaKind;
  onClose: () => void;
}) {
  const setActiveVersion = useStore((s) => s.setActiveVersion);

  // 排版顺序:主图 在最前,后面跟 versions 时间倒序(versions[] 已经倒序).
  const allCards: Array<{ id: string | null; url: string; prompt?: string; model?: string; timestamp?: number; isActive: boolean }> = [
    { id: null, url: activeUrl, prompt: activePrompt, model: activeModel, timestamp: undefined, isActive: true },
    ...versions.map((v) => ({
      id: v.id,
      url: v.url,
      prompt: v.prompt,
      model: v.model,
      timestamp: v.timestamp,
      isActive: false,
    })),
  ];

  const onPickVersion = (versionId: string | null) => {
    if (!versionId) {
      onClose();
      return;
    }
    setActiveVersion(nodeId, versionId);
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex flex-col bg-black/85 backdrop-blur-md"
      onClick={onClose}
    >
      {/* 顶部条 */}
      <div
        className="flex items-center justify-between border-b border-white/10 px-5 py-3 text-[12px] text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <span className="font-medium text-white">历史版本</span>
          <span className="text-white/40">·</span>
          <span className="text-white/55">共 {allCards.length} 个</span>
          <span className="text-white/40">·</span>
          <span className="text-white/55">点击任意一张设为主图</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition hover:bg-white/[0.06] hover:text-white"
          title="关闭 (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 画廊:横向排版 */}
      <div
        className="flex-1 overflow-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-center gap-5">
          {allCards.map((card, idx) => (
            <VersionCard
              key={card.id ?? 'active'}
              card={card}
              mediaKind={mediaKind}
              indexLabel={idx === 0 ? '当前' : `历史 ${idx}`}
              onClick={() => onPickVersion(card.id)}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function VersionCard({
  card, mediaKind, indexLabel, onClick,
}: {
  card: { id: string | null; url: string; prompt?: string; model?: string; timestamp?: number; isActive: boolean };
  mediaKind: NodeMediaKind;
  indexLabel: string;
  onClick: () => void;
}) {
  const time = card.timestamp ? new Date(card.timestamp).toLocaleString() : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'group relative flex flex-col items-stretch overflow-hidden rounded-xl border bg-[#15181d] text-left transition',
        card.isActive ? 'border-emerald-400/55 ring-2 ring-emerald-400/35' : 'border-white/12 hover:border-violet-300/55 hover:ring-2 hover:ring-violet-300/30',
      )}
      style={{ width: 380 }}
    >
      <div className="relative aspect-[16/9] w-full bg-black">
        {card.url ? (
          mediaKind === 'video' ? (
            <video
              src={toRenderableMediaUrl(card.url)}
              className="absolute inset-0 h-full w-full object-cover"
              muted
              playsInline
              preload="metadata"
              onMouseEnter={(e) => { e.currentTarget.play().catch(() => {}); }}
              onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
            />
          ) : (
            <img
              src={toRenderableMediaUrl(card.url, { thumbWidth: 720 })}
              alt={indexLabel}
              className="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
            />
          )
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/40">
            <ImageOff className="h-6 w-6" />
          </div>
        )}
        {card.isActive ? (
          <span className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-emerald-500/85 px-1.5 py-0.5 text-[10.5px] font-semibold text-white shadow">
            <CheckCircle2 className="h-3 w-3" />
            主图
          </span>
        ) : (
          <span className="absolute left-2 top-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[10.5px] font-medium text-white/80 backdrop-blur-sm">
            {indexLabel}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 px-3 py-2.5 text-[11.5px] text-white/70">
        {card.prompt ? (
          <div className="line-clamp-2 text-white/90">{card.prompt}</div>
        ) : (
          <div className="italic text-white/35">(无 prompt)</div>
        )}
        <div className="flex items-center gap-2 text-[10.5px] text-white/45">
          {card.model ? <span className="font-mono">{card.model}</span> : null}
          {card.model && time ? <span>·</span> : null}
          {time ? <span>{time}</span> : null}
        </div>
        {!card.isActive ? (
          <span className="mt-0.5 text-[10.5px] text-violet-300 opacity-0 transition-opacity group-hover:opacity-100">
            点击设为主图 →
          </span>
        ) : null}
      </div>
    </button>
  );
}
