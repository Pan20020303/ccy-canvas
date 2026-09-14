import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { FileText, Image as ImageIcon, Music2, Video } from "lucide-react";

import { useStore } from "../../store";
import { toRenderableMediaUrl } from "../../reference-media";
import {
  scheduleAgentCanvasActivityHide,
  useAgentCanvasActivityStore,
} from "./agent-canvas-activity";

type Point = { x: number; y: number };

const BUSY_STATUSES = new Set(["running", "generating", "uploading", "queued", "pending", "persisting"]);

function readString(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function ThinkingDots() {
  return (
    <span className="grid grid-cols-3 gap-[2px]" aria-hidden>
      {Array.from({ length: 9 }, (_, index) => (
        <span
          key={index}
          className="h-[2px] w-[2px] rounded-full bg-white/70 animate-pulse"
          style={{ animationDelay: `${index * 70}ms` }}
        />
      ))}
    </span>
  );
}

function PreviewSkeleton({ entity }: { entity: string }) {
  const Icon = entity === "video" ? Video : entity === "audio" ? Music2 : entity === "text" ? FileText : ImageIcon;
  return (
    <div className="relative flex h-full min-h-36 items-center justify-center overflow-hidden bg-[#202126] text-white/30">
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.8s_infinite] bg-gradient-to-r from-transparent via-white/[0.055] to-transparent" />
      <Icon className="h-7 w-7" strokeWidth={1.4} />
    </div>
  );
}

export function AgentCanvasActivityOverlay({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const activity = useAgentCanvasActivityStore();
  const language = useStore((state) => state.language);
  const targetNode = useStore((state) => state.nodes.find((node) => node.id === activity.nodeId));
  const [position, setPosition] = useState<Point | null>(null);
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const zh = language === "zh";

  const nodeData = (targetNode?.data ?? {}) as Record<string, unknown>;
  const status = typeof nodeData.status === "string" ? nodeData.status : "";
  const busy = BUSY_STATUSES.has(status);
  const mediaUrl = useMemo(() => {
    const raw = readString(nodeData, ["url", "output", "imageUrl", "videoUrl", "resultUrl", "src"]);
    return raw ? toRenderableMediaUrl(raw, { thumbWidth: 640 }) : "";
  }, [nodeData]);
  const posterUrl = useMemo(() => {
    const raw = readString(nodeData, ["poster", "thumbnail", "thumbnailUrl", "coverUrl"]);
    return raw ? toRenderableMediaUrl(raw, { thumbWidth: 640 }) : "";
  }, [nodeData]);
  const textPreview = readString(nodeData, ["content", "output", "promptDraft", "prompt"]);

  useEffect(() => {
    if (!activity.finished || !activity.runId) return;
    if (activity.nodeId && busy) return;
    return scheduleAgentCanvasActivityHide(activity.runId, 900);
  }, [activity.finished, activity.nodeId, activity.runId, busy]);

  useEffect(() => {
    if (activity.phase === "hidden" || position) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cardWidth = activity.phase === "acting" ? 236 : 108;
    setPosition({
      x: Math.max(24, Math.min(rect.width - cardWidth - 24, rect.width * 0.68)),
      y: Math.max(82, Math.min(rect.height - 220, rect.height * 0.25)),
    });
  }, [activity.phase, containerRef, position]);

  if (activity.phase === "hidden" || !position) return null;

  const clampPosition = (next: Point): Point => {
    const container = containerRef.current?.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (!container) return next;
    return {
      x: Math.max(8, Math.min(container.width - (card?.width ?? 108) - 8, next.x)),
      y: Math.max(8, Math.min(container.height - (card?.height ?? 40) - 8, next.y)),
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      dx: event.clientX - rect.left - position.x,
      dy: event.clientY - rect.top - position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(clampPosition({
      x: event.clientX - rect.left - dragRef.current.dx,
      y: event.clientY - rect.top - dragRef.current.dy,
    }));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
  };

  if (activity.phase === "thinking") {
    return (
      <div
        ref={cardRef}
        role="status"
        aria-label={zh ? "智能体思考中" : "Agent thinking"}
        className="nodrag nopan nowheel absolute z-40 cursor-grab select-none rounded-xl border border-white/10 bg-black px-3 py-2 text-white shadow-[0_10px_32px_rgba(0,0,0,0.38)] active:cursor-grabbing"
        style={{ left: position.x, top: position.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="flex items-center gap-2 text-[12px] font-medium">
          <ThinkingDots />
          <span>{zh ? "思考中" : "Thinking"}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      role="status"
      aria-label={activity.title}
      className="nodrag nopan nowheel absolute z-40 w-[236px] select-none overflow-hidden rounded-2xl border border-white/10 bg-[#15161a] p-2 shadow-[0_18px_54px_rgba(0,0,0,0.42)] transition-[width,height] duration-200"
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="mb-2 inline-flex cursor-grab items-center gap-2 rounded-xl bg-black px-3 py-2 text-[12px] font-medium text-white active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <ThinkingDots />
        <span>{activity.title}</span>
      </div>

      <div className="aspect-[4/3] overflow-hidden rounded-xl border border-white/[0.07] bg-[#202126]">
        {activity.entity === "image" && mediaUrl ? (
          <img src={mediaUrl} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : activity.entity === "video" && mediaUrl ? (
          <video src={mediaUrl} poster={posterUrl || undefined} className="h-full w-full object-cover" muted autoPlay loop playsInline />
        ) : activity.entity === "text" && textPreview ? (
          <div className="h-full overflow-hidden p-4 text-[12px] leading-5 text-white/75">
            {textPreview.slice(0, 280)}
          </div>
        ) : activity.entity === "audio" && mediaUrl ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-white/55">
            <Music2 className="h-8 w-8" strokeWidth={1.4} />
            <audio src={mediaUrl} controls className="h-8 w-full" />
          </div>
        ) : (
          <PreviewSkeleton entity={activity.entity} />
        )}
      </div>
      {activity.detail ? (
        <div className="truncate px-1 pt-2 text-[10px] text-white/35">{activity.detail}</div>
      ) : null}
    </div>
  );
}
