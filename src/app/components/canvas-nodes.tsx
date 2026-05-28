import { useEffect, useRef, useState } from "react";
import {
  Type,
  Image as ImageIcon,
  Film,
  AudioLines,
  Globe2,
  Play,
  Pause,
  Sparkles,
  Loader2,
  Check,
  MoreHorizontal,
  Download,
} from "lucide-react";
import { ImageWithFallback } from "./figma/ImageWithFallback";

export type NodeType = "text" | "image" | "video" | "audio" | "pano360";
export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

export interface CanvasNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  title: string;
  prompt: string;
  status: NodeStatus;
  progress?: number;
  output?: {
    text?: string;
    url?: string;
    duration?: string;
    size?: string;
  };
  author?: { name: string; color: string };
}

const TYPE_META: Record<NodeType, { label: string; icon: typeof Type; accent: string }> = {
  text: { label: "TEXT", icon: Type, accent: "text-cyan-300" },
  image: { label: "IMAGE", icon: ImageIcon, accent: "text-teal-300" },
  video: { label: "VIDEO", icon: Film, accent: "text-sky-300" },
  audio: { label: "AUDIO", icon: AudioLines, accent: "text-emerald-300" },
  pano360: { label: "360° PANO", icon: Globe2, accent: "text-indigo-300" },
};

function StatusPill({ status, progress }: { status: NodeStatus; progress?: number }) {
  if (status === "done")
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
        <Check className="w-3 h-3" /> Done
      </span>
    );
  if (status === "running")
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
        <Loader2 className="w-3 h-3 animate-spin" />
        {progress != null ? `${progress}%` : "Running"}
      </span>
    );
  if (status === "queued")
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
        <Loader2 className="w-3 h-3 animate-spin" /> Queued
      </span>
    );
  if (status === "error")
    return (
      <span className="px-1.5 py-0.5 rounded-full bg-rose-500/10 text-rose-300 border border-rose-500/20">
        Error
      </span>
    );
  return (
    <span className="px-1.5 py-0.5 rounded-full bg-neutral-700/40 text-neutral-400 border border-neutral-700/60">
      Idle
    </span>
  );
}

function NodeShell({
  node,
  children,
  onPointerDown,
  selected,
}: {
  node: CanvasNode;
  children: React.ReactNode;
  onPointerDown: (e: React.PointerEvent) => void;
  selected: boolean;
}) {
  const meta = TYPE_META[node.type];
  const Icon = meta.icon;
  return (
    <div
      onPointerDown={onPointerDown}
      className={[
        "absolute w-[300px] select-none rounded-xl overflow-hidden",
        "bg-[rgba(18,22,26,0.72)] backdrop-blur-xl",
        "border transition-shadow",
        selected
          ? "border-cyan-400/40 shadow-[0_0_0_1px_rgba(34,211,238,0.25),0_20px_60px_-20px_rgba(34,211,238,0.35)]"
          : "border-white/[0.06] shadow-[0_20px_50px_-25px_rgba(0,0,0,0.9)]",
      ].join(" ")}
      style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
            <Icon className={`w-3 h-3 ${meta.accent}`} />
          </div>
          <span className={`tracking-[0.18em] ${meta.accent}`} style={{ fontSize: 10 }}>
            {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-2" style={{ fontSize: 10 }}>
          <StatusPill status={node.status} progress={node.progress} />
          <button className="text-neutral-500 hover:text-neutral-200 transition">
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {children}
      <div className="flex items-center justify-between px-3 py-2 border-t border-white/[0.05] text-neutral-500" style={{ fontSize: 10 }}>
        <div className="flex items-center gap-1.5">
          {node.author && (
            <>
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: node.author.color }}
              />
              <span>{node.author.name}</span>
            </>
          )}
        </div>
        <span className="tracking-wider uppercase">#{node.id.slice(0, 6)}</span>
      </div>
    </div>
  );
}

function PromptBlock({ prompt }: { prompt: string }) {
  return (
    <div className="px-3 py-2 border-b border-white/[0.05]">
      <div className="flex items-center gap-1 text-neutral-500 tracking-widest mb-1" style={{ fontSize: 9 }}>
        <Sparkles className="w-2.5 h-2.5" /> PROMPT
      </div>
      <p className="text-neutral-300 leading-relaxed" style={{ fontSize: 12 }}>
        {prompt}
      </p>
    </div>
  );
}

function TextBody({ node }: { node: CanvasNode }) {
  const [shown, setShown] = useState("");
  const full = node.output?.text ?? "";
  useEffect(() => {
    if (node.status !== "done") return;
    setShown("");
    let i = 0;
    const t = setInterval(() => {
      i += 2;
      setShown(full.slice(0, i));
      if (i >= full.length) clearInterval(t);
    }, 18);
    return () => clearInterval(t);
  }, [full, node.status]);
  return (
    <>
      <PromptBlock prompt={node.prompt} />
      <div className="px-3 py-3">
        <p className="text-neutral-200 leading-relaxed" style={{ fontSize: 12 }}>
          {shown}
          {shown.length < full.length && (
            <span className="inline-block w-1.5 h-3 ml-0.5 bg-cyan-300/80 align-middle animate-pulse" />
          )}
        </p>
      </div>
    </>
  );
}

function ImageBody({ node }: { node: CanvasNode }) {
  return (
    <>
      <PromptBlock prompt={node.prompt} />
      <div className="px-3 py-3">
        <div className="relative rounded-md overflow-hidden border border-white/[0.06] aspect-[4/3] bg-neutral-900/60">
          {node.status === "running" || node.status === "queued" ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-5 h-5 text-cyan-300 animate-spin" />
            </div>
          ) : node.output?.url ? (
            <ImageWithFallback
              src={node.output.url}
              alt={node.prompt}
              className="w-full h-full object-cover"
            />
          ) : null}
        </div>
        <div className="flex items-center justify-between mt-2 text-neutral-500" style={{ fontSize: 10 }}>
          <span>{node.output?.size ?? "1024 × 768"}</span>
          <button className="flex items-center gap-1 hover:text-neutral-200 transition">
            <Download className="w-3 h-3" /> Save
          </button>
        </div>
      </div>
    </>
  );
}

function VideoBody({ node }: { node: CanvasNode }) {
  return (
    <>
      <PromptBlock prompt={node.prompt} />
      <div className="px-3 py-3">
        <div className="relative rounded-md overflow-hidden border border-white/[0.06] aspect-video bg-black">
          {node.output?.url && (
            <ImageWithFallback
              src={node.output.url}
              alt={node.prompt}
              className="w-full h-full object-cover opacity-90"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
          {node.status === "queued" || node.status === "running" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-5 h-5 text-sky-300 animate-spin" />
              <div className="w-2/3 h-0.5 bg-white/10 rounded overflow-hidden">
                <div
                  className="h-full bg-sky-400/80 transition-all"
                  style={{ width: `${node.progress ?? 0}%` }}
                />
              </div>
              <span className="text-neutral-400 tracking-wider" style={{ fontSize: 10 }}>
                RENDERING · ETA 2:14
              </span>
            </div>
          ) : node.status === "done" ? (
            <button className="absolute inset-0 flex items-center justify-center">
              <div className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center">
                <Play className="w-4 h-4 text-white fill-white ml-0.5" />
              </div>
            </button>
          ) : null}
          <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-white/70" style={{ fontSize: 10 }}>
            <span>{node.output?.duration ?? "00:00"}</span>
            <span>1080p · 24fps</span>
          </div>
        </div>
      </div>
    </>
  );
}

function AudioBody({ node }: { node: CanvasNode }) {
  const [playing, setPlaying] = useState(false);
  return (
    <>
      <PromptBlock prompt={node.prompt} />
      <div className="px-3 py-3">
        <div className="rounded-md border border-white/[0.06] bg-neutral-900/60 p-2.5">
          <div className="flex items-end gap-[2px] h-10 mb-2">
            {Array.from({ length: 42 }).map((_, i) => {
              const h = 20 + Math.abs(Math.sin(i * 0.6) * 80);
              return (
                <div
                  key={i}
                  className="flex-1 rounded-sm bg-emerald-400/70"
                  style={{
                    height: `${h}%`,
                    opacity: node.status === "done" ? 0.4 + (i / 42) * 0.6 : 0.25,
                  }}
                />
              );
            })}
          </div>
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPlaying(p => !p)}
              className="w-7 h-7 rounded-full bg-emerald-500/15 border border-emerald-400/30 flex items-center justify-center text-emerald-300 hover:bg-emerald-500/25 transition"
            >
              {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 ml-0.5" />}
            </button>
            <span className="text-neutral-500" style={{ fontSize: 10 }}>
              {node.output?.duration ?? "0:00"} · 48kHz · Stereo
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function PanoBody({ node }: { node: CanvasNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (node.status !== "done") return;
    let raf = 0;
    const tick = () => {
      setOffset(o => (o + 0.15) % 100);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [node.status]);
  return (
    <>
      <PromptBlock prompt={node.prompt} />
      <div className="px-3 py-3">
        <div
          ref={ref}
          className="relative rounded-md overflow-hidden border border-white/[0.06] aspect-[2/1] bg-black"
        >
          {node.output?.url && (
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url(${node.output.url})`,
                backgroundSize: "200% 100%",
                backgroundPositionX: `${offset}%`,
              }}
            />
          )}
          <div className="absolute inset-0 ring-1 ring-inset ring-white/[0.04]" />
          <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-white/70" style={{ fontSize: 10 }}>
            <span className="flex items-center gap-1">
              <Globe2 className="w-3 h-3" /> Equirectangular
            </span>
            <span>4096 × 2048</span>
          </div>
        </div>
      </div>
    </>
  );
}

const BODY_MAP: Record<NodeType, (p: { node: CanvasNode }) => React.JSX.Element> = {
  text: TextBody,
  image: ImageBody,
  video: VideoBody,
  audio: AudioBody,
  pano360: PanoBody,
};

export function NodeCard({
  node,
  selected,
  onPointerDown,
}: {
  node: CanvasNode;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const Body = BODY_MAP[node.type];
  return (
    <NodeShell node={node} onPointerDown={onPointerDown} selected={selected}>
      <Body node={node} />
    </NodeShell>
  );
}
