import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import gsap from 'gsap';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Handle, Position, useReactFlow, useViewport } from '@xyflow/react';
import {
  Type,
  Image as ImageIcon,
  ImageOff,
  Video,
  Music,
  Globe,
  ChevronDown,
  ArrowUp,
  Loader2,
  Zap,
  Download,
  LayoutTemplate,
  Sparkles,
  Scissors,
  Crop,
  FileText,
  Plus,
  X,
  Expand,
  Play,
  Pause,
  Camera,
  Heading1,
  Heading2,
  Heading3,
  Pilcrow,
  Bold,
  Italic,
  List,
  ListOrdered,
  Minus,
  Copy as CopyIcon,
  Highlighter,
  RotateCcw,
  Palette,
  MoveDiagonal2,
  ArrowLeft,
  Brush,
  Undo2,
  Redo2,
  ArrowRightLeft,
  Mic,
  ShieldCheck,
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../../store';
import Magnet from '../Magnet';
import { resolveApiUrl } from '../../api/client';
import { toRenderableMediaUrl, extractOriginalMediaUrl } from '../../reference-media';
import { AssetPickerModal, type PickedAsset } from '../AssetPickerModal';
import type { AppProviderConfig } from '../../api/providerConfigs';
import type { ServiceType } from '../../model-config';
import { getModelTemplate, type ModelTemplate } from '../../model-templates';
import {
  REFERENCE_MODE_SPECS,
  modesForModel,
  isModeSatisfied,
  firstSatisfiedMode,
  happyHorseSuffixSatisfied,
  type ReferenceModeKey,
} from '../../reference-modes';
import { ModelBrandIcon } from '../ModelBrandIcon';
import {
  canUseReversePrompt,
  filterReversePromptModels,
  getFirstUpstreamReferenceImage,
  getTextNodeMode,
  splitFilenameExtension,
} from '../../text-node-modes';
import { getGenerationProgressPercent } from './loading-progress';
import { PrecisionStudio } from './PrecisionStudio';
import {
  ANGLE_STUDIO_PRESETS,
  LIGHT_RIG_PRESETS,
  aziTo360,
  aziToWord,
  defaultLightRig,
  eleToWord,
  type StudioLight,
} from './precision-studio-data';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

// downloadAsset fetches media through the backend proxy (which can read our
// own — possibly private — COS bucket) into a Blob, then saves it with a real
// filename. Going through fetch+Blob avoids the cross-origin `<a download>`
// problem where the browser ignores the filename and a failed request gets
// saved as "proxy-media.txt". `src` may be a raw URL or one that is already
// proxy-wrapped (legacy persisted data) — toRenderableMediaUrl collapses both
// to exactly one proxy layer, so the request can never double-wrap (which the
// backend would reject with 401→502).
async function downloadAsset(src: string, filename: string) {
  if (!src) return;
  const proxied = toRenderableMediaUrl(src);
  if (!proxied) return;
  try {
    const res = await fetch(proxied, { credentials: 'include' });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
  } catch (err) {
    // No silent <a download> fallback: navigating to the proxy URL on failure
    // just saved a mis-named "proxy-media.txt" error page. Tell the user instead.
    // eslint-disable-next-line no-console
    console.error('[downloadAsset] failed', err);
    toast.error('下载失败，请稍后重试');
  }
}

// ─── Node Loading Overlay (water-fill + timer) ─────────────────────────────

/** 单层波峰 — 宽 200% 的双拼波形沿 X 轴循环平移（从左往右涌）。两层不同
 *  速度叠加出视差，就有了"物理感"。波形首尾斜率一致，平移半宽无缝循环。 */
function WaterWave({ fill, height, duration, phaseShift = false }: {
  fill: string;
  height: number;
  duration: number;
  /** 错开半个波长，两层波峰不同步。 */
  phaseShift?: boolean;
}) {
  const wave = (
    <svg className="h-full w-1/2 shrink-0" viewBox="0 0 600 40" preserveAspectRatio="none" aria-hidden>
      <path d="M0 22 Q 75 8, 150 22 T 300 22 T 450 22 T 600 22 L 600 40 L 0 40 Z" fill={fill} />
    </svg>
  );
  return (
    <div className="absolute inset-x-0 top-0" style={{ height, transform: `translateY(-${height - 2}px)` }}>
      <div
        className="flex h-full w-[200%]"
        style={{
          animation: `ccy-water-drift ${duration}s linear infinite`,
          marginLeft: phaseShift ? '-25%' : undefined,
        }}
      >
        {wave}
        {wave}
      </div>
    </div>
  );
}

/** 统一的生成中覆盖层 — 图片 / 视频 / 音频 / 全景共用（消除两套动画）。
 *  - 水面从底部随（伪）进度上涨，双层石墨色波峰从左向右涌动并整体浮沉；
 *  - 中央阶段徽章：发起任务 → 排队中 → 生成中 → 生成完成·返回中，
 *    文案由 store 写入的 data.taskPhase（真实后端任务状态）驱动；
 *  - 右上角石墨灰 mm:ss 计时（persisted runningStartedAt，刷新不清零）；
 *  - 取消只在「排队中」提供 — 任务一旦开始执行就不可取消。 */
function GenerationOverlay({ nodeId }: { nodeId: string }) {
  const language = useStore((state) => state.language);
  const light = useStore((state) => state.theme) === 'light';
  const cancelNode = useStore((state) => state.cancelNode);
  const startedAt = useStore((state) => {
    const node = state.nodes.find((n) => n.id === nodeId);
    const v = (node?.data as { runningStartedAt?: number } | undefined)?.runningStartedAt;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  });
  const taskPhase = useStore((state) => {
    const node = state.nodes.find((n) => n.id === nodeId);
    return (node?.data as { taskPhase?: string } | undefined)?.taskPhase;
  });
  const hasTaskId = useStore((state) => {
    const node = state.nodes.find((n) => n.id === nodeId);
    return Boolean((node?.data as { taskId?: string } | undefined)?.taskId);
  });
  const hasPreview = useStore((state) => {
    const node = state.nodes.find((n) => n.id === nodeId);
    const d = (node?.data ?? {}) as { url?: string; poster?: string };
    return Boolean(d.url || d.poster);
  });

  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const t0 = startedAt ?? mountedAt.current;
  const elapsedMs = Math.max(0, now - t0);
  // 水位 = 缓动伪进度（3%→95%，永不到顶；完成时整层直接消失）。
  const level = getGenerationProgressPercent(t0, now);

  const phase: 'submitting' | 'queued' | 'generating' | 'persisting' =
    taskPhase === 'queued'
      ? 'queued'
      : taskPhase === 'persisting'
        ? 'persisting'
        : !hasTaskId && elapsedMs < 2500
          ? 'submitting'
          : 'generating';
  const PHASE_TEXT: Record<typeof phase, [string, string]> = {
    submitting: ['发起任务', 'Submitting'],
    queued: ['排队中', 'Queued'],
    generating: ['生成中', 'Generating'],
    persisting: ['生成完成 · 返回中', 'Finalizing'],
  };
  const phaseText = PHASE_TEXT[phase][language === 'zh' ? 0 : 1];

  // 石墨水体配色（高级感：低饱和石墨蓝 + 银灰波峰）。
  const bodyGrad = light
    ? 'linear-gradient(180deg, rgba(148,158,172,0.30), rgba(108,118,132,0.42))'
    : 'linear-gradient(180deg, rgba(74,86,102,0.5), rgba(18,22,29,0.85))';
  const crestA = light ? 'rgba(104,116,132,0.34)' : 'rgba(152,166,186,0.30)';
  const crestB = light ? 'rgba(104,116,132,0.20)' : 'rgba(152,166,186,0.16)';

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-[12px]">
      {hasPreview ? <div className="absolute inset-0 bg-black/20 backdrop-blur-[8px]" /> : null}
      {/* 水体：随进度上涨；内层整体浮沉（底部外扩 8px，浮起时不露缝）。 */}
      <div className="absolute inset-x-0 bottom-0" style={{ height: `${level}%`, transition: 'height 1s linear' }}>
        <div className="absolute -bottom-2 left-0 right-0 top-0" style={{ animation: 'ccy-water-bob 4.2s ease-in-out infinite' }}>
          <div className="absolute inset-0" style={{ background: bodyGrad }} />
          <WaterWave fill={crestA} height={16} duration={5.5} />
          <WaterWave fill={crestB} height={24} duration={9.5} phaseShift />
        </div>
      </div>
      {/* 阶段徽章 */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-white/12 bg-[#15181d]/85 px-4 py-2 text-sm font-medium text-neutral-100 shadow-[0_14px_40px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <LoadingSpinner size={16} tone={light ? 'light' : 'dark'} />
          <span>{phaseText}</span>
          {phase === 'queued' ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                cancelNode(nodeId);
              }}
              className="rounded-full px-2 py-0.5 text-xs text-neutral-400 transition hover:bg-white/10 hover:text-rose-300"
            >
              {language === 'zh' ? '取消' : 'Cancel'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 等待计时 — 挂在节点边框外的右上方（不占画面内空间），石墨灰数字。
 *  时间源是持久化的 runningStartedAt，刷新页面不清零。 */
function GenerationTimerBadge({ nodeId }: { nodeId: string }) {
  const light = useStore((state) => state.theme) === 'light';
  const startedAt = useStore((state) => {
    const node = state.nodes.find((n) => n.id === nodeId);
    const v = (node?.data as { runningStartedAt?: number } | undefined)?.runningStartedAt;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  });
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? mountedAt.current)) / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return (
    <div
      className={clsx(
        'pointer-events-none absolute -top-5 right-0 text-[11px] font-semibold tabular-nums leading-none',
        light ? 'text-[#5b626e]' : 'text-[#8b929c] drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]',
      )}
    >
      {mm}:{ss}
    </div>
  );
}

function useNodeLoadingProgress(nodeId: string, loading: boolean) {
  const activeRun = useStore((state) => state.activeRun);
  const [now, setNow] = useState(Date.now());
  const fallbackStartedAtRef = useRef(Date.now());

  useEffect(() => {
    if (!loading) {
      fallbackStartedAtRef.current = Date.now();
      return;
    }

    fallbackStartedAtRef.current = Date.now();
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [loading, nodeId]);

  if (!loading) {
    return null;
  }

  const startedAt = activeRun?.nodeId === nodeId ? activeRun.startedAt : fallbackStartedAtRef.current;
  return getGenerationProgressPercent(startedAt, now);
}

/** Lightweight rotating ring spinner — same vibe as the Lottie reference
 *  the user linked, but with no runtime dependency. SVG so it stays crisp
 *  at any size; the .ccy-spinner-arc class in globals.css spins it. */
function LoadingSpinner({
  size = 18,
  tone = 'dark',
  className,
}: {
  size?: number;
  /** 'dark' = white-on-translucent badge bg; 'light' = neutral on white. */
  tone?: 'dark' | 'light';
  className?: string;
}) {
  const stroke = size >= 28 ? 3 : 2.4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // Quarter-circle accent arc; the rest of the dasharray = transparent track.
  const arc = c * 0.28;
  const trackColor = tone === 'light' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.18)';
  const accentColor = tone === 'light' ? 'rgba(0,0,0,0.88)' : 'rgba(255,255,255,0.95)';
  return (
    <svg
      className={clsx('ccy-spinner', className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
      <circle
        className="ccy-spinner-arc"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={accentColor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${arc} ${c - arc}`}
      />
    </svg>
  );
}

// UploadingOverlay covers a node's local preview while its file uploads,
// blurring the preview and showing a centered "上传中 (X%)" label with a gentle
// pulse. Rendered for nodes with data.status === 'uploading'.
function UploadingOverlay({ progress }: { progress?: number }) {
  const language = useStore((state) => state.language);
  const pct = typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : undefined;
  const label = language === 'zh'
    ? `上传中${pct != null ? ` (${pct}%)` : ''} …`
    : `Uploading${pct != null ? ` (${pct}%)` : ''} …`;
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 backdrop-blur-[10px]">
      <span className="animate-pulse text-[12.5px] font-medium tracking-wide text-neutral-100 drop-shadow">
        {label}
      </span>
    </div>
  );
}

// HappyHorse 快乐马家族 helpers — 把真实模型名 `happyhorse-{ver}-{suffix}`
// 拆成「版本 + 模式」两个维度，UI 上以 dropdown 暴露给用户，提交时再合成
// 真实模型名。视频编辑只在 1.0 存在。
// i2v 的产品定位是「首帧生成」——单张图作为视频首帧，而非通用图生。
// 因此模式名用「首帧」，且校验为恰好 1 张图（见 isHappyHorseSuffixSatisfied）。
const HAPPYHORSE_MODE_TO_SUFFIX: Record<string, string> = {
  '文生': 't2v',
  '首帧': 'i2v',
  '参考生': 'r2v',
  '视频编辑': 'video-edit',
};
const HAPPYHORSE_MODE_TO_SUFFIX_EN: Record<string, string> = {
  'Text-to-Video': 't2v',
  'First-frame': 'i2v',
  'Reference-to-Video': 'r2v',
  'Video-Edit': 'video-edit',
};
const HAPPYHORSE_SUFFIX_TO_MODE_ZH: Record<string, string> = {
  't2v': '文生',
  'i2v': '首帧',
  'r2v': '参考生',
  'video-edit': '视频编辑',
};
const HAPPYHORSE_SUFFIX_TO_MODE_EN: Record<string, string> = {
  't2v': 'Text-to-Video',
  'i2v': 'First-frame',
  'r2v': 'Reference-to-Video',
  'video-edit': 'Video-Edit',
};
function parseHappyHorseModel(model: string | undefined | null): { version: string; suffix: string } | null {
  if (!model) return null;
  const m = /^happyhorse-(\d+\.\d+)-(t2v|i2v|r2v|video-edit)$/.exec(model);
  if (!m) return null;
  return { version: m[1], suffix: m[2] };
}
function composeHappyHorseModel(version: string, suffix: string): string {
  return `happyhorse-${version}-${suffix}`;
}

const Dropdown = ({
  label,
  value,
  options,
  onChange,
  align = 'left',
  side = 'top',
  renderOption,
  menuMinWidth,
}: {
  label?: React.ReactNode;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  align?: 'left' | 'right';
  side?: 'top' | 'bottom';
  /** Optional custom renderer for each option row (gets the raw option + selected state). */
  renderOption?: (option: string, selected: boolean) => React.ReactNode;
  /** Override the popup min-width — model dropdown needs more room for icons + duration. */
  menuMinWidth?: number;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative nodrag">
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1.5 text-xs text-neutral-200 transition hover:bg-white/10"
      >
        {label}
        <span>{value}</span>
        <ChevronDown className="h-3 w-3 text-neutral-500" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={clsx(
              'absolute z-20 mb-1 mt-1 rounded-lg border border-white/10 bg-[#1a1d22]/95 py-1 shadow-2xl backdrop-blur-xl',
              align === 'right' ? 'right-0' : 'left-0',
              side === 'top' ? 'bottom-full' : 'top-full',
            )}
            style={{ minWidth: menuMinWidth ?? 140 }}
          >
            {options.map((option) => {
              const selected = option === value;
              return (
                <button
                  key={option}
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                  className={clsx(
                    'w-full px-3 py-1.5 text-left text-xs transition hover:bg-white/5',
                    selected ? 'text-cyan-300' : 'text-neutral-300',
                  )}
                >
                  {renderOption ? renderOption(option, selected) : option}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
};

const RatioPreview = ({ ratio }: { ratio: string }) => {
  const wide = ratio === '21:9' || ratio === '16:9';
  const tall = ratio === '9:21' || ratio === '9:16' || ratio === '1:2';
  return (
    <div
      className="rounded-sm bg-neutral-700"
      style={{
        width: wide ? 22 : tall ? 8 : 16,
        height: wide ? 10 : tall ? 22 : 16,
      }}
    />
  );
};

/** Unified media params popover: aspect ratio + resolution + duration in one panel. */
const MediaParamsPopover = ({
  template,
  resolution,
  quality,
  aspectRatio,
  duration,
  outputFormat,
  onResolution,
  onQuality,
  onAspectRatio,
  onDuration,
  onOutputFormat,
  audioSetting,
  seed,
  onAudioSetting,
  onSeed,
}: {
  template: ModelTemplate;
  resolution: string;
  quality: string;
  aspectRatio: string;
  duration: number;
  outputFormat: string;
  audioSetting?: string;
  seed?: number;
  onResolution: (v: string) => void;
  onQuality: (v: string) => void;
  onAspectRatio: (v: string) => void;
  onDuration: (v: number) => void;
  onOutputFormat: (v: string) => void;
  onAudioSetting?: (v: string) => void;
  onSeed?: (v: number | undefined) => void;
}) => {
  const [open, setOpen] = useState(false);
  const language = useStore((state) => state.language);

  const labelParts = [
    template.supportsAutoAspect && aspectRatio === 'auto' ? (language === 'zh' ? '自适应' : 'Auto') : aspectRatio,
    template.supportsResolution ? resolution : null,
    template.supportsQuality ? quality : null,
    template.supportsOutputFormat ? outputFormat : null,
    // Only show a duration chip when an actual duration control renders — the
    // provider schema may set supportsDuration for the family while a specific
    // mode (e.g. video-edit) has no range/options and doesn't send duration.
    (template.supportsDuration && (template.durationRange || template.durationOptions?.length)) ? `${duration}s` : null,
  ].filter(Boolean);

  const hasAspect = template.supportsAspectRatio && template.aspectRatioOptions?.length;
  const hasResolution = template.supportsResolution && template.resolutionOptions?.length;
  const hasQuality = template.supportsQuality && template.qualityOptions?.length;
  const hasOutputFormat = template.supportsOutputFormat && template.outputFormatOptions?.length;
  // Slider wins when the template declares a range — even if some legacy
  // schema also dumped a duration_options array in. Otherwise (range
  // absent) fall back to the explicit-options pill row.
  const hasDurationSlider = template.supportsDuration && template.durationRange;
  const hasDurationOptions = template.supportsDuration && template.durationOptions?.length && !template.durationRange;
  const hasAudioSetting = (template.audioSettingOptions?.length ?? 0) > 0 && !!onAudioSetting;
  const hasSeed = !!template.supportsSeed && !!onSeed;
  const AUDIO_LABEL: Record<string, string> = {
    auto: language === 'zh' ? '自动' : 'Auto',
    origin: language === 'zh' ? '保留原声' : 'Keep source',
    // 可灵 Kling：audio 是布尔（是否生成音效），复用 audioSetting 通道。
    off: language === 'zh' ? '无声' : 'Silent',
    on: language === 'zh' ? '生成音效' : 'With audio',
  };

  return (
    <div className="relative nodrag">
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/10"
      >
        <LayoutTemplate className="h-3 w-3 text-neutral-400" />
        <span>{labelParts.join(' · ')}</span>
        <ChevronDown className="h-3 w-3 text-neutral-500" />
      </button>
      {open ? (
        <>
          {/* Backdrop catches outside-clicks. Higher than the panel container so
              clicking anywhere outside closes us — including in adjacent nodes. */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-40 mb-3 w-[300px] overflow-hidden rounded-2xl border border-white/8 bg-[#15181d]/85 p-4 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.85)] backdrop-blur-[24px]">
            {/* ── Duration ────────────────────────────────────────────── */}
            {(hasDurationSlider || hasDurationOptions) ? (
              <div className="mb-4">
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '时长' : 'Duration'}</div>
                <div className="mb-2 text-xl font-medium tracking-tight text-white">{duration}s</div>
                {hasDurationSlider ? (
                  <>
                    <input
                      type="range"
                      min={template.durationRange!.min}
                      max={template.durationRange!.max}
                      step={template.durationRange!.step}
                      value={duration}
                      onChange={(event) => onDuration(Number(event.target.value))}
                      className="prompt-duration-slider w-full accent-white"
                    />
                    {/* Tick labels — first / last / every N in between */}
                    <div className="mt-1 flex justify-between text-[10px] text-neutral-500 tabular-nums">
                      {(() => {
                        const r = template.durationRange!;
                        const ticks: number[] = [];
                        for (let v = r.min; v <= r.max; v += r.step) ticks.push(v);
                        return ticks.map((t) => (
                          <span key={t} className={clsx(t === duration ? 'text-white' : '')}>{t}s</span>
                        ));
                      })()}
                    </div>
                  </>
                ) : null}
                {hasDurationOptions ? (
                  <div className="flex flex-wrap gap-1.5">
                    {template.durationOptions!.map((opt) => (
                      <PillButton key={opt} active={opt === duration} onClick={() => onDuration(opt)}>{opt}s</PillButton>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* ── Resolution (single row, reference UI) ────────────────── */}
            {hasResolution ? (
              <div className="mb-4">
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '分辨率' : 'Resolution'}</div>
                <div className="flex gap-1.5">
                  {template.resolutionOptions!.map((option) => (
                    <BlockButton key={option} className="min-w-0 flex-1" active={option === resolution} onClick={() => onResolution(option)}>
                      {option}
                    </BlockButton>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ── Quality (image only) ────────────────────────────────── */}
            {hasQuality ? (
              <div className="mb-4">
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '质量' : 'Quality'}</div>
                <div className="flex flex-wrap gap-1.5">
                  {template.qualityOptions!.map((option) => (
                    <PillButton key={option} active={option === quality} onClick={() => onQuality(option)}>
                      {option}
                    </PillButton>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ── Output format ──────────────────────────────────────── */}
            {hasOutputFormat ? (
              <div className="mb-4">
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '输出格式' : 'Output format'}</div>
                <div className="flex flex-wrap gap-1.5">
                  {template.outputFormatOptions!.map((option) => (
                    <PillButton key={option} active={option === outputFormat} onClick={() => onOutputFormat(option)}>
                      {option.toUpperCase()}
                    </PillButton>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ── Aspect ratio (one row of compact shape chips) ────────── */}
            {hasAspect ? (
              <div>
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '宽高比' : 'Aspect ratio'}</div>
                <div className="grid grid-cols-5 gap-1.5">
                  {template.supportsAutoAspect ? (
                    <AspectBlockButton
                      ratio="auto"
                      active={aspectRatio === 'auto'}
                      onClick={() => onAspectRatio('auto')}
                      label={language === 'zh' ? '自适应' : 'Auto'}
                    />
                  ) : null}
                  {template.aspectRatioOptions!.map((option) => (
                    <AspectBlockButton
                      key={option}
                      ratio={option}
                      active={option === aspectRatio}
                      onClick={() => onAspectRatio(option)}
                      label={option}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {/* ── Audio ──────────────────────────────────────────────────
                on/off 布尔对(如可灵的生成音效)用单个开关(2026-07 反馈);
                多档位(HappyHorse 的 auto/origin/off)保留按钮组。 */}
            {hasAudioSetting ? (
              template.audioSettingOptions!.length === 2
                && template.audioSettingOptions!.includes('on')
                && template.audioSettingOptions!.includes('off') ? (
                <div className="mt-4 flex items-center justify-between">
                  <div>
                    <div className="text-[11px] text-neutral-400">{language === 'zh' ? '声音' : 'Audio'}</div>
                    <div className="mt-0.5 text-[10px] text-neutral-500">
                      {AUDIO_LABEL[audioSetting === 'on' ? 'on' : 'off']}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={audioSetting === 'on'}
                    onClick={() => onAudioSetting!(audioSetting === 'on' ? 'off' : 'on')}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                      audioSetting === 'on' ? 'bg-violet-500/80' : 'bg-neutral-700'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-[left] ${
                        audioSetting === 'on' ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
              ) : (
                <div className="mt-4">
                  <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '声音' : 'Audio'}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {template.audioSettingOptions!.map((option) => (
                      <BlockButton key={option} active={option === audioSetting} onClick={() => onAudioSetting!(option)}>
                        {AUDIO_LABEL[option] ?? option}
                      </BlockButton>
                    ))}
                  </div>
                </div>
              )
            ) : null}

            {/* ── Seed (reproducible generation) ───────────────────────── */}
            {hasSeed ? (
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-[11px] text-neutral-400">
                  <span>{language === 'zh' ? '随机种子' : 'Seed'}</span>
                  {typeof seed === 'number' ? (
                    <button
                      type="button"
                      className="text-neutral-500 transition hover:text-neutral-300"
                      onClick={() => onSeed!(undefined)}
                    >
                      {language === 'zh' ? '改为随机' : 'Randomize'}
                    </button>
                  ) : null}
                </div>
                <input
                  type="number"
                  min={0}
                  max={2147483647}
                  value={typeof seed === 'number' ? seed : ''}
                  placeholder={language === 'zh' ? '留空即随机' : 'Empty = random'}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    if (raw === '') { onSeed!(undefined); return; }
                    const n = Math.floor(Number(raw));
                    if (Number.isFinite(n)) onSeed!(Math.max(0, Math.min(2147483647, n)));
                  }}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs tabular-nums text-neutral-200 outline-none transition focus:border-white/25"
                />
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
};

/** Pill button used throughout MediaParamsPopover. Captures the glass style:
 *  inactive = subtle translucent fill; active = white text on a brighter
 *  ring + soft inner glow that matches the reference design. */
function PillButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-full px-3 py-1.5 text-xs transition',
        active
          ? 'bg-white/15 text-white ring-1 ring-white/30 shadow-[inset_0_0_12px_rgba(255,255,255,0.08)]'
          : 'bg-white/[0.04] text-neutral-300 ring-1 ring-white/8 hover:bg-white/[0.07]',
      )}
    >
      {children}
    </button>
  );
}

/** Block-style button used for Resolution + Aspect ratio in the params popover.
 *  Larger tap target, lives inside a 2/3-column grid. Mirrors the reference UI. */
function BlockButton({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center justify-center rounded-xl px-3 py-2 text-xs transition',
        active
          ? 'bg-white/15 text-white ring-1 ring-white/30 shadow-[inset_0_0_12px_rgba(255,255,255,0.08)]'
          : 'bg-white/[0.04] text-neutral-300 ring-1 ring-white/8 hover:bg-white/[0.07]',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Aspect-ratio chip — compact square: a rect icon scaled to the actual W:H
 *  on top, the bare "W:H" value underneath (reference-style one-row picker). */
function AspectBlockButton({
  ratio,
  active,
  onClick,
  label,
}: {
  ratio: string;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  // Parse "W:H"; default to a horizontal box for "auto" / unparseable.
  const dims = (() => {
    const m = /^(\d+):(\d+)$/.exec(ratio);
    if (!m) return { w: 17, h: 11 };
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!w || !h) return { w: 17, h: 11 };
    const max = 17;
    if (w >= h) return { w: max, h: Math.max(7, Math.round((max * h) / w)) };
    return { w: Math.max(7, Math.round((max * w) / h)), h: max };
  })();
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10px] leading-none transition',
        active
          ? 'bg-white/15 text-white ring-1 ring-white/30 shadow-[inset_0_0_12px_rgba(255,255,255,0.08)]'
          : 'bg-white/[0.04] text-neutral-300 ring-1 ring-white/8 hover:bg-white/[0.07]',
      )}
    >
      <span
        className={clsx('shrink-0 rounded-[2px] border', active ? 'border-white/80' : 'border-white/40')}
        style={{ width: dims.w, height: dims.h }}
      />
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}

const getNodeParams = (data: any) => ((data?.generationParams ?? {}) as Record<string, any>);

/** HappyHorse 各模式的参考数量上限 — reference-modes.ts 里这套限额只存在于
 *  happyHorseSuffixSatisfied 的命令式 switch（1/9/5 散落在代码和 toast 文案里），
 *  参考条下方的限额提示需要一份结构化数据。数字与 switch 保持一致。 */
const HAPPYHORSE_SUFFIX_REQUIRES: Record<string, { images: { min: number; max: number }; videos: { min: number; max: number } }> = {
  't2v': { images: { min: 0, max: 0 }, videos: { min: 0, max: 0 } },
  'i2v': { images: { min: 1, max: 1 }, videos: { min: 0, max: 0 } },
  'r2v': { images: { min: 1, max: 9 }, videos: { min: 0, max: 0 } },
  'video-edit': { images: { min: 0, max: 5 }, videos: { min: 1, max: 1 } },
};

// 紧凑提示面板编辑器的自适应高度范围：初始约两行（参考图一的紧凑态），
// 随内容长高到上限（参考图二）后改为内部滚动。
const PROMPT_EDITOR_MIN_H = 76;
const PROMPT_EDITOR_MAX_H = 280;

/** Empty-state placeholder for media generation nodes. Renders a large
 *  centered icon over a softly-glowing background, with a placeholder
 *  caption underneath ("输入提示词生成视频" / "输入提示词生成图片" / etc.).
 *  Matches the design reference (gray hint text under the icon). */
function MediaEmptyPlaceholder({
  icon: Icon,
  zh,
  className,
  style,
  caption,
}: {
  icon: any;
  zh: boolean;
  className?: string;
  style?: React.CSSProperties;
  caption: { zh: string; en: string };
}) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-3 rounded-[12px] text-neutral-500',
        className,
      )}
      style={style}
    >
      <Icon className="h-7 w-7 text-neutral-600" />
      <span className="text-[12px] text-neutral-500">
        {zh ? caption.zh : caption.en}
      </span>
    </div>
  );
}

type PromptMention = { tag: string; id: string; thumb: string; kind?: string };

/** 行内 @ 提及左侧的小预览图。关键:绝对定位 + 零布局宽度(right:100% 浮在
 *  标签左侧),不占镜像层的字符排布,真实 textarea 的光标依旧逐字对齐。
 *  有缩略图(图片/视频封面)显示图片,音频/文本等无图则显示图标底片。 */
function MentionThumb({ thumb, kind }: { thumb: string; kind?: string }) {
  const base: React.CSSProperties = {
    position: 'absolute',
    right: '100%',
    top: '50%',
    transform: 'translateY(-50%)',
    marginRight: 2,
    width: 14,
    height: 14,
    borderRadius: 4,
    overflow: 'hidden',
    pointerEvents: 'none',
  };
  if (thumb) {
    return (
      <img
        src={toRenderableMediaUrl(thumb)}
        alt=""
        aria-hidden
        style={{ ...base, objectFit: 'cover', border: '1px solid rgba(255,255,255,0.20)' }}
      />
    );
  }
  const glyph = kind === 'audio' ? '♪' : kind === 'video' ? '▶' : kind === 'text' ? 'T' : '#';
  return (
    <span
      aria-hidden
      style={{
        ...base,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(34,211,238,0.16)',
        border: '1px solid rgba(34,211,238,0.28)',
        fontSize: 9,
        lineHeight: 1,
        color: '#a5e8f2',
      }}
    >
      {glyph}
    </span>
  );
}

/** Render text with inline mention chips + thumbnails. Splits on `[@xxx]` tags. */
function renderMentionRichText(text: string, mentions: PromptMention[]): React.ReactNode {
  if (!mentions.length) return text;

  // Build a regex that matches any of the mention tags.
  const escaped = mentions.map((m) => m.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'g');
  const parts = text.split(regex);

  return parts.map((part, i) => {
    const mention = mentions.find((m) => m.tag === part);
    if (mention) {
      // 镜像层逐字对齐真实 textarea → 提及标签文本按原样渲染(等宽),缩略图
      // 用 MentionThumb 以零布局宽度浮在左侧,不破坏光标定位。
      return (
        <span
          key={i}
          data-mention-id={mention.id}
          // 只用颜色提亮/加清晰度 —— 镜像层必须与透明 textarea 同字重,
          // 改 font-weight 会让提及字符变宽、光标错位,故仅提亮颜色。
          className="relative rounded-sm text-cyan-200"
          style={{
            backgroundColor: 'rgba(34, 211, 238, 0.16)',
            boxShadow: '0 0 0 1px rgba(34, 211, 238, 0.28)',
          }}
          title={mention.tag}
        >
          <MentionThumb thumb={mention.thumb} kind={mention.kind} />
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/** 引用悬停预览(参考交互):图片放大 / 视频静音循环 / 音频迷你播放器。
 *  portal 到 body + fixed 定位 —— RF 节点带 transform,fixed 在其内部会退化
 *  成相对该节点定位,必须逃出节点树;坐标用屏幕坐标,画布缩放下依然对位。
 *  音频要可点播放,所以浮层开 pointer-events,配合悬停延时关闭做移入交接。 */
function RefHoverPreview({ up, left, top, onEnter, onLeave }: {
  up: { kind: string; thumb: string; mediaUrl: string; label: string };
  left: number;
  top: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(left - 134, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 276)),
    top: Math.max(8, top - 8),
    transform: 'translateY(-100%)',
  };
  let body: React.ReactNode = null;
  if (up.kind === 'audio' && up.mediaUrl) {
    body = <audio src={toRenderableMediaUrl(up.mediaUrl)} controls preload="metadata" className="h-9 w-[252px]" />;
  } else if (up.kind === 'video' && (up.mediaUrl || up.thumb)) {
    body = up.mediaUrl ? (
      <video src={toRenderableMediaUrl(up.mediaUrl)} muted autoPlay loop playsInline className="max-h-[180px] w-[252px] rounded-md bg-black object-contain" />
    ) : (
      <img src={toRenderableMediaUrl(up.thumb)} alt="" className="max-h-[180px] w-[252px] rounded-md object-contain" />
    );
  } else if (up.thumb) {
    body = <img src={toRenderableMediaUrl(up.thumb)} alt="" className="max-h-[200px] max-w-[252px] rounded-md object-contain" />;
  }
  if (!body) return null;
  return createPortal(
    <div
      className="fixed z-[140] rounded-lg border border-white/12 bg-[#101114]/95 p-2 shadow-2xl backdrop-blur-md"
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {body}
      <div className="mt-1 text-center text-[10px] text-neutral-500">{up.label}</div>
    </div>,
    document.body,
  );
}

const getAspectRatioClass = (aspectRatio: string | undefined, fallback: string) => {
  switch (aspectRatio) {
    case '1:1':
      return 'aspect-square';
    case '9:16':
      return 'aspect-[9/16]';
    case '16:9':
      return 'aspect-video';
    case '3:4':
      return 'aspect-[3/4]';
    case '4:3':
      return 'aspect-[4/3]';
    case '3:2':
      return 'aspect-[3/2]';
    case '2:3':
      return 'aspect-[2/3]';
    case '5:4':
      return 'aspect-[5/4]';
    case '4:5':
      return 'aspect-[4/5]';
    case '21:9':
      return 'aspect-[21/9]';
    case '2:1':
      return 'aspect-[2/1]';
    case '1:2':
      return 'aspect-[1/2]';
    case '9:21':
      return 'aspect-[9/21]';
    default:
      return fallback;
  }
};

const getMediaAspectRatioStyle = (data: Record<string, any>): React.CSSProperties | undefined => {
  const width = Number(data.mediaWidth);
  const height = Number(data.mediaHeight);
  return width > 0 && height > 0 ? { aspectRatio: `${width} / ${height}` } : undefined;
};

// Flat dark shell — no gradients, no inner ring. Selected = single hairline ring.
// Bg sits a touch above canvas (#0a0a0a); border kept very faint so the card
// reads from value contrast rather than a stroked outline.
const NEUTRAL_NODE_SHELL = {
  shell: 'border-white/8 shadow-[0_6px_20px_-14px_rgba(0,0,0,0.7)]',
  // "银丝" — a fine, bright silver thread outlining the selected node: a thin
  // 1.5px cool-silver inset ring plus a faint silvery shine (no thick/heavy
  // glow), so it reads delicate and metallic rather than a chunky white border.
  selected: 'shadow-[inset_0_0_0_1.5px_rgba(226,232,240,0.95),inset_0_0_6px_-1px_rgba(226,232,240,0.35),0_0_10px_-2px_rgba(226,232,240,0.35)]',
  surface: 'border-white/8 bg-[#23242a]',
} as const;

const NODE_TONE_STYLES = {
  text: NEUTRAL_NODE_SHELL,
  image: NEUTRAL_NODE_SHELL,
  video: NEUTRAL_NODE_SHELL,
  audio: NEUTRAL_NODE_SHELL,
  neutral: NEUTRAL_NODE_SHELL,
} as const;

/**
 * Media node sizing. The node WIDTH follows the media's aspect ratio so a 16:9
 * card is wide-and-short while a 9:16 card is narrow-and-tall, but both keep a
 * similar AREA (footprint) — matching the reference product. The media then
 * fills the box exactly (object-cover on an aspect-matched box = no crop, no
 * letterbox padding, no border). Returns explicit px so there's no CSS
 * aspect-ratio/min-max ambiguity.
 */
const MEDIA_NODE_AREA = 66000; // ≈ the previous 300×220 footprint
function mediaBoxFromAspect(aspect: number): { width: number; height: number } {
  const MIN_W = 190, MAX_W = 380, MIN_H = 150, MAX_H = 390;
  let width = Math.sqrt(MEDIA_NODE_AREA * aspect);
  let height = width / aspect;
  // Clamp both axes so extreme ratios stay reasonable (order matters little —
  // a couple of passes converge for the ratios we see in practice).
  if (height > MAX_H) { height = MAX_H; width = height * aspect; }
  if (height < MIN_H) { height = MIN_H; width = height * aspect; }
  if (width > MAX_W) { width = MAX_W; height = width / aspect; }
  if (width < MIN_W) { width = MIN_W; height = width / aspect; }
  return { width: Math.round(width), height: Math.round(height) };
}
/** Parse an aspect value ("16:9", "9/16", 1.7) into a numeric ratio. */
function parseAspectRatio(value: unknown, fallback = 16 / 9): number {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value === 'string') {
    const m = value.match(/(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/);
    if (m) {
      const w = parseFloat(m[1]), h = parseFloat(m[2]);
      if (w > 0 && h > 0) return w / h;
    }
  }
  return fallback;
}

const getReferenceDisplayName = (data: any) => {
  if (typeof data?.sourceName === 'string' && data.sourceName.trim()) {
    return data.sourceName.trim();
  }

  if (typeof data?.url === 'string' && data.url) {
    try {
      const parsed = new URL(data.url, window.location.origin);
      const pathname = parsed.pathname.split('/').filter(Boolean);
      const lastSegment = pathname[pathname.length - 1];
      if (lastSegment) return decodeURIComponent(lastSegment);
    } catch {
      const lastSegment = String(data.url).split('/').filter(Boolean).pop();
      if (lastSegment) return lastSegment;
    }
  }

  return '';
};

const formatMediaResolution = (width?: number, height?: number) => {
  if (!width || !height) return '';
  return `${width} × ${height}`;
};

const EditableNodeTitle = ({
  nodeId,
  value,
  field,
  preserveExtension = false,
}: {
  nodeId: string;
  value: string;
  field: string;
  preserveExtension?: boolean;
}) => {
  const updateNodeData = useStore((state) => state.updateNodeData);
  const [editing, setEditing] = useState(false);
  const [{ basename, extension }, setParts] = useState(() => splitFilenameExtension(value));

  useEffect(() => {
    setParts(splitFilenameExtension(value));
  }, [value]);

  const commit = useCallback(() => {
    const nextBase = basename.trim();
    const nextValue = preserveExtension ? `${nextBase || splitFilenameExtension(value).basename}${extension}` : (nextBase || value);
    updateNodeData(nodeId, { [field]: nextValue });
    setEditing(false);
  }, [basename, extension, field, nodeId, preserveExtension, updateNodeData, value]);

  if (editing) {
    return (
      <input
        autoFocus
        value={basename}
        onChange={(event) => setParts((current) => ({ ...current, basename: event.target.value }))}
        onBlur={commit}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          }
          if (event.key === 'Escape') {
            setParts(splitFilenameExtension(value));
            setEditing(false);
          }
        }}
        className="nodrag pointer-events-auto w-full rounded bg-white/10 px-1.5 py-0.5 text-[11px] tracking-wide text-neutral-100 outline-none ring-1 ring-cyan-300/40"
        data-no-canvas-menu="true"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setEditing(true);
      }}
      className="block max-w-full truncate text-left tracking-wide"
      title={value}
      data-no-canvas-menu="true"
    >
      {value}
    </button>
  );
};

const stopNodeGesture = (event: React.MouseEvent | React.PointerEvent) => {
  event.stopPropagation();
};

export function canSubmitEmptyPromptForReferences(
  serviceType: string,
  counts: { images: number; videos: number },
): boolean {
  return serviceType === 'video' && (counts.images > 0 || counts.videos > 0);
}

const PromptPanel = ({
  nodeId,
  serviceType,
  fallbackModel,
}: {
  nodeId: string;
  serviceType: ServiceType;
  fallbackModel: string;
}) => {
  // The prompt panel renders at a FIXED screen size regardless of canvas
  // zoom: at 50% zoom the panel would otherwise shrink to half size and
  // become unreadable. We counter-scale by `1 / viewport.zoom` so the
  // visual size stays constant. The 0×0 anchor + absolute child pattern
  // keeps the surrounding layout from being warped by the scale.
  const viewport = useViewport();
  const inverseZoom = 1 / (viewport.zoom || 1);
  const language = useStore((state) => state.language);
  const edges = useStore((state) => state.edges);
  const allNodes = useStore((state) => state.nodes);
  const runNode = useStore((state) => state.runNode);
  const backendModels = useStore((state) => state.backendModels);
  const updateNodeGenerationParams = useStore((state) => state.updateNodeGenerationParams);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const addNode = useStore((state) => state.addNode);
  const onConnect = useStore((state) => state.onConnect);
  const onEdgesChange = useStore((state) => state.onEdgesChange);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Keep the full edge so the strip can wire the disconnect button to a
  // specific edge id instead of guessing one from (source,target).
  const upstreamEdges = edges.filter((edge) => edge.target === nodeId);
  const upstreamIds = upstreamEdges.map((edge) => edge.source);
  const upstreamNodes = useMemo(() => upstreamEdges.map((edge, idx) => {
    const id = edge.source;
    const n = allNodes.find((node) => node.id === id);
    const d = (n?.data ?? {}) as Record<string, string>;
    const type = n?.type ?? '';
    // 导演台 / 构图预览的输出是构图快照 —— 在引用条里就是一张图片参考,
    // 与 collectUpstreamReferenceMedia 的取值逻辑保持一致。
    const stageData = n?.data as { editorPreview?: string; lastCapture?: { image?: string }; image?: string } | undefined;
    const stageThumb = type === 'directorStageNode'
      ? (stageData?.editorPreview || stageData?.lastCapture?.image || '')
      : type === 'compositionPreviewNode'
        ? (stageData?.image || '')
        : '';
    const isImage = type === 'imageNode' || type === 'referenceImageNode'
      || type === 'directorStageNode' || type === 'compositionPreviewNode';
    const isVideo = type === 'videoNode' || type === 'referenceVideoNode';
    const isAudio = type === 'audioNode' || type === 'referenceAudioNode';
    // 音频没有可用缩略图（url 是 mp3，塞进 <img> 就是裂图）——留空走图标卡；
    // 视频优先用封面帧，兜底才是原始视频 url。
    const thumb = isAudio ? '' : isVideo ? (d.poster || d.thumbnail || d.url || '') : (stageThumb || d.url || d.thumbnail || '');
    const kind = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'other';
    const label = isImage ? `图片 ${idx + 1}` : isVideo ? `视频 ${idx + 1}` : isAudio ? `音频 ${idx + 1}` : `节点 ${idx + 1}`;
    const icon = isImage ? '图' : isVideo ? '视' : isAudio ? '音' : '节';
    // mediaUrl:悬停预览用的原始媒体(音频/视频要能播,不只是缩略图)。
    const mediaUrl = d.url || '';
    return { id, edgeId: edge.id, type, kind, thumb, mediaUrl, label, icon, index: idx + 1 };
  }), [upstreamEdges, allNodes]);

  const currentNode = allNodes.find((node) => node.id === nodeId);
  const params = getNodeParams(currentNode?.data);
  const nodeData = (currentNode?.data ?? {}) as Record<string, unknown>;

  /** Persisted draft prompt — survives node deselect / page refresh / canvas reload. */
  const [text, setText] = useState<string>(() => String(nodeData.promptDraft ?? ''));
  const [mentions, setMentions] = useState<PromptMention[]>(
    () => Array.isArray(nodeData.promptMentions) ? (nodeData.promptMentions as PromptMention[]) : [],
  );

  // If the user switches focus to a different node and back, we re-init from
  // the freshly-loaded node data. Compare by content to avoid clobbering an
  // in-flight edit when the same data round-trips through the store.
  useEffect(() => {
    const incoming = String(nodeData.promptDraft ?? '');
    setText((prev) => (prev === incoming ? prev : incoming));
    const m = Array.isArray(nodeData.promptMentions) ? (nodeData.promptMentions as typeof mentions) : [];
    setMentions((prev) => (JSON.stringify(prev) === JSON.stringify(m) ? prev : m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const [mentionOpen, setMentionOpen] = useState(false);

  // 引用悬停预览:strip 缩略图或行内 @提及 chip 悬停时浮出(屏幕坐标)。
  // 关闭走 220ms 延时,让指针能从 chip 移进浮层里点音频播放。
  const [refHover, setRefHover] = useState<{ id: string; left: number; top: number } | null>(null);
  const refHoverClearTimer = useRef<number | null>(null);
  const cancelRefHoverClear = useCallback(() => {
    if (refHoverClearTimer.current !== null) {
      window.clearTimeout(refHoverClearTimer.current);
      refHoverClearTimer.current = null;
    }
  }, []);
  const scheduleRefHoverClear = useCallback(() => {
    cancelRefHoverClear();
    refHoverClearTimer.current = window.setTimeout(() => setRefHover(null), 220);
  }, [cancelRefHoverClear]);
  const showRefHover = useCallback((id: string, rect: { left: number; top: number; width: number }) => {
    cancelRefHoverClear();
    setRefHover({ id, left: rect.left + rect.width / 2, top: rect.top });
  }, [cancelRefHoverClear]);
  // 行内 @提及命中检测:镜像层与 textarea 逐字符对齐,提及 span 的屏幕
  // rect 就是文本里芯片的真实位置 —— textarea 在上层收事件,拿坐标来撞。
  const hitTestMentionHover = useCallback((event: React.MouseEvent, overlayEl: HTMLElement | null) => {
    if (!overlayEl) return;
    const spans = overlayEl.querySelectorAll<HTMLElement>('[data-mention-id]');
    for (const s of Array.from(spans)) {
      const r = s.getBoundingClientRect();
      if (event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) {
        showRefHover(s.dataset.mentionId ?? '', r);
        return;
      }
    }
    scheduleRefHoverClear();
  }, [showRefHover, scheduleRefHoverClear]);
  const [expanded, setExpanded] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const compactOverlayRef = useRef<HTMLDivElement>(null);
  const expandedOverlayRef = useRef<HTMLDivElement>(null);

  // 紧凑面板的编辑器自适应高度：初始一两行（参考态），随内容长高，到上限后
  // 改用滚动条。展开弹窗里的编辑器走 flex-1，不参与。
  const [editorHeight, setEditorHeight] = useState(PROMPT_EDITOR_MIN_H);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || expanded) return;
    // 量内容高度：先压到 0 再读 scrollHeight（同一布局帧内完成，不闪）。
    // 高度变化是瞬时的（不加 CSS 过渡）：面板带 backdrop-blur，逐帧动画高度
    // 会引发连环重绘，粘贴大段文本时表现为频闪；且动画中的高度会污染
    // scrollHeight 测量。
    const prevHeight = ta.style.height;
    ta.style.height = '0px';
    const next = Math.min(PROMPT_EDITOR_MAX_H, Math.max(PROMPT_EDITOR_MIN_H, ta.scrollHeight));
    ta.style.height = prevHeight;
    setEditorHeight(next);
  }, [text, expanded]);

  // Esc closes the expanded modal — the X button alone is too easy to miss
  // when the panel has no preview yet and the textarea fills the surface.
  useEffect(() => {
    if (!expanded) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [expanded]);

  const enabledConfigs = useMemo(
    () => backendModels
      .filter((pc) => pc.service_type === serviceType)
      .map((pc) => ({
        vendor: pc.vendor,
        name: pc.name,
        modelList: pc.model_list,
        parameterSchema: pc.parameter_schema,
        raw: pc,
      })),
    [backendModels, serviceType],
  );

  const vendorOptions = useMemo(
    () => [...new Set(enabledConfigs.map((config) => config.vendor))],
    [enabledConfigs],
  );

  const activeVendor = useMemo(() => {
    if (params.vendor && vendorOptions.includes(params.vendor)) {
      return params.vendor;
    }
    if (params.model) {
      return enabledConfigs.find((config) => config.modelList.includes(params.model))?.vendor ?? vendorOptions[0] ?? '';
    }
    return vendorOptions[0] ?? '';
  }, [enabledConfigs, params.model, params.vendor, vendorOptions]);

  // Show models from EVERY enabled provider for this service type, not
  // just the active vendor. The vendor selector has been removed in favor
  // of model-only selection; vendor is resolved implicitly from the picked
  // model. Duplicates across vendors are deduped — the first vendor that
  // declares the model owns the default route, but the backend can fall
  // back to other vendors on failure.
  const availableModels = useMemo(
    () => enabledConfigs
      .flatMap((config) => config.modelList)
      .filter((value, index, values) => values.indexOf(value) === index),
    [enabledConfigs],
  );

  // 管理端「编辑模型」的元数据（parameter_schema.vendor_models）：
  //   hidden=true → 可被调用（如超分等内部功能）但不出现在选择列表；
  //   name       → 前端展示用显示名称（值仍存真实模型 id）。
  const { hiddenModels, modelDisplayNames } = useMemo(() => {
    const hidden = new Set<string>();
    const names = new Map<string, string>();
    for (const config of enabledConfigs) {
      const schema = config.parameterSchema as { vendor_models?: unknown[]; vendor_all_models?: unknown[] } | undefined;
      const rawModels = Array.isArray(schema?.vendor_models)
        ? schema.vendor_models
        : Array.isArray(schema?.vendor_all_models)
          ? schema.vendor_all_models
          : [];
      for (const raw of rawModels) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as { modelName?: unknown; model_name?: unknown; name?: unknown; hidden?: unknown };
        const modelName = String(entry.modelName ?? entry.model_name ?? '').trim();
        if (!modelName) continue;
        if (entry.hidden === true) hidden.add(modelName);
        const display = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (display && display !== modelName && !names.has(modelName)) names.set(modelName, display);
      }
    }
    return { hiddenModels: hidden, modelDisplayNames: names };
  }, [enabledConfigs]);

  const modelIsDisabled = Boolean(params.model) && !enabledConfigs.some((config) => config.modelList.includes(params.model));
  const activeModel = useMemo(() => {
    if (params.model && availableModels.includes(params.model)) {
      return params.model;
    }
    // 默认选择跳过隐藏模型（它们只服务内部功能，不该成为兜底默认）。
    return availableModels.find((m) => !hiddenModels.has(m)) ?? availableModels[0] ?? fallbackModel;
  }, [availableModels, fallbackModel, hiddenModels, params.model]);

  useEffect(() => {
    if (!modelIsDisabled || !activeModel || activeModel === params.model) {
      return;
    }

    const owningConfig = enabledConfigs.find((config) => config.modelList.includes(activeModel));
    updateNodeGenerationParams(nodeId, {
      model: activeModel,
      vendor: owningConfig?.vendor ?? activeVendor,
    });
  }, [activeModel, activeVendor, enabledConfigs, modelIsDisabled, nodeId, params.model, updateNodeGenerationParams]);

  const activeConfig = useMemo(
    () => enabledConfigs.find((config) => config.modelList.includes(activeModel))?.raw ?? null,
    [activeModel, enabledConfigs],
  );
  const template = getModelTemplate(activeModel, activeConfig);
  // Per-call credit cost for the selected model: per-model override in the
  // schema wins, then the config-level value, then the default of 1. Mirrors
  // the backend's resolveCreditCost so the badge matches what gets charged.
  const creditCost = useMemo(() => {
    const schema = activeConfig?.parameter_schema as
      | { credit_cost?: number; models?: Record<string, { credit_cost?: number }> }
      | undefined;
    const perModel = schema?.models?.[activeModel]?.credit_cost;
    if (typeof perModel === 'number') return Math.max(0, Math.round(perModel));
    if (typeof schema?.credit_cost === 'number') return Math.max(0, Math.round(schema.credit_cost));
    return 1;
  }, [activeConfig, activeModel]);
  const currentMode = params.mode ?? template?.defaults?.mode ?? template?.modeOptions?.[0] ?? '';
  const currentResolution = params.resolution ?? template?.defaults?.resolution ?? template?.resolutionOptions?.[0] ?? '';
  const currentQuality = params.quality ?? template?.defaults?.quality ?? template?.qualityOptions?.[0] ?? '';
  const currentAspectRatio = params.aspectRatio
    ?? (template?.supportsAutoAspect ? 'auto' : template?.defaults?.aspectRatio ?? template?.aspectRatioOptions?.[0] ?? '');
  const currentDuration = params.durationSeconds ?? template?.durationRange?.defaultValue ?? template?.durationRange?.min ?? 5;
  const currentOutputFormat = params.outputFormat ?? template?.defaults?.outputFormat ?? template?.outputFormatOptions?.[0] ?? '';
  const currentAudioSetting = params.audioSetting ?? template?.audioSettingOptions?.[0] ?? 'auto';
  const currentSeed = typeof params.seed === 'number' ? params.seed : undefined;

  useEffect(() => {
    if (!template) {
      return;
    }
    const nextPatch: Record<string, unknown> = {};

    if (!params.vendor && activeVendor) nextPatch.vendor = activeVendor;
    if (!params.model && activeModel) nextPatch.model = activeModel;
    if (template.supportsMode && !params.mode && currentMode) nextPatch.mode = currentMode;
    if (template.supportsResolution && !params.resolution && currentResolution) nextPatch.resolution = currentResolution;
    if (template.supportsQuality && !params.quality && currentQuality) nextPatch.quality = currentQuality;
    if ((template.supportsAspectRatio || template.supportsAutoAspect) && !params.aspectRatio && currentAspectRatio) nextPatch.aspectRatio = currentAspectRatio;
    if (template.supportsDuration && !params.durationSeconds && currentDuration) nextPatch.durationSeconds = currentDuration;
    if (template.supportsOutputFormat && !params.outputFormat && currentOutputFormat) nextPatch.outputFormat = currentOutputFormat;

    if (Object.keys(nextPatch).length > 0) {
      updateNodeGenerationParams(nodeId, nextPatch);
    }
  }, [
    activeModel,
    activeVendor,
    currentAspectRatio,
    currentDuration,
    currentMode,
    currentQuality,
    currentResolution,
    currentOutputFormat,
    nodeId,
    params.aspectRatio,
    params.durationSeconds,
    params.mode,
    params.model,
    params.quality,
    params.resolution,
    params.outputFormat,
    params.vendor,
    template,
    updateNodeGenerationParams,
  ]);

  const [mentionPos, setMentionPos] = useState<{ left: number; top: number } | null>(null);

  /** Measure the pixel position of the @ trigger character inside the textarea.
   *  Returns {left, top} relative to the textarea element's top-left corner,
   *  where top points to just below the @ line (for placing popup underneath). */
  const measureMentionPosition = useCallback((textarea: HTMLTextAreaElement, atIndex: number) => {
    const mirror = document.createElement('div');
    const style = getComputedStyle(textarea);
    mirror.style.cssText = [
      'position:absolute', 'visibility:hidden', 'white-space:pre-wrap', 'word-wrap:break-word',
      'overflow:hidden', `width:${textarea.clientWidth}px`,
      `font:${style.font}`, `letter-spacing:${style.letterSpacing}`,
      `line-height:${style.lineHeight}`, `padding:${style.padding}`,
      `border:${style.border}`, 'box-sizing:border-box',
    ].join(';');
    const textBefore = textarea.value.slice(0, atIndex);
    mirror.appendChild(document.createTextNode(textBefore));
    const span = document.createElement('span');
    span.textContent = '|';
    mirror.appendChild(span);
    document.body.appendChild(mirror);
    const spanRect = span.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    document.body.removeChild(mirror);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    return {
      left: spanRect.left - mirrorRect.left,
      top: spanRect.top - mirrorRect.top - textarea.scrollTop + lineHeight,
    };
  }, []);

  /** Persist text + mentions to the node data — debounced so we don't hammer
   *  the store on every keystroke, and so canvas auto-save batches with it. */
  useEffect(() => {
    if (!currentNode) return;
    const persistedText = String((currentNode.data as Record<string, unknown>).promptDraft ?? '');
    const persistedMentions = ((currentNode.data as Record<string, unknown>).promptMentions ?? []) as unknown[];
    // Nothing to persist if state already matches what's in the store.
    if (text === persistedText && JSON.stringify(mentions) === JSON.stringify(persistedMentions)) return;

    const t = setTimeout(() => {
      updateNodeData(nodeId, { promptDraft: text, promptMentions: mentions });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mentions, nodeId]);

  const onChange = (value: string) => {
    setText(value);
    const cursor = taRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const match = /@(\S*)$/.exec(before);
    const shouldOpen = Boolean(match) && upstreamNodes.length > 0;
    setMentionOpen(shouldOpen);
    if (shouldOpen && match && taRef.current) {
      const atIndex = before.lastIndexOf('@');
      setMentionPos(measureMentionPosition(taRef.current, atIndex));
    }
  };

  const insertMention = (upstream: typeof upstreamNodes[0]) => {
    const cursor = taRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, cursor).replace(/@\S*$/, '');
    const after = text.slice(cursor);
    const tag = `[@${upstream.label}]`;
    setText(before + tag + ' ' + after);
    setMentions((prev) => [...prev.filter((m) => m.id !== upstream.id), { tag, id: upstream.id, thumb: upstream.thumb, kind: upstream.kind }]);
    setMentionOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
  };

  const resolveTagsToMentions = (raw: string): string => {
    let result = raw;
    for (const m of mentions) {
      if (result.includes(m.tag)) {
        result = result.replace(m.tag, `@${m.id.slice(0, 12)}`);
      }
    }
    return result;
  };

  const handleModelChange = (nextModel: string) => {
    const owningConfig = enabledConfigs.find((config) => config.modelList.includes(nextModel));
    const nextTemplate = getModelTemplate(nextModel, owningConfig?.raw ?? null);
    // Resolve vendor from whichever provider owns the picked model. The
    // template's hardcoded vendor wins (e.g. "doubao-*" → "doubao") so
    // backend routing stays deterministic, but if a user-imported model
    // doesn't match any template we fall back to the first provider that
    // declares it.
    const resolvedVendor = nextTemplate?.vendor ?? owningConfig?.vendor ?? activeVendor;
    updateNodeGenerationParams(nodeId, {
      vendor: resolvedVendor,
      model: nextModel,
      mode: nextTemplate?.defaults?.mode ?? nextTemplate?.modeOptions?.[0],
      resolution: nextTemplate?.defaults?.resolution ?? nextTemplate?.resolutionOptions?.[0],
      quality: nextTemplate?.defaults?.quality ?? nextTemplate?.qualityOptions?.[0],
      aspectRatio: nextTemplate?.supportsAutoAspect ? 'auto' : nextTemplate?.defaults?.aspectRatio ?? nextTemplate?.aspectRatioOptions?.[0],
      durationSeconds: nextTemplate?.durationRange?.defaultValue,
      outputFormat: nextTemplate?.defaults?.outputFormat ?? nextTemplate?.outputFormatOptions?.[0],
    });
  };

  // Whether this node already has an in-flight generation. Used to spin +
  // disable the submit button so rapid clicks can't fire multiple tasks
  // (each click previously kicked off another billed generation).
  const isBusy = nodeData.status === 'running' || nodeData.status === 'generating' || nodeData.status === 'uploading';

  const submit = () => {
    if (isBusy) return; // guard the Enter-key path + any double fire
    const currentReferenceCounts = upstreamNodes.reduce(
      (counts, up) => {
        if (up.type === 'imageNode' || up.type === 'referenceImageNode') counts.images += 1;
        else if (up.type === 'videoNode' || up.type === 'referenceVideoNode') counts.videos += 1;
        return counts;
      },
      { images: 0, videos: 0 },
    );
    if (!text.trim() && !canSubmitEmptyPromptForReferences(serviceType, currentReferenceCounts)) {
      updateNodeData(nodeId, {
        status: 'error',
        error: language === 'zh' ? '请输入提示词后再生成。' : 'Enter a prompt before generating.',
      });
      return;
    }
    if (!activeModel) {
      updateNodeData(nodeId, {
        status: 'error',
        error: language === 'zh' ? '当前没有可用模型，请先在管理端启用模型配置。' : 'No available model. Enable a model config first.',
      });
      return;
    }
    updateNodeData(nodeId, {
      status: 'running',
      error: undefined,
      queuedAfterTimeout: false,
    });
    void Promise.resolve(runNode(nodeId, { prompt: resolveTagsToMentions(text), model: activeModel })).catch((err: unknown) => {
      updateNodeData(nodeId, {
        status: 'error',
        error: err instanceof Error ? err.message : (language === 'zh' ? '生成请求提交失败。' : 'Failed to submit generation request.'),
      });
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    // Treat each @mention as an atomic unit for editing — backspace /
    // delete / arrow keys jump across the whole tag instead of one
    // character at a time. The raw text stays in sync (we replace whole
    // tags), so the overlay never gets a half-broken token.
    const textarea = event.currentTarget;
    const { selectionStart, selectionEnd, value } = textarea;
    if (selectionStart !== selectionEnd) return; // skip when there's a range selection

    // Find a mention tag that ends at the caret (for Backspace) or starts
    // at the caret (for Delete / right-arrow / left-arrow over).
    const findTagEndingAt = (pos: number) => mentions.find((m) => {
      const idx = value.lastIndexOf(m.tag, pos - 1);
      return idx >= 0 && idx + m.tag.length === pos;
    });
    const findTagStartingAt = (pos: number) => mentions.find((m) => value.startsWith(m.tag, pos));

    if (event.key === 'Backspace') {
      const tag = findTagEndingAt(selectionStart);
      if (tag) {
        event.preventDefault();
        const next = value.slice(0, selectionStart - tag.tag.length) + value.slice(selectionStart);
        onChange(next);
        // Reset caret after the next render.
        requestAnimationFrame(() => {
          textarea.setSelectionRange(selectionStart - tag.tag.length, selectionStart - tag.tag.length);
        });
      }
    } else if (event.key === 'Delete') {
      const tag = findTagStartingAt(selectionStart);
      if (tag) {
        event.preventDefault();
        const next = value.slice(0, selectionStart) + value.slice(selectionStart + tag.tag.length);
        onChange(next);
        requestAnimationFrame(() => {
          textarea.setSelectionRange(selectionStart, selectionStart);
        });
      }
    } else if (event.key === 'ArrowLeft' && !event.shiftKey) {
      const tag = findTagEndingAt(selectionStart);
      if (tag) {
        event.preventDefault();
        textarea.setSelectionRange(selectionStart - tag.tag.length, selectionStart - tag.tag.length);
      }
    } else if (event.key === 'ArrowRight' && !event.shiftKey) {
      const tag = findTagStartingAt(selectionStart);
      if (tag) {
        event.preventDefault();
        textarea.setSelectionRange(selectionStart + tag.tag.length, selectionStart + tag.tag.length);
      }
    }
  };

  const syncOverlayScroll = (textarea: HTMLTextAreaElement | null, overlay: HTMLDivElement | null) => {
    if (!textarea || !overlay) return;
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
  };

  // Video service type gets a reference-mode tab strip à la Seedance 2.0:
  // each tab is a distinct upstream request shape (first/last keyframes,
  // multi-image consistency, motion mimic, video edit, …). Tabs are gated
  // by both the active model's declared capabilities AND the current
  // upstream reference inputs — see reference-modes.ts. The chosen mode is
  // persisted in node.generationParams.referenceVariant.

  // Count current upstream image / video references feeding this node.
  const refCounts = useMemo(() => {
    let images = 0;
    let videos = 0;
    let audios = 0;
    for (const up of upstreamNodes) {
      // 用 kind 归类:导演台 / 构图预览也算图片参考(与实际发给后端的一致)。
      if (up.kind === 'image') images += 1;
      else if (up.kind === 'video') videos += 1;
      else if (up.kind === 'audio') audios += 1;
    }
    return { images, videos, audios };
  }, [upstreamNodes]);

  // The modes this model supports, in registry order. Video always gets the
  // tab strip; image gets it ONLY when the template explicitly declares modes
  // (wan2.7) — otherwise modesForModel's multi-image fallback would give plain
  // image models a spurious reference tab.
  const modelReferenceModes = useMemo<ReferenceModeKey[]>(
    () => {
      if (serviceType === 'video') return modesForModel(template?.referenceModes);
      if (serviceType === 'image' && template?.referenceModes?.length) return modesForModel(template.referenceModes);
      return [];
    },
    [serviceType, template?.referenceModes],
  );

  const persistedReferenceMode = (params.referenceVariant as ReferenceModeKey | undefined);
  // Resolve the effective active mode: prefer the persisted choice when it's
  // still both supported AND satisfiable; otherwise fall back to the first
  // satisfiable supported mode (or the first supported as a last resort).
  const activeReferenceMode = useMemo<ReferenceModeKey | ''>(() => {
    if (modelReferenceModes.length === 0) return '';
    if (
      persistedReferenceMode &&
      modelReferenceModes.includes(persistedReferenceMode) &&
      isModeSatisfied(persistedReferenceMode, refCounts)
    ) {
      return persistedReferenceMode;
    }
    return firstSatisfiedMode(modelReferenceModes, refCounts) ?? modelReferenceModes[0];
  }, [modelReferenceModes, persistedReferenceMode, refCounts]);

  // Auto-fallback persistence: if the persisted mode drifted out of the
  // valid set (e.g. user deleted the upstream video while on 动作模仿),
  // write the resolved mode back so the node never sits in an illegal state.
  useEffect(() => {
    if (serviceType !== 'video' && serviceType !== 'image') return;
    if (!activeReferenceMode) return;
    if (persistedReferenceMode !== activeReferenceMode) {
      updateNodeGenerationParams(nodeId, { referenceVariant: activeReferenceMode });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeReferenceMode, persistedReferenceMode, serviceType, nodeId]);

  // HappyHorse 家族：把单一模型 dropdown 拆成「版本」+「模式」两个，
  // 用户感知不到 -t2v/-i2v/-r2v/-video-edit 后缀，提交时再合成。
  const happyHorse = parseHappyHorseModel(activeModel);
  // 家族结构按 availableModels 计算 —— 即便当前不在 HappyHorse 上，模型
  // dropdown 也要把 7 个真实变体收成「HappyHorse 1.1 / 1.0」两行展示。
  const happyHorseFamily = useMemo(() => {
    const versions = new Set<string>();
    const versionToSuffixes = new Map<string, Set<string>>();
    for (const m of availableModels) {
      const parsed = parseHappyHorseModel(m);
      if (!parsed) continue;
      versions.add(parsed.version);
      if (!versionToSuffixes.has(parsed.version)) versionToSuffixes.set(parsed.version, new Set());
      versionToSuffixes.get(parsed.version)!.add(parsed.suffix);
    }
    if (versions.size === 0) return null;
    return {
      versions: Array.from(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
      suffixesByVersion: versionToSuffixes,
    };
  }, [availableModels]);

  // Whether a HappyHorse suffix is valid for the current upstream refs. The
  // rule set lives in reference-modes.ts (happyHorseSuffixSatisfied) so it is
  // unit-tested independently: 文生(t2v) = no refs; 首帧(i2v) = exactly 1 image;
  // 参考生(r2v) = 1~9 images, no video; 视频编辑(video-edit) = exactly 1 video + ≤5 images.
  const isHappyHorseSuffixSatisfied = (suffix: string): boolean =>
    happyHorseSuffixSatisfied(suffix, refCounts);

  // HappyHorse mode auto-correction. Unlike the standard referenceTabs (whose
  // mode lives in generationParams.referenceVariant and is auto-resolved by the
  // effect above), the HappyHorse mode is baked into the model-name suffix, so
  // nothing was keeping it consistent with the upstream refs: attaching a 垫图
  // while on 文生(t2v), or removing the last image while on 首帧(i2v), left the
  // node sitting in an illegal mode with the wrong tab still lit. When the
  // active suffix is no longer satisfiable, recompose the model to the first
  // suffix that IS — so 文生 only stays lit when there is no 垫图.
  useEffect(() => {
    if (!happyHorse || !happyHorseFamily) return;
    if (isHappyHorseSuffixSatisfied(happyHorse.suffix)) return;
    const avail = happyHorseFamily.suffixesByVersion.get(happyHorse.version) ?? new Set<string>();
    const order: Array<'t2v' | 'i2v' | 'r2v' | 'video-edit'> = ['t2v', 'i2v', 'r2v', 'video-edit'];
    const next = order.find((s) => avail.has(s) && isHappyHorseSuffixSatisfied(s));
    if (next && next !== happyHorse.suffix) {
      handleModelChange(composeHappyHorseModel(happyHorse.version, next));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [happyHorse?.suffix, happyHorse?.version, happyHorseFamily, refCounts.images, refCounts.videos]);

  // 收编模型列表给底部 Dropdown 用：非 HappyHorse 模型原样保留；HappyHorse
  // 折叠成每个版本一项 `HappyHorse X.Y`（虚拟值），点击时映射回真实模型名。
  // 真实变体的切换由顶部 happyHorseTabs 完成。
  const HAPPYHORSE_VIRTUAL_PREFIX = 'HappyHorse ';
  const isHappyHorseVirtual = (value: string) => value.startsWith(HAPPYHORSE_VIRTUAL_PREFIX);
  const displayModels = useMemo<string[]>(() => {
    const out: string[] = [];
    const seenVirtual = new Set<string>();
    for (const m of availableModels) {
      // 管理端标记为隐藏的模型：可被调用（超分等内部功能），不进选择列表。
      if (hiddenModels.has(m)) continue;
      const parsed = parseHappyHorseModel(m);
      if (parsed) {
        const v = `${HAPPYHORSE_VIRTUAL_PREFIX}${parsed.version}`;
        if (!seenVirtual.has(v)) {
          seenVirtual.add(v);
          out.push(v);
        }
        continue;
      }
      // 分辨率变体折叠：`X 4K` 这种「同名模型的型号」不单独占一行——
      // 基础名存在时隐藏变体，2K/4K 在参数面板的分辨率里选
      // （后端按 resolution 自动切换真实模型 id）。
      if (/ 4k$/i.test(m) && availableModels.includes(m.replace(/ 4k$/i, ''))) {
        continue;
      }
      out.push(m);
    }
    return out;
  }, [availableModels, hiddenModels]);

  // 当前底部 dropdown 应该选中的「显示值」：HappyHorse 系列收编成虚拟名；
  // ` 4K` 分辨率变体显示为基础名。
  const activeModelDisplay = happyHorse
    ? `${HAPPYHORSE_VIRTUAL_PREFIX}${happyHorse.version}`
    : (/ 4k$/i.test(activeModel) && availableModels.includes(activeModel.replace(/ 4k$/i, ''))
      ? activeModel.replace(/ 4k$/i, '')
      : activeModel);

  // 展示层名称：管理端「显示名称」优先，仅影响渲染，值仍是真实模型 id。
  const displayNameFor = (value: string) => modelDisplayNames.get(value) ?? value;

  // 折叠后点选：HappyHorse 虚拟项 → 默认 t2v；版本里若无 t2v（理论不会）
  // 退回该版本第一个可用后缀。其它模型原样转发到 handleModelChange。
  const handleDisplayPick = (display: string) => {
    if (isHappyHorseVirtual(display) && happyHorseFamily) {
      const ver = display.slice(HAPPYHORSE_VIRTUAL_PREFIX.length);
      const avail = happyHorseFamily.suffixesByVersion.get(ver);
      if (!avail) return;
      const suffix = avail.has('t2v')
        ? 't2v'
        : (avail.has('i2v') ? 'i2v' : Array.from(avail)[0]);
      handleModelChange(composeHappyHorseModel(ver, suffix));
      return;
    }
    handleModelChange(display);
  };

  // HappyHorse 顶部模式 tab strip：文生 / 首帧 / 参考生 / 视频编辑，
  // 替代标准 referenceTabs。点击直接切换真实模型名（保留 version）。
  // 门控：
  //   - t2v 不能有任何参考节点（有就禁用，提示用户先断开引用）
  //   - i2v（首帧）需要恰好 1 张图（作视频首帧，多于一张即禁用）
  //   - r2v 需要 1~9 张参考图（不接受视频）
  //   - video-edit 需要恰好 1 段源视频（+ 0~5 张参考图）
  // 不满足时点击不切换，弹一个 top-center toast 告诉用户为什么。
  const happyHorseTabs = (() => {
    if (!happyHorse || !happyHorseFamily) return null;
    const order: Array<'t2v' | 'i2v' | 'r2v' | 'video-edit'> = ['t2v', 'i2v', 'r2v', 'video-edit'];
    const avail = happyHorseFamily.suffixesByVersion.get(happyHorse.version) ?? new Set<string>();
    const visible = order.filter((s) => avail.has(s));
    return (
      <div className="mb-3 flex items-center gap-1 overflow-x-auto pb-0.5">
        {visible.map((suffix) => {
          const isActive = suffix === happyHorse.suffix;
          const labelMap = language === 'zh' ? HAPPYHORSE_SUFFIX_TO_MODE_ZH : HAPPYHORSE_SUFFIX_TO_MODE_EN;
          // Gating shares one source of truth with the auto-correction effect.
          const satisfied = isHappyHorseSuffixSatisfied(suffix);
          let hint = '';
          if (!satisfied) {
            if (suffix === 't2v') {
              hint = language === 'zh'
                ? '文生不接受参考节点，请先断开所有上游引用'
                : 'Text-to-video does not accept references; disconnect upstream first';
            } else if (suffix === 'i2v') {
              // 首帧 = 恰好 1 张图。区分「没有」与「多于一张」两种未满足原因。
              if (refCounts.videos > 0) {
                hint = language === 'zh'
                  ? '首帧模式不接受视频，请断开视频参考'
                  : 'First-frame mode does not accept video; disconnect the video reference';
              } else if (refCounts.images > 1) {
                hint = language === 'zh'
                  ? `首帧只能连接 1 张图片，当前有 ${refCounts.images} 张，请断开多余的`
                  : `First-frame takes exactly 1 image; you have ${refCounts.images}, disconnect the extras`;
              } else {
                hint = language === 'zh'
                  ? '首帧需要连接 1 张图片作为视频首帧'
                  : 'First-frame needs exactly 1 image as the video’s opening frame';
              }
            } else if (suffix === 'r2v') {
              // 1~9 图、不接受视频。区分：连了视频 / 超 9 张 / 没有图。
              if (refCounts.videos > 0) {
                hint = language === 'zh'
                  ? '参考生只接受参考图，请断开视频引用'
                  : 'Reference-to-video only accepts images; disconnect the video';
              } else if (refCounts.images > 9) {
                hint = language === 'zh'
                  ? `参考生最多 9 张参考图，当前有 ${refCounts.images} 张，请断开多余的`
                  : `Reference-to-video takes at most 9 images; you have ${refCounts.images}`;
              } else {
                hint = language === 'zh'
                  ? '参考生需要至少 1 张参考图，请先连接参考节点'
                  : 'Reference-to-video needs 1+ reference images; connect a reference first';
              }
            } else if (suffix === 'video-edit') {
              // 恰好 1 视频 + 0~5 图。区分：视频数不对 / 图超 5 张。
              if (refCounts.videos > 1) {
                hint = language === 'zh'
                  ? `视频编辑只支持 1 段源视频，当前有 ${refCounts.videos} 段`
                  : `Video edit takes exactly 1 source video; you have ${refCounts.videos}`;
              } else if (refCounts.images > 5) {
                hint = language === 'zh'
                  ? `视频编辑最多 5 张参考图，当前有 ${refCounts.images} 张`
                  : `Video edit takes at most 5 reference images; you have ${refCounts.images}`;
              } else {
                hint = language === 'zh'
                  ? '视频编辑需要 1 段源视频，请先连接一个视频节点'
                  : 'Video edit needs 1 source video; connect a video first';
              }
            }
          }
          return (
            <button
              key={suffix}
              type="button"
              title={satisfied ? undefined : hint}
              onClick={() => {
                if (!satisfied) {
                  toast.warning(hint, { id: `happyhorse-${suffix}`, duration: 2600 });
                  return;
                }
                handleModelChange(composeHappyHorseModel(happyHorse.version, suffix));
              }}
              className={clsx(
                'shrink-0 rounded-full px-3 py-1 text-xs transition',
                // Only light a tab when it is BOTH active and currently valid —
                // an active-but-unsatisfied mode (transient, or a model with no
                // satisfiable alternative) shows dimmed instead of lit.
                isActive && satisfied
                  ? 'bg-white/15 text-white ring-1 ring-white/30'
                  : satisfied
                    ? 'bg-white/[0.03] text-neutral-400 ring-1 ring-white/8 hover:bg-white/[0.06] hover:text-neutral-200'
                    : 'bg-white/[0.02] text-neutral-600 ring-1 ring-white/[0.04] hover:bg-white/[0.04]',
              )}
            >
              {labelMap[suffix]}
            </button>
          );
        })}
      </div>
    );
  })();

  const referenceTabs = modelReferenceModes.length ? (
    <div className="mb-3 flex items-center gap-1 overflow-x-auto pb-0.5">
      {modelReferenceModes.map((key) => {
        const spec = REFERENCE_MODE_SPECS[key];
        const isActive = key === activeReferenceMode;
        const satisfied = isModeSatisfied(key, refCounts);
        return (
          <button
            key={key}
            type="button"
            disabled={!satisfied}
            title={satisfied ? undefined : (language === 'zh' ? spec.disabledHint.zh : spec.disabledHint.en)}
            onClick={() => {
              if (!satisfied) return;
              updateNodeGenerationParams(nodeId, { referenceVariant: key });
            }}
            className={clsx(
              'shrink-0 rounded-full px-3 py-1 text-xs transition',
              isActive
                ? 'bg-white/15 text-white ring-1 ring-white/30'
                : satisfied
                  ? 'bg-white/[0.03] text-neutral-400 ring-1 ring-white/8 hover:bg-white/[0.06] hover:text-neutral-200'
                  : 'cursor-not-allowed bg-white/[0.02] text-neutral-600 ring-1 ring-white/[0.04]',
            )}
          >
            {language === 'zh' ? spec.label.zh : spec.label.en}
          </button>
        );
      })}
    </div>
  ) : null;

  /** Confirm handler for the asset picker. Two sources flow in:
   *  - source: 'history' → spawn a reference node + connect upstream
   *  - source: 'canvas'  → just connect the existing node upstream
   *    (no node duplication; the original lives once on the canvas)
   *  Both paths use the same edge creation, keeping the generation
   *  pipeline blind to where the reference came from. */
  const handlePickerConfirm = useCallback((picked: PickedAsset[]) => {
    if (!picked.length) return;
    const self = allNodes.find((n) => n.id === nodeId);
    const base = self?.position ?? { x: 0, y: 0 };
    picked.forEach((item, index) => {
      if (item.source === 'canvas') {
        // Resolve the actual node id from the synthetic picker id.
        const rawId = item.id.replace(/^canvas-/, '');
        if (!rawId || rawId === nodeId) return;
        // Skip if an edge already exists between rawId → this node.
        if (allNodes.length && edges.some((edge) => edge.source === rawId && edge.target === nodeId)) return;
        onConnect({ source: rawId, target: nodeId, sourceHandle: null, targetHandle: null } as never);
        return;
      }
      // History source: materialise a reference node next to ourselves.
      if (!item.url) return;
      const refId = `ref-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 4)}`;
      const isVideo = item.kind === 'video';
      addNode({
        id: refId,
        type: isVideo ? 'referenceVideoNode' : 'referenceImageNode',
        position: { x: base.x - 340, y: base.y + index * 60 },
        data: { url: item.url, status: 'done', sourceName: item.title },
      } as never);
      onConnect({ source: refId, target: nodeId, sourceHandle: null, targetHandle: null } as never);
    });
    setPickerOpen(false);
  }, [addNode, allNodes, edges, nodeId, onConnect]);

  // Named slots for the active reference mode. When the mode defines
  // slots (e.g. 首帧 / 尾帧 for first-last), each thumbnail in order gets
  // its slot label underneath; extra thumbnails beyond the named slots
  // fall back to a numeric index. Modes with no slots (multi-image,
  // all-in-one) keep the plain numbered badges.
  const activeModeSlots = activeReferenceMode
    ? REFERENCE_MODE_SPECS[activeReferenceMode].slots
    : [];

  // Preview strip above the textarea: each upstream node renders as a
  // square thumbnail with a numbered badge in the corner. Hovering shows
  // a delete X that removes the EDGE (the upstream node itself stays on
  // canvas). Trailing dashed `+` slot opens the asset picker.

  // 当前模式的参考数量上限（注册表模式 / HappyHorse 模式二选一），驱动参考条
  // 下方的「图片 ≤ N」提示与超限红字。
  const activeRequires = happyHorse?.suffix
    ? HAPPYHORSE_SUFFIX_REQUIRES[happyHorse.suffix] ?? null
    : activeReferenceMode
      ? REFERENCE_MODE_SPECS[activeReferenceMode].requires
      : null;

  const refLimitBar = (() => {
    if (upstreamNodes.length === 0 || !activeRequires) return null;
    const zh = language === 'zh';
    const chips: string[] = [];
    if (activeRequires.images.max > 0) chips.push(zh ? `图片 ≤ ${activeRequires.images.max}` : `Images ≤ ${activeRequires.images.max}`);
    if (activeRequires.videos.max > 0) chips.push(zh ? `视频 ≤ ${activeRequires.videos.max}` : `Videos ≤ ${activeRequires.videos.max}`);
    const warnings: string[] = [];
    if (refCounts.images > activeRequires.images.max) {
      warnings.push(activeRequires.images.max === 0
        ? (zh ? '当前模式不支持图片参考' : 'This mode takes no image references')
        : (zh ? `当前模型图片最多 ${activeRequires.images.max} 张，现在 ${refCounts.images} 张` : `At most ${activeRequires.images.max} images; you have ${refCounts.images}`));
    }
    if (refCounts.videos > activeRequires.videos.max) {
      warnings.push(activeRequires.videos.max === 0
        ? (zh ? '当前模式不支持视频参考' : 'This mode takes no video references')
        : (zh ? `当前模型视频最多 ${activeRequires.videos.max} 段，现在 ${refCounts.videos} 段` : `At most ${activeRequires.videos.max} videos; you have ${refCounts.videos}`));
    }
    if (chips.length === 0 && warnings.length === 0) return null;
    return (
      <div className="mb-2 flex flex-wrap items-center justify-end gap-1.5 px-1">
        {chips.map((chip) => (
          <span key={chip} className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-neutral-400">{chip}</span>
        ))}
        {warnings.map((warning) => (
          <span key={warning} className="rounded-md bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-300">{warning}</span>
        ))}
      </div>
    );
  })();

  const previewStrip = (
    <>
    <div className="prompt-editor-scroll mb-1 flex items-start gap-2 overflow-x-auto px-1 py-2">
      {upstreamNodes.map((up, idx) => {
        const tag = `@${up.id.slice(-4)}`;
        const matched = mentions.find((m) => m.id === up.id);
        const isUsed = Boolean(matched);
        const slot = activeModeSlots[idx];
        const slotLabel = slot ? (language === 'zh' ? slot.zh : slot.en) : '';
        return (
          <div
            key={up.edgeId}
            className="group/ref relative shrink-0 flex flex-col items-center gap-1"
            title={isUsed ? `已引用 · ${matched?.tag ?? tag}` : `未引用 · 输入 ${tag} 即可引用`}
            onMouseEnter={(event) => showRefHover(up.id, event.currentTarget.getBoundingClientRect())}
            onMouseLeave={scheduleRefHoverClear}
          >
            <div className="relative">
              {up.thumb ? (
                <img
                  src={up.thumb}
                  alt=""
                  className={clsx(
                    'h-12 w-12 rounded-lg object-cover transition',
                    isUsed ? 'ring-2 ring-cyan-400/50' : 'opacity-80',
                  )}
                  draggable={false}
                />
              ) : up.kind === 'audio' ? (
                /* 音频引用卡 — 深色底 + 音符 + 「音频 N」（参考样式）。 */
                <div
                  className={clsx(
                    'flex h-12 w-12 flex-col items-center justify-center gap-1 rounded-lg bg-white/[0.06] transition',
                    isUsed && 'ring-2 ring-cyan-400/50',
                  )}
                >
                  <Music className="h-4 w-4 text-emerald-400" />
                  <span className="max-w-[44px] truncate text-[8px] leading-none text-neutral-300">{up.label}</span>
                </div>
              ) : (
                <div
                  className={clsx(
                    'flex h-12 w-12 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400 transition',
                    isUsed && 'ring-2 ring-cyan-400/50',
                  )}
                >
                  {up.icon}
                </div>
              )}
              {/* Index badge — hidden when the delete button is visible. */}
              <div className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-black/85 px-1 text-[10px] font-medium text-white shadow group-hover/ref:opacity-0">
                {up.index}
              </div>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdgesChange([{ id: up.edgeId, type: 'remove' }] as never);
                }}
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-white opacity-0 shadow transition group-hover/ref:opacity-100 hover:bg-rose-400"
                title={language === 'zh' ? '移除引用' : 'Disconnect reference'}
              >
                <X className="h-2.5 w-2.5" strokeWidth={3} />
              </button>
            </div>
            {slotLabel ? (
              <span className={clsx('max-w-[52px] truncate text-[9px]', slot?.optional ? 'text-neutral-500' : 'text-neutral-300')}>
                {slotLabel}
              </span>
            ) : null}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="shrink-0 flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-white/15 bg-white/[0.02] text-neutral-400 transition hover:border-white/30 hover:bg-white/[0.05] hover:text-neutral-200"
        title={language === 'zh' ? '从素材库添加引用' : 'Add reference from library'}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
    {refLimitBar}
    </>
  );

  const renderPromptEditor = (expandedMode = false) => {
    const overlayRef = expandedMode ? expandedOverlayRef : compactOverlayRef;
    // 紧凑态高度由 editorHeight 状态驱动（内容自适应，见 useLayoutEffect）；
    // 展开弹窗仍然填满列（flex-1）。镜像层是 inset-0，跟着 textarea 的
    // 高度走，不需要单独定高。
    const heightClass = expandedMode ? 'flex-1' : '';
    const paddingClass = expandedMode ? 'px-4 py-4' : 'px-3 py-3';

    return (
      <div className={clsx('relative rounded-xl', expandedMode && 'flex-1 flex flex-col')}>
        <div
          ref={overlayRef}
          className={clsx(
            // 必须和 textarea 用同款滚动容器（prompt-editor-scroll + overflow-auto）：
            // 内容超高时 textarea 的滚动条会挤窄内容宽度，若镜像层没有同样的
            // 滚动条，两边折行点错开 — 看到的字和真实光标就对不上了。
            // text-neutral-100:提示词整体更亮更清晰(仅颜色,不动字重以免镜像错位)。
            'prompt-editor-scroll pointer-events-none absolute inset-0 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-100',
            heightClass,
            paddingClass,
          )}
          aria-hidden
        >
          {text ? renderMentionRichText(text, mentions) : (
            <span className="text-neutral-500">
              {language === 'zh' ? '描述你想要生成的画面内容，按/呼出指令' : 'Describe what you want to generate, press / for commands'}
            </span>
          )}
        </div>
        <textarea
          ref={taRef}
          value={text}
          onFocus={(event) => {
            taRef.current = event.currentTarget;
          }}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onMouseMove={(event) => hitTestMentionHover(event, overlayRef.current)}
          onMouseLeave={scheduleRefHoverClear}
          onScroll={(event) => syncOverlayScroll(event.currentTarget, overlayRef.current)}
          // Keep wheel inside the textarea — without this, ReactFlow grabs
          // the wheel event and zooms the canvas instead of scrolling the
          // prompt. stopPropagation is enough; the browser still applies
          // its default scroll to the textarea.
          onWheel={(event) => event.stopPropagation()}
          className={clsx(
            // whitespace/break 规则与镜像层严格一致，否则折行不同步。
            'prompt-editor-scroll relative block w-full resize-none overflow-auto whitespace-pre-wrap break-words bg-transparent text-[13px] leading-relaxed text-transparent caret-neutral-200 focus:outline-none',
            expandedMode ? 'flex-1' : '',
            paddingClass,
          )}
          style={expandedMode ? { caretColor: '#e5e5e5' } : { caretColor: '#e5e5e5', height: editorHeight }}
        />
        {mentionOpen && upstreamNodes.length > 0 ? (
          <div
            className="absolute z-30 w-[220px] rounded-xl border border-white/10 bg-[#1a1d22]/95 py-1.5 shadow-2xl backdrop-blur-xl"
            style={mentionPos ? { left: mentionPos.left, top: mentionPos.top } : { left: 12, top: 32 }}
          >
            {upstreamNodes.map((up) => (
              <button
                key={up.id}
                onClick={() => insertMention(up)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-neutral-300 transition hover:bg-white/5"
              >
                {up.thumb ? (
                  <img src={toRenderableMediaUrl(up.thumb)} alt="" className="h-8 w-8 rounded-md object-cover border border-white/10 flex-shrink-0" />
                ) : up.kind === 'audio' ? (
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-white/[0.06] flex-shrink-0">
                    <Music className="h-3.5 w-3.5 text-emerald-400" />
                  </span>
                ) : (
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-white/[0.06] text-sm flex-shrink-0">{up.icon}</span>
                )}
                <span className="text-neutral-200">{up.label}</span>
                <span className="ml-auto text-[10px] text-neutral-600">(@{up.id.slice(-4)})</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const bottomControls = (
    <div className="relative z-50 mt-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-1 min-w-0">
        {/* 模型 dropdown：HappyHorse 系列折叠成一行/版本（虚拟值），
            点击映射回真实模型；其余厂商模型原样展示。
            模式（文生/图生/参考生/视频编辑）由顶部 happyHorseTabs 处理，
            不再单独占一个底栏 dropdown。 */}
        <Dropdown
          label={<ModelBrandIcon model={activeModel} vendor={activeConfig?.vendor} providerName={activeConfig?.name} iconKey={activeConfig?.icon_key} iconUrl={activeConfig?.icon_url} size={14} />}
          value={displayNameFor(activeModelDisplay)}
          options={displayModels}
          onChange={handleDisplayPick}
          menuMinWidth={240}
          renderOption={(option, selected) => {
            // HappyHorse 虚拟项不去查 enabledConfigs（不是真实 model 名），
            // 但需要找到任一真实变体来取 icon / vendor 信息。
            const lookupModel = isHappyHorseVirtual(option)
              ? availableModels.find((m) => {
                  const p = parseHappyHorseModel(m);
                  return p && `${HAPPYHORSE_VIRTUAL_PREFIX}${p.version}` === option;
                }) ?? option
              : option;
            const optionConfig = enabledConfigs.find((config) => config.modelList.includes(lookupModel))?.raw ?? null;
            const optTemplate = getModelTemplate(lookupModel, optionConfig);
            const dur = optTemplate?.durationRange?.defaultValue
              ?? optTemplate?.durationOptions?.[0];
            return (
              <div className="flex w-full items-center gap-2">
                <ModelBrandIcon model={lookupModel} vendor={optionConfig?.vendor} providerName={optionConfig?.name} iconKey={optionConfig?.icon_key} iconUrl={optionConfig?.icon_url} size={18} />
                <span className={clsx('flex-1 truncate', selected ? 'text-cyan-300' : 'text-neutral-200')}>{displayNameFor(option)}</span>
                {dur ? <span className="shrink-0 text-[10px] text-neutral-500">{dur}s</span> : null}
              </div>
            );
          }}
        />
        {!happyHorse && template?.supportsMode && template.modeOptions?.length ? (
          <Dropdown
            value={currentMode}
            options={template.modeOptions}
            onChange={(value) => updateNodeGenerationParams(nodeId, { mode: value })}
          />
        ) : null}
        {template && (template.supportsResolution || template.supportsQuality || template.supportsAspectRatio || template.supportsAutoAspect || template.supportsDuration || template.supportsOutputFormat) ? (
          <MediaParamsPopover
            template={template}
            resolution={currentResolution}
            quality={currentQuality}
            aspectRatio={currentAspectRatio}
            duration={currentDuration}
            outputFormat={currentOutputFormat}
            onResolution={(value) => updateNodeGenerationParams(nodeId, { resolution: value })}
            onQuality={(value) => updateNodeGenerationParams(nodeId, { quality: value })}
            onAspectRatio={(value) => updateNodeGenerationParams(nodeId, { aspectRatio: value })}
            onDuration={(value) => updateNodeGenerationParams(nodeId, { durationSeconds: value })}
            onOutputFormat={(value) => updateNodeGenerationParams(nodeId, { outputFormat: value })}
            audioSetting={currentAudioSetting}
            seed={currentSeed}
            onAudioSetting={(value) => updateNodeGenerationParams(nodeId, { audioSetting: value })}
            onSeed={(value) => updateNodeGenerationParams(nodeId, { seed: value })}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <div
          className="nodrag nopan flex items-center gap-0.5 text-[11px] font-medium text-amber-300/90"
          title={language === 'zh' ? '本次生成预计消耗的积分' : 'Credits this generation will cost'}
        >
          <Zap className="h-3 w-3" />
          <span className="tabular-nums">{creditCost}</span>
        </div>
        <button
          type="button"
          disabled={isBusy}
          title={isBusy ? (language === 'zh' ? '生成中…' : 'Generating…') : undefined}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            submit();
          }}
          className={clsx(
            'nodrag nopan flex h-8 w-8 items-center justify-center rounded-full border transition',
            isBusy
              ? 'cursor-not-allowed border-white/10 bg-white/5 text-neutral-400'
              // 参考风格：中性石墨圆钮，不再用青色。
              : 'border-white/15 bg-white/15 text-neutral-100 hover:bg-white/25',
          )}
        >
          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Anchor stays in normal flow but contributes no extra width — the
          actual panel below is absolutely-positioned and counter-scaled so
          it renders at fixed screen size regardless of canvas zoom.
          The gap below the node is set in SCREEN pixels (divided by zoom
          so the gap is constant on screen at any zoom level). The
          transform-origin of `top center` keeps the panel anchored to the
          node's bottom-center as it scales. */}
      <div className="relative" style={{ height: 0, marginTop: `${16 * inverseZoom}px` }}>
        <div
          className="absolute left-1/2 top-0 z-20 w-[640px] rounded-[20px] border border-white/8 bg-[#26272b]/97 px-5 py-4 shadow-[0_24px_70px_-28px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur-2xl nodrag"
          style={{
            transform: `translateX(-50%) scale(${inverseZoom})`,
            transformOrigin: 'top center',
          }}
        >
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="absolute right-4 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
            title="放大"
          >
            <Expand className="h-3.5 w-3.5" />
          </button>
          {happyHorseTabs ?? referenceTabs}
          {previewStrip}
          {renderPromptEditor(false)}
          {bottomControls}
        </div>
      </div>
      {expanded ? createPortal(
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <div
            className="relative flex h-[80vh] w-[52vw] min-w-[720px] max-w-[92vw] flex-col rounded-[16px] border border-white/10 bg-[#1a1d22]/96 px-6 py-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="absolute right-5 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
            >
              <X className="h-4 w-4" />
            </button>
            {happyHorseTabs ?? referenceTabs}
            {previewStrip}
            {renderPromptEditor(true)}
            {bottomControls}
          </div>
        </div>,
        document.body,
      ) : null}
      {/* 引用悬停预览 —— 只渲染一份(紧凑/展开两个 strip 共享状态)。 */}
      {(() => {
        if (!refHover) return null;
        const up = upstreamNodes.find((u) => u.id === refHover.id);
        if (!up) return null;
        return (
          <RefHoverPreview
            up={up}
            left={refHover.left}
            top={refHover.top}
            onEnter={cancelRefHoverClear}
            onLeave={scheduleRefHoverClear}
          />
        );
      })()}
      <AssetPickerModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConfirm={handlePickerConfirm}
      />
    </>
  );
};

/** Counter-scales the selected node's floating toolbar to constant screen size.
 *  Split out of BaseNode so useViewport() only subscribes THIS tiny component
 *  (mounted for the one selected node) to pan/zoom — previously every mounted
 *  node re-rendered on every viewport change, making panning as heavy as
 *  dragging. */
function TopFloatingPanelScaler({ children }: { children: React.ReactNode }) {
  const viewport = useViewport();
  const inverseZoom = 1 / (viewport.zoom || 1);
  return (
    <div className="absolute left-1/2 top-0 z-30" style={{ height: 0, width: 0 }}>
      <div
        className="pointer-events-auto pb-3"
        style={{
          width: 'max-content',
          whiteSpace: 'nowrap',
          transform: `translate(-50%, -100%) scale(${inverseZoom})`,
          transformOrigin: 'bottom center',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const BaseNode = ({
  icon: Icon,
  title,
  headerRight,
  children,
  floatingPanel,
  topFloatingPanel,
  selected,
  promptPanel,
  loading,
  loadingNodeId,
  loadingOverlay,
  error,
  tone = 'neutral',
  width,
  shellBackground,
  smoothResize,
}: {
  icon: any;
  title: React.ReactNode;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  floatingPanel?: React.ReactNode;
  topFloatingPanel?: React.ReactNode;
  selected?: boolean;
  promptPanel?: React.ReactNode;
  loading?: boolean;
  loadingNodeId?: string;
  loadingOverlay?: React.ReactNode;
  error?: string;
  tone?: keyof typeof NODE_TONE_STYLES;
  /** Explicit node width (px). Media nodes size to their aspect ratio; other
   *  nodes omit this and fall back to the default 300px. */
  width?: number;
  /** Optional override for the media/content shell background (e.g. the text
   *  node's user-picked background color). Inline style beats the tone class. */
  shellBackground?: string;
  /** 切换宽高比等参数导致 width 变化时平滑过渡（媒体节点用）。默认关闭，
   *  避免给交互式改宽（如文本节点）加上迟滞感。 */
  smoothResize?: boolean;
}) => {
  const toneStyles = NODE_TONE_STYLES[tone];
  const isConnectionDragging = useStore((state) => state.isConnectionDragging);
  const multiSelectActive = useStore((state) => state.nodes.filter((node) => node.selected).length > 1);
  // The quick-connect `+` bubbles only show on hover / sole-selection; gate the
  // magnet effect to those states so the global mousemove listeners aren't
  // attached for every off-screen node's bubbles. An ENGAGED pull also keeps
  // the gate open (and the bubble visible): the magnet radius extends well
  // beyond the card, so cursor-leaves-card must not kill an active pull.
  const [hovered, setHovered] = useState(false);
  const [leftPull, setLeftPull] = useState(false);
  const [rightPull, setRightPull] = useState(false);
  const magnetDisabled = !hovered && !(selected && !multiSelectActive) && !leftPull && !rightPull;
  // While a connection is being dragged AND the pointer is over this node, it is
  // the drop target — pulse it (the full-area target handle lets the wire land
  // anywhere on the card).
  const connectTarget = isConnectionDragging && hovered;

  // Pulse the shell when a long-running generation completes — bridges the
  // gap between "loader spinning" and "the output is just sitting there",
  // so the user notices the new content. Fires only on the true→false edge.
  const shellRef = useRef<HTMLDivElement>(null);

  // Tilted-card effect (React Bits "TiltedCard", dependency-free like our
  // Magnet/Dock ports): while this node is the CONNECT TARGET of a wire drag,
  // the shell tilts toward the cursor in 3D — tactile "drop it here" feedback.
  // Window-level mousemove (React Flow's drag owns the pointer stream) scoped
  // to the one node that is currently the target.
  const [tilt, setTilt] = useState<{ rx: number; ry: number } | null>(null);
  useEffect(() => {
    if (!connectTarget) {
      setTilt(null);
      return;
    }
    const TILT_AMPLITUDE = 14; // degrees at the card edge (React Bits default)
    const onMove = (event: MouseEvent) => {
      const el = shellRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const offsetX = (event.clientX - rect.left) / rect.width - 0.5;
      const offsetY = (event.clientY - rect.top) / rect.height - 0.5;
      setTilt({
        rx: -offsetY * 2 * TILT_AMPLITUDE,
        ry: offsetX * 2 * TILT_AMPLITUDE,
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      setTilt(null);
    };
  }, [connectTarget]);
  const prevLoading = useRef(loading);
  useEffect(() => {
    if (prevLoading.current && !loading && shellRef.current) {
      const tl = gsap.timeline();
      tl.fromTo(
        shellRef.current,
        { boxShadow: '0 0 0 0 rgba(34,211,238,0.0)', scale: 1 },
        {
          boxShadow: '0 0 24px 4px rgba(34,211,238,0.35)',
          scale: 1.012,
          duration: 0.22,
          ease: 'power2.out',
        },
      ).to(shellRef.current, {
        boxShadow: '0 0 0 0 rgba(34,211,238,0.0)',
        scale: 1,
        duration: 0.55,
        ease: 'power2.inOut',
      });
    }
    prevLoading.current = loading;
  }, [loading]);

  return (
    <div
      className={clsx('group', smoothResize && 'transition-[width] duration-300 ease-out motion-reduce:transition-none')}
      style={{ width: width ?? 300 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {selected && !multiSelectActive && topFloatingPanel ? (
        <TopFloatingPanelScaler>{topFloatingPanel}</TopFloatingPanelScaler>
      ) : null}
      {/* Name label ABOVE the media (top-left, outside the frame) — the media
          below is a borderless full-bleed card ("全面屏"). */}
      <div className={clsx(
        'mb-1.5 flex items-center justify-between gap-3 text-[11.5px]',
        selected ? 'text-white' : 'text-neutral-100',
      )}>
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className={clsx('h-3.5 w-3.5 shrink-0', selected ? 'text-neutral-100' : 'text-neutral-300')} />
          <div className="min-w-0 truncate font-medium tracking-wide">{title}</div>
        </div>
        {headerRight ? <div className="shrink-0 text-[10px] text-neutral-400">{headerRight}</div> : null}
      </div>

      <div className="relative">
        <div
          ref={shellRef}
          className={clsx(
            // Borderless full-bleed media: the node IS the media, no outer frame.
            'relative overflow-hidden rounded-[14px] text-neutral-100 transition-shadow duration-150',
            toneStyles.shell,
            selected && toneStyles.selected,
            connectTarget && 'node-connect-target',
          )}
          style={{
            ...(shellBackground ? { background: shellBackground } : null),
            // TiltedCard: 3D tilt toward the cursor while a wire hovers this
            // card as its drop target; springs back on leave/drop. The eased
            // transform transition doubles as the spring smoothing.
            ...(tilt
              ? { transform: `perspective(800px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) scale(1.045)` }
              : null),
            transition: 'transform 0.22s ease-out, box-shadow 0.15s ease',
            willChange: connectTarget ? 'transform' : undefined,
          }}
          >
          <div>{children}</div>
          {error ? <NodeErrorBanner error={error} /> : null}
          {/* 统一生成动画：所有媒体节点默认走 GenerationOverlay（水位进度 +
              阶段徽章）；loadingOverlay 仍可覆盖特殊场景。 */}
          {loading ? (loadingOverlay ?? (loadingNodeId ? <GenerationOverlay nodeId={loadingNodeId} /> : null)) : null}
        </div>
        {/* 等待计时挂在边框外右上方（shell 是 overflow-hidden，画不出去）。 */}
        {loading && loadingNodeId ? <GenerationTimerBadge nodeId={loadingNodeId} /> : null}

        <Handle
          type="target"
          position={Position.Left}
          className="!left-0 !top-0 !h-full !w-full !cursor-default !rounded-[14px] !border-0 !bg-transparent !opacity-0"
          style={{ transform: 'none', pointerEvents: isConnectionDragging ? 'auto' : 'none' }}
        />
        {/* Flush render anchors. A FINISHED wire is drawn to these — they sit
            exactly ON the node's right/left edge (vertical center), courtesy of
            React Flow's default Position.Right/Left placement — so a connected
            edge reads as joined to the node, not to the floating `+` bubble that
            hovers ~20px outside. Pure 1px position anchors: pointer-events none
            so they never steal a drag; the visible `+` bubbles below remain the
            grab points, which is why a wire is still PULLED from the `+`. */}
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
        {/* Four-way quick-connect. Each side gets a source Handle (drag to
            connect) wrapping a `+` bubble that, on click, spawns a default
            downstream node in that direction and links it. Existing edges
            persisted with `sourceHandle: null` continue to resolve through
            the first matching source — keeping the right side first
            preserves legacy behavior. Bubbles fade in on hover OR when the
            node is the sole selection. */}
        {/* Left + handle — a real target so users can drop incoming
            connections explicitly on the input port. The full-area target
            handle above still catches drops anywhere on the card, so this
            small visible port is purely additive. */}
        {/* Each bubble: a static ANCHOR div marks the resting spot; the Magnet's
            moving layer carries the REAL React Flow Handle, so wherever the
            bubble is pulled, pressing the mouse starts a wire drag right there —
            no need to travel back to the resting spot. Anchor is pointer-events
            none (an empty resting spot must not eat pane clicks); the Handle
            re-enables its own pointer events. */}
        <div
          className={clsx(
            'pointer-events-none absolute -left-8 top-1/2 z-10 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100',
            (leftPull || (selected && !multiSelectActive)) && 'opacity-100',
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
        <div
          className={clsx(
            'pointer-events-none absolute -right-8 top-1/2 z-10 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100',
            (rightPull || (selected && !multiSelectActive)) && 'opacity-100',
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

      {floatingPanel}
      {selected && !multiSelectActive ? promptPanel : null}
    </div>
  );
};

/** User-facing error banner. Shows a short summary; full message is hidden behind a "详情" toggle
 *  and logged to the console so it remains accessible for admin/debugging. */
function NodeErrorBanner({ error }: { error: string }) {
  const language = useStore((state) => state.language);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (error) console.error('[NodeError]', error);
  }, [error]);

  // Map common backend/browser errors to friendly summaries.
  const summary = (() => {
    const e = error.toLowerCase();
    const looksLikeLocalStorageQuota =
      e.includes('quotaexceeded')
      || e.includes('localstorage')
      || e.includes('local storage')
      || e.includes('failed to execute') && e.includes('setitem')
      || e.includes('dom exception') && e.includes('quota');
    if (looksLikeLocalStorageQuota) return language === 'zh' ? '本地存储已满，画布已成功生成但未能保存到本地。' : 'Local storage full; generated, not saved locally.';
    if (e.includes('quota')) return language === 'zh' ? '服务额度或配额不足，请联系管理员检查账户额度。' : 'Service quota exceeded — contact admin.';
    if (e.includes('invalid token') || e.includes('unauthorized')) return language === 'zh' ? '模型授权失败，请联系管理员检查 API token。' : 'Model auth failed — contact admin.';
    if (e.includes('timeout') || e.includes('timed out')) return language === 'zh' ? '请求超时，请稍后重试。' : 'Request timed out — please retry.';
    if (e.includes('queued task failed')) return language === 'zh' ? '队列任务失败，已停止生成，不会重复提交。' : 'Queued task failed; generation stopped and was not resubmitted.';
    if (e.includes('network')) return language === 'zh' ? '网络错误，请检查连接后重试。' : 'Network error — please retry.';
    if (e.includes('rate') && e.includes('limit')) return language === 'zh' ? '请求过于频繁，请稍后重试。' : 'Rate limited — please slow down.';
    if (e.includes('422') || e.includes('validation') || e.includes('minlength') || e.includes('required')) {
      if (e.includes('prompt')) return language === 'zh' ? '提示词不能为空，请填写描述后重试。' : 'Prompt is required.';
      return language === 'zh' ? '请求参数有误，请检查后重试。' : 'Invalid request parameters.';
    }
    // Upstream HTTP errors surfaced by readProviderError (e.g. "Provider HTTP 401: ...")
    if (e.includes('provider http')) {
      const m = error.match(/Provider HTTP (\d{3})/i);
      const status = m ? Number(m[1]) : 0;
      if (status === 401 || status === 403) return language === 'zh' ? '上游模型授权失败（401/403），请联系管理员检查 API key。' : 'Upstream auth failed — contact admin.';
      if (status === 402)                   return language === 'zh' ? '上游账户余额不足（402），请联系管理员充值。' : 'Upstream credit insufficient.';
      if (status === 404)                   return language === 'zh' ? '上游模型不存在（404），请检查模型名称是否正确。' : 'Upstream model not found.';
      if (status === 429)                   return language === 'zh' ? '上游请求过于频繁（429），请稍后重试。' : 'Upstream rate limited.';
      if (status === 408 || e.includes('timeout')) return language === 'zh' ? '上游请求超时，请稍后重试。' : 'Upstream timeout.';
      if (status >= 500)                    return language === 'zh' ? '上游模型服务异常，请稍后重试。' : 'Upstream server error.';
      return language === 'zh' ? '上游模型返回错误，详情见展开。' : 'Upstream returned an error.';
    }
    return language === 'zh' ? '生成失败，请稍后重试。' : 'Generation failed — please retry.';
  })();

  const copyDetail = () => { try { navigator.clipboard?.writeText(error); } catch { /* ignore */ } };

  return (
    // Full-coverage overlay over the node shell — replaces the empty
    // placeholder with the error summary and a 详情 toggle. Layered as
    // `absolute inset-0` so it covers any child preview as well; clicks
    // bubble normally to the inner buttons. Centered icon + label like a
    // toast, expandable detail panel below.
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-[inherit] bg-rose-950/55 px-4 py-3 text-rose-100 backdrop-blur-md">
      <div className="flex items-center gap-2 text-xs font-medium">
        <ImageOff className="h-4 w-4 text-rose-300" />
        <span className="break-words text-center">{summary}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[11px] text-rose-100 transition hover:bg-white/[0.12]"
        >
          {expanded ? (language === 'zh' ? '收起' : 'Hide') : (language === 'zh' ? '详情' : 'Details')}
        </button>
        {expanded ? (
          <button
            type="button"
            onClick={copyDetail}
            className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[11px] text-rose-100 transition hover:bg-white/[0.12]"
          >
            {language === 'zh' ? '复制' : 'Copy'}
          </button>
        ) : null}
      </div>
      {expanded ? (
        <pre className="prompt-editor-scroll max-h-[120px] w-full overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 text-[10px] text-rose-100/80">
          {error}
        </pre>
      ) : null}
    </div>
  );
}

const PreviewModal = ({ kind, src, onClose }: { kind: 'image' | 'video'; src: string; onClose: () => void }) => {
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // ESC to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Scroll to zoom (image only).
  const onWheel = (e: React.WheelEvent) => {
    if (kind !== 'image') return;
    e.stopPropagation();
    setZoom((z) => Math.min(5, Math.max(0.2, z - e.deltaY * 0.001)));
  };

  // Drag to pan (image only).
  const onPointerDown = (e: React.PointerEvent) => {
    if (kind !== 'image') return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setPos((p) => ({ x: p.x + e.clientX - lastPos.current.x, y: p.y + e.clientY - lastPos.current.y }));
    lastPos.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = () => { dragging.current = false; };

  const handleDownload = () => {
    void downloadAsset(src, kind === 'image' ? 'generated-image.png' : 'generated-video.mp4');
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/90 backdrop-blur-md"
      onClick={onClose}
      onWheel={onWheel}
    >
      {/* Top-right toolbar */}
      <div className="absolute right-5 top-5 z-10 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {kind === 'image' && (
          <>
            <button onClick={() => setZoom((z) => Math.min(5, z + 0.3))} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs text-white hover:bg-white/20">+</button>
            <button onClick={() => { setZoom(1); setPos({ x: 0, y: 0 }); }} className="flex h-8 items-center rounded-full bg-white/10 px-2.5 text-[10px] text-white/70 hover:bg-white/20">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom((z) => Math.max(0.2, z - 0.3))} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs text-white hover:bg-white/20">-</button>
          </>
        )}
        <button onClick={handleDownload} className="flex h-8 items-center gap-1 rounded-full bg-white/10 px-3 text-[10px] text-white/70 hover:bg-white/20">下载</button>
        <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div
        className={clsx('max-h-[92vh] max-w-[92vw]', kind === 'image' && 'cursor-grab active:cursor-grabbing')}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => { setZoom(zoom === 1 ? 2 : 1); setPos({ x: 0, y: 0 }); }}
      >
        {kind === 'image' ? (
          <img
            src={toRenderableMediaUrl(src)}
            alt=""
            draggable={false}
            className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain shadow-2xl select-none transition-transform duration-150"
            style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})` }}
          />
        ) : (
          <video src={toRenderableMediaUrl(src)} controls autoPlay className="max-h-[92vh] max-w-[92vw] rounded-lg shadow-2xl" />
        )}
      </div>
    </div>,
    document.body,
  );
};

type ImageActionKind = 'panorama' | 'angles' | 'lighting' | 'grid-compose' | 'enhance' | 'split' | 'edit';

type ImageActionDraft = {
  prompt: string;
  model?: string;
  anglePreset?: string;
  angleYaw?: number;
  anglePitch?: number;
  angleZoom?: number;
  anglePromptEnabled?: boolean;
  lightingPreset?: string;
  lightingLights?: StudioLight[];
  lightingSelectedId?: string;
  gridPreset?: string;
  expandDirection?: string;
  outputCount?: number;
  referenceImages?: string[];
  maskImage?: string;
  splitRows?: number;
  splitCols?: number;
};

// Wraps an in-flight image action with its draft + dialog open state.
type ImageActionSession = {
  action: ImageActionKind;
  draft: ImageActionDraft;
  open: boolean;
  compareOpen: boolean;
};

const GRID_COMPOSE_PRESETS = [
  { id: '4', labelZh: '4宫格 (2×2)', labelEn: '4 grid (2×2)', value: '2x2' },
  { id: '9', labelZh: '9宫格 (3×3)', labelEn: '9 grid (3×3)', value: '3x3' },
  { id: '16', labelZh: '16宫格 (4×4)', labelEn: '16 grid (4×4)', value: '4x4' },
  { id: '25', labelZh: '25宫格 (5×5)', labelEn: '25 grid (5×5)', value: '5x5' },
];

const GRID_SPLIT_PRESETS = GRID_COMPOSE_PRESETS;

function buildAngleEditorPrompt(draft: ImageActionDraft, language: string) {
  const yaw = Math.round(draft.angleYaw ?? 0);
  const pitch = Math.round(draft.anglePitch ?? 0);
  const zoom = Math.round(draft.angleZoom ?? 50);
  const preset = ANGLE_STUDIO_PRESETS.find((item) => item.id === draft.anglePreset);
  const presetLabel = preset ? (language === 'zh' ? preset.labelZh : preset.labelEn) : draft.anglePreset;
  const parameterPrompt = language === 'zh'
    ? `按多角度编辑参数生成：视角预设=${presetLabel ?? '自定义'}，相机方位=${aziToWord(yaw, true)}(水平环绕 ${yaw}°)，垂直俯仰=${pitch}°，景别缩放=${zoom}%。保持主体身份、服装、比例和材质一致，输出干净的多角度/三视图参考图。`
    : `Generate with angle-editor parameters: preset=${presetLabel ?? 'Custom'}, camera from the ${aziToWord(yaw, false)} (yaw=${yaw}deg), pitch=${pitch}deg, framing zoom=${zoom}%. Keep identity, outfit, proportions, and material consistent; output a clean multi-angle/three-view reference sheet.`;
  return draft.anglePromptEnabled === false
    ? parameterPrompt
    : `${draft.prompt}\n${parameterPrompt}`.trim();
}

// 打光提示词:布光模板给氛围,灯光列表逐盏描述几何(方位/仰角/强度/颜色/软硬)。
function buildLightingEditorPrompt(draft: ImageActionDraft, language: string) {
  const zh = language === 'zh';
  const lights = draft.lightingLights?.length ? draft.lightingLights : defaultLightRig();
  const preset = LIGHT_RIG_PRESETS.find((item) => item.id === draft.lightingPreset);
  const lightLines = lights.map((light) => (zh
    ? `${light.name}(来自${aziToWord(light.azi, true)}、${eleToWord(light.ele, true)}，方位角${aziTo360(light.azi)}°，仰角${Math.round(light.ele)}°，强度${light.intensity}/10，颜色${light.color.toUpperCase()}，${light.kind === 'soft' ? '柔光' : '硬光'})`
    : `${light.name} (from the ${aziToWord(light.azi, false)} at ${eleToWord(light.ele, false)}, azimuth ${aziTo360(light.azi)}deg, elevation ${Math.round(light.ele)}deg, intensity ${light.intensity}/10, color ${light.color.toUpperCase()}, ${light.kind === 'soft' ? 'soft' : 'hard'} light)`));
  const moodLine = preset ? (zh ? `布光风格：${preset.labelZh} —— ${preset.promptZh}。` : `Lighting style: ${preset.labelEn} — ${preset.promptEn}.`) : '';
  const parameterPrompt = zh
    ? `按打光编辑器重新布光：${moodLine}共 ${lights.length} 盏灯：${lightLines.join('；')}。保持主体、构图、服装和背景布局不变，只改变光照方向、阴影、色温、质感和氛围。`
    : `Relight per the lighting editor: ${moodLine} ${lights.length} light(s): ${lightLines.join('; ')}. Keep subject, composition, outfit, and background layout unchanged; only change light direction, shadows, color temperature, material response, and mood.`;
  return `${draft.prompt}\n${parameterPrompt}`.trim();
}

const VIDEO_EDIT_PRESETS = [
  { id: 'scene-preserve', labelZh: '保留主体', labelEn: 'Preserve subject', prompt: '保持主体和构图基本不变，只处理视频编辑目标。' },
  { id: 'highlight-reframe', labelZh: '强化观感', labelEn: 'Enhance look', prompt: '在保留主要内容的前提下，提升整体观感与完成度。' },
];

const VIDEO_PARSE_PRESETS = [
  { id: 'summary', labelZh: '场景摘要', labelEn: 'Scene summary', targetTracks: ['summary'] as string[] },
  { id: 'transcript', labelZh: '字幕转写', labelEn: 'Transcript', targetTracks: ['transcript'] as string[] },
];

const VIDEO_AUDIO_PRESETS = [
  { id: 'voice', labelZh: '人声分离', labelEn: 'Voice separation', targetTracks: ['voice'] as string[] },
  { id: 'av', labelZh: '音视频分离', labelEn: 'Audio/video split', targetTracks: ['audio', 'video'] as string[] },
];

type VideoActionKind = 'trim' | 'crop' | 'enhance' | 'parse' | 'subtitle-clean' | 'audio-separate';

type VideoActionDraft = {
  prompt: string;
  trimStart: number;
  trimEnd: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  outputFormat: string;
  targetTracks: string[];
};

function parseGridValue(value: string) {
  const [rows, cols] = value.split('x').map((item) => Number(item));
  return {
    rows: Number.isFinite(rows) && rows > 0 ? rows : 3,
    cols: Number.isFinite(cols) && cols > 0 ? cols : 3,
  };
}

function parseRatioValue(ratio: string) {
  const [w, h] = ratio.split(':').map((item) => Number(item));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return 1;
  }
  return w / h;
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  const target = toRenderableMediaUrl(src);
  const response = await fetch(target, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to load image: ${response.status}`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = objectUrl;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function canvasToDataUrl(canvas: HTMLCanvasElement) {
  return canvas.toDataURL('image/png');
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAssetUrl(rawUrl: string) {
  if (!rawUrl || /^https?:\/\//.test(rawUrl) || /^data:/.test(rawUrl)) {
    return rawUrl;
  }
  const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '') as string;
  return apiBase ? `${apiBase.replace(/\/+$/, '')}${rawUrl}` : rawUrl;
}

async function uploadImageSource(source: string, filename: string) {
  const res = await fetch(source);
  const blob = await res.blob();
  const form = new FormData();
  form.append('file', blob, filename);
  const uploadResp = await fetch(resolveApiUrl('/api/app/upload'), { method: 'POST', body: form, credentials: 'include' });
  if (!uploadResp.ok) {
    throw new Error(`Upload failed: ${uploadResp.status}`);
  }
  const json = await uploadResp.json();
  const rawUrl = json?.data?.url as string | undefined;
  if (!rawUrl) {
    throw new Error('Upload returned empty URL');
  }
  return normalizeAssetUrl(rawUrl);
}

// uploadTransientImageReference promotes browser-local image URLs
// (data:/blob:) to backend-hosted public URLs before they go out as a
// generation reference — gateways like ManjuAPI reject anything that isn't
// a real http(s) URL ("ManjuAPI image reference must be a public http(s)
// URL"). http(s) and already-uploaded refs pass through unchanged.
async function uploadTransientImageReference(source: string, filename: string) {
  const trimmed = source.trim();
  if (!/^(data:image\/|blob:)/i.test(trimmed)) {
    return source;
  }
  return uploadImageSource(trimmed, filename);
}

// ── 画笔标注 (on-image annotation) ─────────────────────────────────────────
// Freehand pen strokes + text labels drawn OVER a generated image, baked into
// a new full-resolution copy on save. Coordinates are stored normalized
// (0..1 relative to the displayed media box) so they survive canvas zoom and
// map onto the natural-size bitmap through the same object-cover crop the
// <img> uses.
type AnnotateOp =
  | { kind: 'pen'; color: string; width: number; points: Array<{ x: number; y: number }> }
  | { kind: 'text'; color: string; size: number; x: number; y: number; text: string };

const ANNOTATE_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#111827'];

function paintAnnotateOps(
  ctx: CanvasRenderingContext2D,
  ops: AnnotateOp[],
  mapX: (n: number) => number,
  mapY: (n: number) => number,
  widthScale: number,
) {
  for (const op of ops) {
    if (op.kind === 'pen') {
      if (op.points.length === 0) continue;
      ctx.strokeStyle = op.color;
      ctx.lineWidth = Math.max(1, op.width * widthScale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(mapX(op.points[0].x), mapY(op.points[0].y));
      for (let i = 1; i < op.points.length; i += 1) {
        ctx.lineTo(mapX(op.points[i].x), mapY(op.points[i].y));
      }
      // A click without movement still leaves a visible dot.
      if (op.points.length === 1) ctx.lineTo(mapX(op.points[0].x) + 0.01, mapY(op.points[0].y));
      ctx.stroke();
    } else {
      if (!op.text) continue;
      ctx.fillStyle = op.color;
      ctx.font = `600 ${Math.max(8, op.size * widthScale)}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(op.text, mapX(op.x), mapY(op.y));
    }
  }
}

/** Bake annotation ops into a full-resolution PNG of the source image. */
async function renderAnnotatedImage(srcUrl: string, ops: AnnotateOp[], boxW: number, boxH: number): Promise<Blob> {
  const img = await loadImageElement(srcUrl);
  const nW = img.naturalWidth || Math.max(1, Math.round(boxW));
  const nH = img.naturalHeight || Math.max(1, Math.round(boxH));
  const canvas = document.createElement('canvas');
  canvas.width = nW;
  canvas.height = nH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.drawImage(img, 0, 0, nW, nH);
  // The node shows the image object-cover inside a boxW×boxH frame: scale
  // s = display px per natural px; only a centered visW×visH source crop is
  // visible, so normalized box coords map into that crop.
  const s = Math.max(boxW / nW, boxH / nH);
  const visW = boxW / s;
  const visH = boxH / s;
  const offX = (nW - visW) / 2;
  const offY = (nH - visH) / 2;
  paintAnnotateOps(ctx, ops, (n) => offX + n * visW, (n) => offY + n * visH, 1 / s);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Canvas export failed');
  return blob;
}

/** Transparent drawing surface overlaid on the node's media box. */
function ImageAnnotateLayer({ tool, color, width, ops, onCommit, suspended = false }: {
  tool: 'pen' | 'text';
  color: string;
  width: number;
  ops: AnnotateOp[];
  onCommit: (op: AnnotateOp) => void;
  /** Blocks input (and lets pointer events pass through) while a save is
   *  in-flight or a wire is being dragged over the node. */
  suspended?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<Extract<AnnotateOp, { kind: 'pen' }> | null>(null);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const textDraftRef = useRef(textDraft);
  textDraftRef.current = textDraft;

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const live = drawingRef.current ? [...ops, drawingRef.current] : ops;
    // Op widths are in box CSS px; the bitmap is box CSS px × dpr.
    const widthScale = canvas.width / Math.max(1, canvas.offsetWidth || canvas.width);
    paintAnnotateOps(ctx, live, (n) => n * canvas.width, (n) => n * canvas.height, widthScale);
  }, [ops]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round((canvas.offsetWidth || 1) * dpr);
    canvas.height = Math.round((canvas.offsetHeight || 1) * dpr);
    repaint();
  }, [repaint]);

  const toNorm = (event: React.PointerEvent) => {
    // getBoundingClientRect is post-zoom, so normalized coords are zoom-proof.
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clampNumber((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clampNumber((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
    };
  };

  // Ref-routed so the Enter-then-blur sequence can't commit the label twice.
  const commitTextDraft = () => {
    const draft = textDraftRef.current;
    textDraftRef.current = null;
    setTextDraft(null);
    if (draft && draft.value.trim()) {
      onCommit({ kind: 'text', color, size: Math.max(14, width * 4), x: draft.x, y: draft.y, text: draft.value.trim() });
    }
  };

  return (
    <div
      className="nodrag nopan absolute inset-0 z-20"
      style={{ cursor: tool === 'text' ? 'text' : 'crosshair', pointerEvents: suspended ? 'none' : undefined }}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (suspended || event.button !== 0) return;
        if (tool === 'text') {
          if (!textDraftRef.current) setTextDraft({ ...toNorm(event), value: '' });
          return;
        }
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        drawingRef.current = { kind: 'pen', color, width, points: [toNorm(event)] };
        repaint();
      }}
      onPointerMove={(event) => {
        if (!drawingRef.current) return;
        event.stopPropagation();
        drawingRef.current.points.push(toNorm(event));
        repaint();
      }}
      onPointerUp={() => {
        const op = drawingRef.current;
        drawingRef.current = null;
        if (op) onCommit(op);
      }}
      onPointerCancel={() => {
        drawingRef.current = null;
        repaint();
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {textDraft ? (
        <input
          autoFocus
          value={textDraft.value}
          placeholder="输入文字…"
          onChange={(event) => {
            const value = event.target.value;
            setTextDraft((draft) => (draft ? { ...draft, value } : draft));
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') commitTextDraft();
            if (event.key === 'Escape') {
              textDraftRef.current = null;
              setTextDraft(null);
            }
          }}
          onBlur={commitTextDraft}
          onPointerDown={(event) => event.stopPropagation()}
          className="nodrag nopan absolute z-30 rounded border border-white/40 bg-black/60 px-1.5 py-0.5 outline-none backdrop-blur-sm placeholder:text-white/40"
          style={{
            left: `${textDraft.x * 100}%`,
            top: `${textDraft.y * 100}%`,
            color,
            maxWidth: '70%',
            // Match the size the label will be baked at, so commit doesn't jump.
            fontSize: Math.max(14, width * 4),
            lineHeight: 1.2,
          }}
        />
      ) : null}
    </div>
  );
}

/** Annotation-mode toolbar: 返回 | 画笔 文字 颜色 粗细 | 撤销 重做 | 保存. */
function ImageAnnotateToolbar({ zh, tool, setTool, color, setColor, width, setWidth, canUndo, canRedo, onUndo, onRedo, onExit, onSave, saving }: {
  zh: boolean;
  tool: 'pen' | 'text';
  setTool: (tool: 'pen' | 'text') => void;
  color: string;
  setColor: (color: string) => void;
  width: number;
  setWidth: (width: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExit: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const [showColors, setShowColors] = useState(false);
  return (
    <div className="flex items-center gap-1 rounded-full border border-white/12 bg-[#0f141d]/88 px-2 py-1.5 text-neutral-100 backdrop-blur-xl shadow-[0_18px_40px_-18px_rgba(0,0,0,0.9)]">
      <button
        type="button"
        onClick={onExit}
        title={zh ? '退出标注（不保存）' : 'Exit without saving'}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-neutral-300 transition hover:bg-white/10 hover:text-white"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {zh ? '返回' : 'Back'}
      </button>
      <div className="mx-1 h-5 w-px bg-white/10" />
      <Button variant="ghost" size="icon" className={clsx(tool === 'pen' && 'bg-white/15 text-white')} onClick={() => setTool('pen')} title={zh ? '画笔' : 'Pen'}>
        <Brush className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className={clsx(tool === 'text' && 'bg-white/15 text-white')} onClick={() => setTool('text')} title={zh ? '文字' : 'Text'}>
        <Type className="h-4 w-4" />
      </Button>
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowColors((v) => !v)}
          title={zh ? '颜色' : 'Color'}
          className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-white/10"
        >
          <span className="h-4 w-4 rounded-full border border-white/40" style={{ backgroundColor: color }} />
        </button>
        {showColors ? (
          <div className="absolute left-1/2 top-full z-40 mt-2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-[#12161d]/95 px-2 py-1.5 shadow-xl backdrop-blur-xl">
            {ANNOTATE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { setColor(c); setShowColors(false); }}
                className={clsx('h-4 w-4 rounded-full border border-white/30 transition hover:scale-110', color === c && 'ring-2 ring-white/80')}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 px-1" title={zh ? '粗细' : 'Stroke width'}>
        <span
          className="shrink-0 rounded-full"
          style={{ width: Math.max(3, Math.min(12, width / 2)), height: Math.max(3, Math.min(12, width / 2)), backgroundColor: color }}
        />
        <input
          type="range"
          min={2}
          max={24}
          step={1}
          value={width}
          onChange={(event) => setWidth(Number(event.target.value))}
          onPointerDown={(event) => event.stopPropagation()}
          className="h-1 w-20 cursor-pointer accent-white"
        />
      </div>
      <div className="mx-1 h-5 w-px bg-white/10" />
      <Button variant="ghost" size="icon" disabled={!canUndo} onClick={onUndo} title={zh ? '上一步' : 'Undo'}>
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" disabled={!canRedo} onClick={onRedo} title={zh ? '下一步' : 'Redo'}>
        <Redo2 className="h-4 w-4" />
      </Button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="ml-1 flex items-center gap-1 rounded-full bg-white px-3 py-1 text-xs font-medium text-black transition hover:bg-neutral-200 disabled:opacity-60"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {zh ? '保存' : 'Save'}
      </button>
    </div>
  );
}

function isLikelyPanoramaData(data: Record<string, any>) {
  const params = (data.generationParams ?? {}) as Record<string, unknown>;
  const aspectRatio = String(params.aspectRatio ?? data.aspectRatio ?? '');
  const ratio = Number(data.mediaWidth) > 0 && Number(data.mediaHeight) > 0
    ? Number(data.mediaWidth) / Number(data.mediaHeight)
    : 0;
  return Boolean(
    data.isPanorama
    || data.panorama
    || params.editOperation === 'panorama'
    || params.mode === 'panorama'
    || aspectRatio === '2:1'
    || (ratio >= 1.9 && ratio <= 2.1),
  );
}

async function buildSelectionMask(sourceUrl: string, selection: { x: number; y: number; width: number; height: number }) {
  const img = await loadImageElement(sourceUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Mask canvas unavailable');
  const editSelection = selection.width > 0 && selection.height > 0
    ? selection
    : { x: 0, y: 0, width: canvas.width, height: canvas.height };
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(editSelection.x, editSelection.y, editSelection.width, editSelection.height);
  return canvasToDataUrl(canvas);
}

async function buildPanoramaReference(sourceUrl: string, targetRatio = '21:9') {
  const img = await loadImageElement(sourceUrl);
  const ratio = parseRatioValue(targetRatio);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const srcRatio = srcW / srcH;
  const padScale = 1.15;
  const targetW = ratio >= srcRatio ? Math.max(srcW, Math.round(srcH * ratio * padScale)) : Math.round(srcW * padScale);
  const targetH = ratio >= srcRatio ? Math.round(targetW / ratio) : Math.max(srcH, Math.round(srcW / ratio * padScale));
  const drawW = srcW;
  const drawH = srcH;
  const offsetX = Math.round((targetW - drawW) / 2);
  const offsetY = Math.round((targetH - drawH) / 2);

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = targetW;
  sourceCanvas.height = targetH;
  const sourceCtx = sourceCanvas.getContext('2d');
  if (!sourceCtx) throw new Error('Source canvas unavailable');
  sourceCtx.fillStyle = '#050505';
  sourceCtx.fillRect(0, 0, targetW, targetH);
  sourceCtx.drawImage(img, offsetX, offsetY, drawW, drawH);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = targetW;
  maskCanvas.height = targetH;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) throw new Error('Mask canvas unavailable');
  maskCtx.fillStyle = 'rgba(0,0,0,1)';
  maskCtx.fillRect(0, 0, targetW, targetH);
  maskCtx.clearRect(offsetX, offsetY, drawW, drawH);

  return {
    referenceImages: [await canvasToDataUrl(sourceCanvas)],
    maskImage: await canvasToDataUrl(maskCanvas),
  };
}

async function splitImageIntoTiles(sourceUrl: string, rows: number, cols: number) {
  const img = await loadImageElement(sourceUrl);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const tileW = srcW / cols;
  const tileH = srcH / rows;
  const tiles: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(tileW));
      canvas.height = Math.max(1, Math.round(tileH));
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(
        img,
        Math.round(col * tileW),
        Math.round(row * tileH),
        Math.round(tileW),
        Math.round(tileH),
        0,
        0,
        canvas.width,
        canvas.height,
      );
      tiles.push(await canvasToDataUrl(canvas));
    }
  }
  // Also return the per-tile pixel dimensions so the caller can lay the
  // slice nodes out on a non-overlapping grid (node width is fixed at
  // 300px; height follows the tile aspect ratio).
  return { tiles, tileW: Math.round(tileW), tileH: Math.round(tileH) };
}

function PanoramaActionEditor({
  session,
  setSession,
  sourceUrl,
  language,
  modelOptions,
  providerConfigs,
}: {
  session: ImageActionSession;
  setSession: (session: ImageActionSession) => void;
  sourceUrl: string;
  language: string;
  modelOptions: string[];
  providerConfigs: AppProviderConfig[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const draft = session.draft;
  const selectedModel = draft.model || modelOptions[0] || 'gpt-image-2';
  const options = modelOptions.length > 0 ? modelOptions : [selectedModel];
  const activeConfig = providerConfigs.find((config) => config.model_list.includes(selectedModel)) ?? null;
  const updateDraft = (patch: Partial<ImageActionDraft>) => setSession({ ...session, draft: { ...draft, ...patch } });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mm = gsap.matchMedia();
    mm.add({ reduceMotion: '(prefers-reduced-motion: reduce)' }, (context) => {
      const reduceMotion = Boolean(context.conditions?.reduceMotion);
      const items = root.querySelectorAll('[data-panorama-animate]');
      if (reduceMotion) {
        gsap.set(items, { autoAlpha: 1, y: 0, scale: 1 });
        return;
      }
      const entrance = gsap.fromTo(
        items,
        { autoAlpha: 0, y: 14, scale: 0.98 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.42, ease: 'power2.out', stagger: 0.06, overwrite: 'auto' },
      );
      const sweep = sweepRef.current
        ? gsap.fromTo(sweepRef.current, { xPercent: 0 }, { xPercent: -50, duration: 12, ease: 'none', repeat: -1 })
        : null;
      return () => {
        entrance.kill();
        sweep?.kill();
      };
    });
    return () => mm.revert();
  }, []);

  return (
    <div ref={rootRef} className="space-y-4">
      <div data-panorama-animate className="relative h-48 overflow-hidden rounded-3xl border border-white/10 bg-[#0c1118] shadow-inner">
        <div ref={sweepRef} className="absolute inset-y-0 left-0 flex w-[200%] will-change-transform">
          <ResilientImage src={sourceUrl} alt="" className="h-full w-1/2 object-cover" zh={language === 'zh'} />
          <ResilientImage src={sourceUrl} alt="" className="h-full w-1/2 object-cover" zh={language === 'zh'} />
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(2,6,23,0.58),transparent_24%,transparent_76%,rgba(2,6,23,0.58))]" />
        <div className="absolute left-4 top-4 rounded-full border border-cyan-300/25 bg-cyan-400/12 px-3 py-1 text-xs text-cyan-100 backdrop-blur">
          {language === 'zh' ? '2:1 等距柱状投影' : '2:1 equirectangular'}
        </div>
        <div className="absolute bottom-4 right-4 rounded-2xl border border-white/10 bg-black/45 px-3 py-2 text-xs text-neutral-200 backdrop-blur">
          {language === 'zh' ? '生成后可进入拖动预览' : 'Drag preview after generation'}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_260px]">
        <div data-panorama-animate className="space-y-2">
          <label className="text-xs text-neutral-400">{language === 'zh' ? '全景提示词' : 'Panorama prompt'}</label>
          <Textarea
            value={draft.prompt}
            onChange={(event) => updateDraft({ prompt: event.target.value })}
            className="min-h-[132px] border-white/10 bg-white/[0.035] text-sm"
            placeholder={language === 'zh' ? '描述需要补全的 360 环境、光线和主体保持要求' : 'Describe the 360 environment, lighting, and preservation requirements'}
          />
        </div>
        <div data-panorama-animate className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
          <div className="space-y-2">
            <div className="text-xs text-neutral-400">{language === 'zh' ? '生成模型' : 'Model'}</div>
            <div className="rounded-xl border border-white/10 bg-black/20 px-1 py-1">
              <Dropdown
                label={<ModelBrandIcon model={selectedModel} vendor={activeConfig?.vendor} providerName={activeConfig?.name} iconKey={activeConfig?.icon_key} iconUrl={activeConfig?.icon_url} size={16} />}
                value={selectedModel}
                options={options}
                onChange={(model) => updateDraft({ model })}
                side="bottom"
                menuMinWidth={260}
                renderOption={(option, selected) => {
                  const optionConfig = providerConfigs.find((config) => config.model_list.includes(option)) ?? null;
                  return (
                    <div className="flex w-full items-center gap-2">
                      <ModelBrandIcon model={option} vendor={optionConfig?.vendor} providerName={optionConfig?.name} iconKey={optionConfig?.icon_key} iconUrl={optionConfig?.icon_url} size={18} />
                      <span className={clsx('flex-1 truncate', selected ? 'text-cyan-300' : 'text-neutral-200')}>{option}</span>
                    </div>
                  );
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs text-neutral-400">{language === 'zh' ? '扩展方向' : 'Expand direction'}</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'horizontal', zh: '横向扩展', en: 'Horizontal' },
                { id: 'vertical', zh: '纵向扩展', en: 'Vertical' },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => updateDraft({ expandDirection: item.id })}
                  className={clsx(
                    'rounded-xl border px-3 py-2 text-xs transition',
                    (draft.expandDirection ?? 'horizontal') === item.id
                      ? 'border-cyan-300/45 bg-cyan-400/15 text-cyan-50'
                      : 'border-white/10 bg-black/18 text-neutral-300 hover:bg-white/[0.08]',
                  )}
                >
                  {language === 'zh' ? item.zh : item.en}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/18 p-3 text-xs leading-relaxed text-neutral-400">
            {language === 'zh'
              ? '会保留原图主体风格，并补全左右衔接的全景环境。推荐选择支持图生图/参考图的图片模型。'
              : 'Keeps the source style and completes a seamless panorama. Prefer image models that support references.'}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 高清增强配置弹窗 — Nano Pro 专用超分：引擎固定，只选 2K/4K 目标分辨率。
 *  左侧原图预览，右侧原图信息 + 引擎卡 + 目标分辨率与输出尺寸估算。 */
function HdEnhanceModal({ sourceUrl, zh, modelAvailable, busy, onSubmit, onClose }: {
  sourceUrl: string;
  zh: boolean;
  modelAvailable: boolean;
  busy: boolean;
  onSubmit: (resolution: '2k' | '4k', aspectRatio: string) => void;
  onClose: () => void;
}) {
  const [res, setRes] = useState<'2k' | '4k'>('2k');
  const [ratio, setRatio] = useState<string>('auto');
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadImageElement(sourceUrl)
      .then((img) => {
        if (!cancelled && img.naturalWidth && img.naturalHeight) {
          setDims({ w: img.naturalWidth, h: img.naturalHeight });
        }
      })
      .catch(() => { /* info rows stay '—' */ });
    return () => { cancelled = true; };
  }, [sourceUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ratioLabel = useMemo(() => {
    if (!dims) return '—';
    // Snap to the nearest friendly ratio when within ~2%; otherwise show the
    // reduced exact ratio (raw dims like 1672:941 are unreadable).
    const candidates = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '2:1', '1:2', '21:9'];
    const actual = dims.w / dims.h;
    let best = '';
    let bestDelta = Infinity;
    for (const candidate of candidates) {
      const [a, b] = candidate.split(':').map(Number);
      const delta = Math.abs(Math.log(actual / (a / b)));
      if (delta < bestDelta) {
        bestDelta = delta;
        best = candidate;
      }
    }
    if (bestDelta < 0.02) return best;
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const d = gcd(dims.w, dims.h) || 1;
    return `${dims.w / d}:${dims.h / d}`;
  }, [dims]);
  const mp = dims ? ((dims.w * dims.h) / 1_000_000).toFixed(1) : '—';
  const targetLong = res === '4k' ? 3840 : 2048;
  const scale = dims ? targetLong / Math.max(dims.w, dims.h) : null;
  // Output size: auto keeps the source ratio; an explicit ratio re-frames the
  // output at the target long edge.
  const out = useMemo(() => {
    if (ratio !== 'auto') {
      const [a, b] = ratio.split(':').map(Number);
      if (a > 0 && b > 0) {
        return a >= b
          ? { w: targetLong, h: Math.round((targetLong * b) / a) }
          : { w: Math.round((targetLong * a) / b), h: targetLong };
      }
    }
    if (!dims || !scale) return null;
    return { w: Math.round(dims.w * scale), h: Math.round(dims.h * scale) };
  }, [ratio, dims, scale, targetLong]);

  const InfoRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-neutral-500">{label}</span>
      <span className="font-mono text-neutral-200">{value}</span>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/85 p-6 backdrop-blur-md" onClick={onClose}>
      <div
        className="flex h-[min(720px,86vh)] w-[min(1160px,94vw)] overflow-hidden rounded-2xl border border-white/10 bg-[#101218] shadow-[0_40px_120px_rgba(0,0,0,0.7)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 左侧预览 */}
        <div className="flex flex-1 items-center justify-center bg-black/40 p-6">
          <img
            src={toRenderableMediaUrl(sourceUrl)}
            alt=""
            draggable={false}
            className="max-h-full max-w-full rounded-lg object-contain select-none"
          />
        </div>
        {/* 右侧配置 */}
        <div className="flex w-[340px] shrink-0 flex-col border-l border-white/10">
          <div className="flex items-center justify-between px-5 pb-3 pt-5">
            <div className="text-[15px] font-semibold text-neutral-100">{zh ? '高清增强配置' : 'HD enhance'}</div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-4">
            <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
              <InfoRow label={zh ? '分辨率' : 'Resolution'} value={dims ? `${dims.w} × ${dims.h} px` : '—'} />
              <InfoRow label={zh ? '宽高比' : 'Aspect'} value={ratioLabel} />
              <InfoRow label={zh ? '像素总量' : 'Pixels'} value={dims ? `${mp} MP` : '—'} />
            </div>
            <div>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-neutral-200">{zh ? '处理引擎' : 'Engine'}</span>
                <span className="text-[11px] text-neutral-500">{zh ? '大模型智能超分' : 'Model-powered upscale'}</span>
              </div>
              <div className="rounded-xl border border-indigo-400/60 bg-indigo-500/10 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-indigo-200">Nano Pro {zh ? '大模型高清' : 'HD'}</span>
                  <span className="rounded bg-indigo-500 px-1 text-[9px] font-bold leading-4 text-white">AI</span>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-indigo-200/80">
                  {zh ? '大模型驱动的智能高清还原，细节丰富自然，支持 2K/4K 输出。' : 'Model-driven HD restoration with rich, natural detail. 2K/4K output.'}
                </div>
              </div>
              {!modelAvailable ? (
                <div className="mt-2 text-[11px] text-amber-400/90">
                  {zh ? '未找到 gemini-3.0-pro-image 模型，请先在管理端启用。' : 'gemini-3.0-pro-image is not configured — enable it in admin first.'}
                </div>
              ) : null}
            </div>
            <div>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-neutral-200">{zh ? '目标分辨率' : 'Target resolution'}</span>
                <span className="text-[11px] text-neutral-500">{zh ? '等比放大至目标分辨率' : 'Scaled proportionally'}</span>
              </div>
              <div className="space-y-2 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                <InfoRow
                  label={zh ? '输出尺寸' : 'Output size'}
                  value={out ? <span><span className="text-amber-300">{out.w}</span> × {out.h} px</span> : '—'}
                />
                <InfoRow label={zh ? '放大倍率' : 'Scale'} value={scale ? `≈ ${scale.toFixed(1)}x` : '—'} />
              </div>
              <div className="mt-2 flex items-center gap-2">
                {(['2k', '4k'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setRes(option)}
                    className={clsx(
                      'rounded-full border px-4 py-1.5 text-xs font-medium transition',
                      res === option
                        ? 'border-white bg-white text-black'
                        : 'border-white/15 text-neutral-300 hover:border-white/40 hover:text-white',
                    )}
                  >
                    {option.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-neutral-200">{zh ? '画幅比例' : 'Aspect ratio'}</span>
                <span className="text-[11px] text-neutral-500">{zh ? '输出画面的宽高比' : 'Output frame ratio'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setRatio(option)}
                    className={clsx(
                      'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                      ratio === option
                        ? 'border-white bg-white text-black'
                        : 'border-white/15 text-neutral-300 hover:border-white/40 hover:text-white',
                    )}
                  >
                    {option === 'auto' ? (zh ? '自动' : 'Auto') : option}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-white/10 px-5 py-3.5">
            <div className="text-[12px] text-neutral-300">{zh ? '高清' : 'HD'} · Nano Pro · {res.toUpperCase()}</div>
            <button
              type="button"
              disabled={busy || !modelAvailable}
              // 自动 = 跟随原图：把探测到的（贴近标准的）原图比例传下去，
              // 避免派生节点回退到默认 1:1。
              onClick={() => onSubmit(res, ratio === 'auto' ? (dims ? ratioLabel : 'auto') : ratio)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black transition hover:bg-neutral-200 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ImageActionToolbar({ sourceNodeId, onAnnotate }: { sourceNodeId: string; onAnnotate?: () => void }) {
  const language = useStore((state) => state.language);
  const backendModels = useStore((state) => state.backendModels);
  const nodes = useStore((state) => state.nodes);
  const addNode = useStore((state) => state.addNode);
  const onConnect = useStore((state) => state.onConnect);
  const createGroup = useStore((state) => state.createGroup);
  const runNode = useStore((state) => state.runNode);
  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  const sourceData = (sourceNode?.data ?? {}) as Record<string, any>;
  const sourceUrl = String(sourceData.url ?? '');
  const sourceParams = (sourceData.generationParams as Record<string, unknown> | undefined) ?? {};
  const imageProviderConfigs = useMemo(
    () => backendModels.filter((config) => config.service_type === 'image'),
    [backendModels],
  );
  const imageModelOptions = useMemo(
    () => imageProviderConfigs
      .flatMap((config) => config.model_list)
      .filter((value, index, values) => values.indexOf(value) === index),
    [imageProviderConfigs],
  );
  const sourceModel = typeof sourceParams.model === 'string' && sourceParams.model ? sourceParams.model : '';
  const defaultImageModel = imageModelOptions.includes(sourceModel)
    ? sourceModel
    : imageModelOptions[0] || sourceModel || 'gpt-image-2';
  const [session, setSession] = useState<ImageActionSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [hdOpen, setHdOpen] = useState(false);
  // Nano Pro 高清引擎：优先基础名；只配了 " 4K" 变体时也能兜底使用。
  const nanoProModel = useMemo(() => {
    const models = imageModelOptions;
    return models.find((m) => m.trim().toLowerCase() === 'gemini-3.0-pro-image')
      ?? models.find((m) => m.trim().toLowerCase().startsWith('gemini-3.0-pro-image'))
      ?? '';
  }, [imageModelOptions]);
  const latestDerived = useMemo(
    () => {
      const matches = nodes.filter((node) => (node.data as Record<string, unknown> | undefined)?.derivedFromNodeId === sourceNodeId);
      return matches[matches.length - 1];
    },
    [nodes, sourceNodeId],
  );
  const latestDerivedUrl = String((latestDerived?.data as Record<string, unknown> | undefined)?.url ?? '');

  useEffect(() => {
    if (!session) return;
    if (!session.open && !session.compareOpen) return;
  }, [session]);

  const sourceTitle = language === 'zh' ? '图片二次创作' : 'Image actions';

  const closeSession = () => setSession(null);

  const openDraft = (action: ImageActionKind, draft: Partial<ImageActionDraft> = {}) => {
    const basePrompt = (() => {
      switch (action) {
        case 'panorama':
          return language === 'zh'
            ? '生成 2:1 等距柱状投影 360 全景图，左右可无缝衔接，补全环境细节并保持主体风格一致。'
            : 'Generate a 2:1 equirectangular 360 panorama with seamless left-right continuity, expanded environment details, and consistent subject style.';
        case 'angles':
          return language === 'zh'
            ? '保持主体一致，输出不同机位/角度版本，背景简洁。'
            : 'Keep the subject consistent and produce alternate viewpoints with a clean background.';
        case 'lighting':
          return language === 'zh'
            ? '保持构图和主体不变，只调整光照与氛围。'
            : 'Keep composition and subject unchanged while changing lighting and mood.';
        case 'grid-compose':
          return language === 'zh'
            ? '把参考图整理成整洁的宫格展示，统一风格与边距。'
            : 'Compose the reference into a tidy grid layout with consistent spacing and style.';
        case 'enhance':
          return language === 'zh'
            ? '保留构图与主体，提升清晰度、纹理与细节层次。'
            : 'Preserve composition and subject while enhancing sharpness, texture, and details.';
        case 'edit':
          return language === 'zh'
            ? '在选区内进行局部编辑，保持整体风格一致。'
            : 'Perform local editing inside the selected area while preserving style.';
        default:
          return '';
      }
    })();
    setSession({
      action,
      open: true,
      compareOpen: false,
      draft: {
        prompt: basePrompt,
        // 精修编辑器(全景/多角度/打光)都可以在底部选模型,统一给默认值。
        model: defaultImageModel,
        outputCount: action === 'angles' ? 3 : 1,
        expandDirection: action === 'panorama' ? 'horizontal' : 'both',
        anglePreset: action === 'angles' ? 'custom' : undefined,
        angleYaw: 0,
        anglePitch: 0,
        angleZoom: 50,
        anglePromptEnabled: false,
        lightingPreset: undefined,
        lightingLights: action === 'lighting' ? defaultLightRig() : undefined,
        lightingSelectedId: undefined,
        ...draft,
      },
    });
  };

  const spawnDerivedNode = useCallback(async (payload: {
    prompt: string;
    model?: string;
    outputCount?: number;
    referenceImages?: string[];
    maskImage?: string;
    editOperation?: string;
    expandDirection?: string;
    anglePreset?: string;
    lightingPreset?: string;
    gridPreset?: string;
    /** e.g. '2k'/'4k' — Nano Pro 高清 target; overrides the inherited source resolution. */
    resolution?: string;
    /** Explicit output frame ratio; overrides the inherited source aspect. */
    aspectRatio?: string;
    derivationAction?: string;
  }) => {
    if (!sourceNode) return;
    const base = sourceNode.position ?? { x: 0, y: 0 };
    const derivedId = `img-derive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sourceParams = (sourceData.generationParams as Record<string, unknown> | undefined) ?? {};
    const model = payload.model || (typeof sourceParams.model === 'string' && sourceParams.model ? sourceParams.model : 'gpt-image-2');
    const isPanoramaAction = payload.editOperation === 'panorama' || session?.action === 'panorama';
    const referenceImages = payload.referenceImages ?? (sourceUrl ? [sourceUrl] : undefined);
    // Promote any data:/blob: references to backend-hosted URLs before
    // calling the gateway — required for ManjuAPI and similar providers.
    const timestamp = Date.now();
    const stableReferenceImages = referenceImages
      ? await Promise.all(referenceImages.map((ref, index) =>
          uploadTransientImageReference(ref, `reference-${timestamp}-${index + 1}.png`),
        ))
      : undefined;
    const stableMaskImage = payload.maskImage
      ? await uploadTransientImageReference(payload.maskImage, `mask-${timestamp}.png`)
      : undefined;
    addNode({
      id: derivedId,
      type: 'imageNode',
      position: { x: base.x + 360, y: base.y + Math.random() * 40 - 20 },
      data: {
        customTitle: isPanoramaAction
          ? (language === 'zh' ? '全景图' : 'Panorama image')
          : (language === 'zh' ? '派生图' : 'Derived image'),
        status: 'idle',
        sourceKind: 'derived',
        derivedFromNodeId: sourceNodeId,
        derivationAction: payload.derivationAction ?? session?.action ?? 'enhance',
        isPanorama: isPanoramaAction,
        generationParams: {
          model,
          aspectRatio: payload.aspectRatio ?? (isPanoramaAction ? '2:1' : (sourceParams.aspectRatio ?? '1:1')),
          quality: sourceParams.quality ?? 'auto',
          resolution: payload.resolution ?? sourceParams.resolution ?? '720p',
          durationSeconds: sourceParams.durationSeconds,
          referenceImages: stableReferenceImages,
          maskImage: stableMaskImage,
          editOperation: payload.editOperation,
          expandDirection: payload.expandDirection,
          outputCount: payload.outputCount,
          anglePreset: payload.anglePreset,
          lightingPreset: payload.lightingPreset,
          gridPreset: payload.gridPreset,
          deriveFromNodeId: sourceNodeId,
        },
      },
    } as never);
    onConnect({ source: sourceNodeId, target: derivedId, sourceHandle: null, targetHandle: null } as never);
    await runNode(derivedId, { prompt: payload.prompt, model });
  }, [addNode, onConnect, runNode, session?.action, sourceData.generationParams, sourceNode, sourceNodeId, sourceUrl, language]);

  const handleGenerate = async () => {
    if (!session || busy || !sourceUrl) return;
    setBusy(true);
    try {
      const draft = session.draft;
      if (session.action === 'panorama') {
        const panorama = await buildPanoramaReference(sourceUrl, '2:1');
        await spawnDerivedNode({
          prompt: draft.prompt,
          model: draft.model,
          referenceImages: panorama.referenceImages,
          maskImage: panorama.maskImage,
          editOperation: 'panorama',
          expandDirection: draft.expandDirection,
          outputCount: 1,
        });
      } else if (session.action === 'edit') {
        const maskImage = await buildSelectionMask(sourceUrl, { x: 0, y: 0, width: 0, height: 0 });
        await spawnDerivedNode({
          prompt: draft.prompt,
          referenceImages: [sourceUrl],
          maskImage,
          editOperation: 'local_edit',
          outputCount: 1,
        });
      } else if (session.action === 'angles') {
        const angleLabel = draft.anglePreset ?? 'three-view';
        const anglePrompt = `${buildAngleEditorPrompt(draft, language)} ${angleLabel}`;
        const outputs = Math.max(1, draft.outputCount ?? 1);
        for (let index = 0; index < outputs; index += 1) {
          // Stagger each derived node slightly so multi-output sets are readable.
          // The backend can still collapse to one output if the provider ignores n.
          await spawnDerivedNode({
            prompt: anglePrompt,
            model: draft.model,
            outputCount: 1,
            referenceImages: [sourceUrl],
            anglePreset: draft.anglePreset,
          });
        }
      } else if (session.action === 'lighting') {
        await spawnDerivedNode({
          prompt: buildLightingEditorPrompt(draft, language),
          model: draft.model,
          outputCount: 1,
          referenceImages: [sourceUrl],
          lightingPreset: draft.lightingPreset,
        });
      } else {
        await spawnDerivedNode({
          prompt: draft.prompt,
          outputCount: 1,
          referenceImages: [sourceUrl],
          lightingPreset: draft.lightingPreset,
          gridPreset: draft.gridPreset,
        });
      }
      closeSession();
    } finally {
      setBusy(false);
    }
  };

  const handleSplit = async (value: string) => {
    if (!sourceUrl || !sourceNode) return;
    const { rows, cols } = parseGridValue(value);
    const { tiles, tileW, tileH } = await splitImageIntoTiles(sourceUrl, rows, cols);
    const base = sourceNode.position ?? { x: 0, y: 0 };

    // Lay the slices out on a non-overlapping grid. Reference image nodes
    // render at a fixed 300px content width (BaseNode's w-[300px]); the
    // displayed image height follows the tile aspect ratio, plus a chrome
    // allowance for the title row + borders. Grid step = node size + gap
    // so adjacent slices never stack on top of each other (the old code
    // used a flat 110px step, far smaller than the 300px node width).
    const NODE_W = 300;
    const CHROME_H = 56;               // title row + paddings around the image
    const GAP = 32;
    const tileAspect = tileH > 0 && tileW > 0 ? tileH / tileW : 1;
    const imageDisplayH = NODE_W * tileAspect;
    const nodeDisplayH = imageDisplayH + CHROME_H;
    const xStep = NODE_W + GAP;
    const yStep = nodeDisplayH + GAP;

    // Start the grid to the right of the source node, vertically centered
    // on it so the slice cluster reads as one block next to the original.
    const startX = base.x + NODE_W + 80;
    const startY = base.y - ((rows - 1) * yStep) / 2;

    const createdIds: string[] = [];
    tiles.forEach((tile, index) => {
      const id = `img-slice-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 5)}`;
      createdIds.push(id);
      const col = index % cols;
      const row = Math.floor(index / cols);
      addNode({
        id,
        type: 'referenceImageNode',
        position: { x: startX + col * xStep, y: startY + row * yStep },
        data: {
          url: tile,
          status: 'done',
          mediaWidth: tileW,
          mediaHeight: tileH,
          sourceName: language === 'zh' ? `切片 ${index + 1}` : `Slice ${index + 1}`,
          sourceKind: 'derived',
          sourceNodeId,
          derivedFromNodeId: sourceNodeId,
          derivationAction: 'split',
          sliceGrid: { rows, cols, index },
        },
      } as never);
      onConnect({ source: sourceNodeId, target: id, sourceHandle: null, targetHandle: null } as never);
    });
    if (createdIds.length > 1) {
      createGroup(createdIds);
    }
  };

  if (!sourceNode || !['imageNode', 'referenceImageNode', 'panoramaNode'].includes(sourceNode.type ?? '') || !sourceUrl) return null;

  const actionButtonClass = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-100/88 transition-colors hover:bg-white/10 hover:text-white';
  // 多角度/打光走全新的 PrecisionStudio(左 3D 场景 + 右面板,自带底栏);
  // 全景仍用旧的 header/body/footer 弹窗结构。
  const isStudioEditor = session?.action === 'angles' || session?.action === 'lighting';
  const isPrecisionEditor = session?.action === 'panorama' || isStudioEditor;
  const dialogTitle = session?.action === 'panorama'
    ? (language === 'zh' ? '全景图生成' : 'Panorama generation')
    : sourceTitle;
  // PrecisionStudio 内部有自己的重置;这里只保留全景的重置逻辑。
  const resetEditorDraft = () => {
    if (!session || session.action !== 'panorama') return;
    setSession({
      ...session,
      draft: {
        ...session.draft,
        prompt: language === 'zh'
          ? '生成 2:1 等距柱状投影 360 全景图，左右可无缝衔接，补全环境细节并保持主体风格一致。'
          : 'Generate a 2:1 equirectangular 360 panorama with seamless left-right continuity, expanded environment details, and consistent subject style.',
        model: defaultImageModel,
        expandDirection: 'horizontal',
      },
    });
  };

  return (
    <>
      <div className="flex items-center gap-1 rounded-full border border-white/12 bg-[#0f141d]/88 px-2 py-1.5 text-neutral-100 backdrop-blur-xl shadow-[0_16px_40px_-18px_rgba(2,8,20,0.75),0_0_0_1px_rgba(56,189,248,0.08)]">
        <Button variant="ghost" size="sm" onClick={() => openDraft('panorama')} className={actionButtonClass}>
          <Globe className="h-3.5 w-3.5" />
          {language === 'zh' ? '全景' : 'Panorama'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openDraft('angles')} className={actionButtonClass}>
          <Sparkles className="h-3.5 w-3.5" />
          {language === 'zh' ? '多角度' : 'Angles'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openDraft('lighting')} className={actionButtonClass}>
          <Highlighter className="h-3.5 w-3.5" />
          {language === 'zh' ? '打光' : 'Lighting'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={actionButtonClass}>
              <LayoutTemplate className="h-3.5 w-3.5" />
              {language === 'zh' ? '工具' : 'Tools'}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            {GRID_COMPOSE_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset.id} onClick={() => openDraft('grid-compose', { gridPreset: preset.value, prompt: language === 'zh' ? `将图片整理为${preset.labelZh}展示。` : `Compose the image into a ${preset.labelEn} layout.` })}>
                {language === 'zh' ? preset.labelZh : preset.labelEn}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" onClick={() => setHdOpen(true)} className={actionButtonClass}>
          <Sparkles className="h-3.5 w-3.5" />
          {language === 'zh' ? '高清' : 'HD'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={actionButtonClass}>
              <LayoutTemplate className="h-3.5 w-3.5" />
              {language === 'zh' ? '宫格切分' : 'Split'}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            {GRID_SPLIT_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset.id} onClick={() => void handleSplit(preset.value)}>
                {language === 'zh' ? preset.labelZh : preset.labelEn}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void handleSplit('3x3')}>
              {language === 'zh' ? '自定义 (默认 3×3)' : 'Custom (default 3×3)'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="mx-1 h-5 w-px bg-white/10" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => (onAnnotate ? onAnnotate() : openDraft('edit'))}
          title={onAnnotate ? (language === 'zh' ? '画笔标注' : 'Draw on image') : (language === 'zh' ? '局部编辑' : 'Edit region')}
        >
          <Brush className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setSession({ action: 'enhance', open: false, compareOpen: true, draft: { prompt: '' } })} title={language === 'zh' ? '对比' : 'Compare'}>
          <CopyIcon className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => {
          void downloadAsset(sourceUrl, `${(sourceData.customTitle || sourceNodeId).replace(/[^a-z0-9_-]+/gi, '-') || 'image'}.png`);
        }} title={language === 'zh' ? '下载' : 'Download'}>
          <Download className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setFullscreenOpen(true)} title={language === 'zh' ? '全屏' : 'Fullscreen'}>
          <Expand className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={Boolean(session?.open)} onOpenChange={(open) => { if (!open) closeSession(); }}>
        {isStudioEditor && session ? (
          // 多角度/打光:全出血 3D 工作台(左场景 + 右面板,自带底栏)。
          <DialogContent className="!max-w-none w-[min(96vw,1120px)] overflow-hidden border-white/10 bg-[#0f1216] p-0 text-neutral-100 shadow-[0_30px_90px_rgba(0,0,0,0.6)]">
            <DialogHeader className="sr-only">
              <DialogTitle>{session.action === 'lighting' ? (language === 'zh' ? '灯光调节' : 'Lighting') : (language === 'zh' ? '机位调节' : 'Camera angle')}</DialogTitle>
            </DialogHeader>
            <PrecisionStudio
              mode={session.action === 'lighting' ? 'lighting' : 'angles'}
              draft={session.draft}
              updateDraft={(patch) => { if (session) setSession({ ...session, draft: { ...session.draft, ...patch } }); }}
              sourceUrl={sourceUrl}
              language={language}
              modelOptions={imageModelOptions}
              defaultModel={defaultImageModel}
              busy={busy}
              onGenerate={() => void handleGenerate()}
            />
          </DialogContent>
        ) : (
        <DialogContent className={clsx(
          // UI 适配:限高 + 内滚动,小窗口/低分辨率下弹窗不再溢出屏幕。
          // 宽度必须 !important:DialogContent 基类的 sm:max-w-lg(512px)
          // 带媒体查询变体,在生成 CSS 里排在无前缀工具类之后,普通
          // max-w-* 会被压住 → 弹窗卡在 512 宽,右列被裁。
          'max-h-[88vh] overflow-y-auto overflow-x-hidden border-white/10 bg-[#111318] text-neutral-100 shadow-[0_30px_90px_rgba(0,0,0,0.55)] !max-w-none',
          isPrecisionEditor ? 'w-[min(94vw,920px)]' : 'w-[min(94vw,768px)]',
        )}>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
          </DialogHeader>
          {session ? (
            session.action === 'panorama' ? (
              <PanoramaActionEditor
                session={session}
                setSession={setSession}
                sourceUrl={sourceUrl}
                language={language}
                modelOptions={imageModelOptions}
                providerConfigs={imageProviderConfigs}
              />
            ) : (
              <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
                <div className="space-y-3">
                  <Textarea
                    value={session.draft.prompt}
                    onChange={(event) => setSession({ ...session, draft: { ...session.draft, prompt: event.target.value } })}
                    className="min-h-[160px] border-white/10 bg-white/[0.03] text-sm"
                    placeholder={language === 'zh' ? '输入二次创作提示词' : 'Enter the derivation prompt'}
                  />
                </div>
                <div className="space-y-3">
                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/20">
                    {latestDerivedUrl ? (
                      <ResilientImage src={latestDerivedUrl} alt="" className="h-48 w-full object-cover" zh={language === 'zh'} />
                    ) : (
                      <ResilientImage src={sourceUrl} alt="" className="h-48 w-full object-cover" zh={language === 'zh'} />
                    )}
                  </div>
                  <div className="text-xs text-neutral-400">
                    {language === 'zh' ? '将保留原图并生成派生新节点。' : 'The original image will stay; a derived node will be created.'}
                  </div>
                </div>
              </div>
            )
          ) : null}
          <DialogFooter className={clsx(isPrecisionEditor && 'flex-wrap items-center gap-2 sm:justify-between')}>
            {isPrecisionEditor ? (
              <div className="mr-auto flex min-w-0 items-center gap-1.5">
                <Button variant="ghost" onClick={resetEditorDraft} className="shrink-0 text-neutral-300 hover:bg-white/[0.08] hover:text-white">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {language === 'zh' ? '重置参数' : 'Reset'}
                </Button>
                {/* 模型选择(2026-07 反馈:底部可选执行模型) */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="max-w-[220px] border-white/12 bg-white/[0.04] text-xs text-neutral-200 hover:bg-white/[0.08]">
                      <span className="truncate">{session?.draft.model || defaultImageModel}</span>
                      <ChevronDown className="ml-1.5 h-3 w-3 shrink-0 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto border-white/10 bg-[#16181d] text-neutral-200">
                    {imageModelOptions.map((model) => (
                      <DropdownMenuItem
                        key={model}
                        onClick={() => { if (session) setSession({ ...session, draft: { ...session.draft, model } }); }}
                        className={clsx('text-xs', (session?.draft.model || defaultImageModel) === model && 'text-cyan-300')}
                      >
                        {model}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
            <div className="flex shrink-0 items-center gap-2">
              {isPrecisionEditor ? (
                <span className="flex items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] text-amber-200/90" title={language === 'zh' ? '每次生成消耗' : 'Cost per generation'}>
                  ✦ 1
                </span>
              ) : null}
              <Button variant="outline" onClick={closeSession}>{language === 'zh' ? '取消' : 'Cancel'}</Button>
              <Button onClick={() => void handleGenerate()} disabled={busy}>
                {busy ? (language === 'zh' ? '生成中...' : 'Working...') : (language === 'zh' ? '开始生成' : 'Generate')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
        )}
      </Dialog>

      <Dialog open={Boolean(session?.compareOpen)} onOpenChange={(open) => {
        if (!open && session) setSession({ ...session, compareOpen: false });
      }}>
        <DialogContent className="max-w-5xl border-white/10 bg-[#111318] text-neutral-100">
          <DialogHeader>
            <DialogTitle>{language === 'zh' ? '对比' : 'Compare'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="text-xs text-neutral-400">{language === 'zh' ? '原图' : 'Source'}</div>
              <img src={toRenderableMediaUrl(sourceUrl)} alt="" className="max-h-[62vh] w-full rounded-2xl object-contain bg-black/20" />
            </div>
            <div className="space-y-2">
              <div className="text-xs text-neutral-400">{language === 'zh' ? '最新派生' : 'Latest derived'}</div>
              <img src={toRenderableMediaUrl(latestDerivedUrl || sourceUrl)} alt="" className="max-h-[62vh] w-full rounded-2xl object-contain bg-black/20" />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {fullscreenOpen ? <PreviewModal kind="image" src={sourceUrl} onClose={() => setFullscreenOpen(false)} /> : null}
      {hdOpen ? (
        <HdEnhanceModal
          sourceUrl={sourceUrl}
          zh={language === 'zh'}
          modelAvailable={Boolean(nanoProModel)}
          busy={busy}
          onClose={() => setHdOpen(false)}
          onSubmit={(resolution, aspectRatio) => {
            void (async () => {
              if (busy) return;
              setBusy(true);
              try {
                const basePrompt = language === 'zh'
                  ? '保留构图与主体，提升清晰度、纹理与细节层次。'
                  : 'Preserve composition and subject while enhancing sharpness, texture, and details.';
                // The Nano Pro chat endpoint has no aspect field — a non-auto
                // frame ratio rides in as a prompt directive (and lands in
                // generationParams so schema-aliased providers pick it up too).
                const ratioSuffix = aspectRatio !== 'auto'
                  ? (language === 'zh' ? `画幅比例 ${aspectRatio}。` : ` Output aspect ratio ${aspectRatio}.`)
                  : '';
                await spawnDerivedNode({
                  prompt: `${basePrompt}${ratioSuffix}`,
                  model: nanoProModel || undefined,
                  resolution,
                  aspectRatio: aspectRatio !== 'auto' ? aspectRatio : undefined,
                  referenceImages: [sourceUrl],
                  outputCount: 1,
                  derivationAction: 'enhance',
                });
                setHdOpen(false);
              } finally {
                setBusy(false);
              }
            })();
          }}
        />
      ) : null}
    </>
  );
}

function VideoActionToolbar({ sourceNodeId }: { sourceNodeId: string }) {
  const language = useStore((state) => state.language);
  const nodes = useStore((state) => state.nodes);
  const addNode = useStore((state) => state.addNode);
  const onConnect = useStore((state) => state.onConnect);
  const createGroup = useStore((state) => state.createGroup);
  const runNode = useStore((state) => state.runNode);
  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  const sourceData = (sourceNode?.data ?? {}) as Record<string, any>;
  const sourceUrl = String(sourceData.url ?? '');
  const sourceDuration = Number(sourceData.mediaDuration ?? sourceData.durationSeconds ?? sourceData.duration ?? 0) || 0;
  const sourceModel = String(sourceData.generationParams?.model ?? 'runway-gen3');
  const [session, setSession] = useState<{
    action: VideoActionKind;
    draft: VideoActionDraft;
    open: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const sourceTitle = language === 'zh' ? '视频二次处理' : 'Video actions';
  const actionButtonClass = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-100/88 transition-colors hover:bg-white/10 hover:text-white';

  const openSession = (action: VideoActionKind, draft: Partial<VideoActionDraft> = {}) => {
    const defaults: VideoActionDraft = {
      prompt: action === 'trim'
        ? (language === 'zh' ? '截取视频片段，保留主体和画质。' : 'Trim the clip while preserving subject and quality.')
        : action === 'crop'
          ? (language === 'zh' ? '裁剪画面区域并保持整体观感自然。' : 'Crop the frame while keeping the result natural.')
          : action === 'enhance'
            ? (language === 'zh' ? '提升视频清晰度、细节和整体完成度。' : 'Enhance clarity, details, and overall finish.')
            : action === 'parse'
              ? (language === 'zh' ? '解析视频内容，输出字幕、场景和关键信息。' : 'Parse the video and output transcript, scenes, and key points.')
              : action === 'subtitle-clean'
                ? (language === 'zh' ? '智能去除视频字幕，保留主体内容。' : 'Intelligently remove subtitles while preserving the main content.')
                : (language === 'zh' ? '从视频中分离音频轨道。' : 'Separate the audio track from the video.'),
      trimStart: 0,
      trimEnd: sourceDuration > 0 ? sourceDuration : 10,
      cropX: 0,
      cropY: 0,
      cropWidth: 1,
      cropHeight: 1,
      outputFormat: action === 'audio-separate' ? 'wav' : action === 'parse' ? 'txt' : 'mp4',
      targetTracks:
        action === 'parse'
          ? ['transcript']
          : action === 'audio-separate'
            ? ['audio']
            : action === 'subtitle-clean'
              ? ['subtitles']
              : ['video'],
    };
    setSession({
      action,
      open: true,
      draft: { ...defaults, ...draft },
    });
  };

  const spawnDerivedNode = useCallback(async (params: {
    nodeType: 'videoNode' | 'audioNode' | 'textNode';
    action: VideoActionKind;
    prompt: string;
    title: string;
    trimRange?: { start: number; end: number };
    cropRect?: { x: number; y: number; width: number; height: number };
    outputFormat?: string;
    targetTracks?: string[];
    editOperation?: string;
  }) => {
    if (!sourceNode) return;
    const base = sourceNode.position ?? { x: 0, y: 0 };
    const derivedId = `${params.nodeType}-derive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetModel = params.nodeType === 'textNode'
      ? 'gpt-4.1-mini'
      : params.nodeType === 'audioNode'
        ? 'suno-v4'
        : sourceModel;
    const generationParams = {
      model: targetModel,
      aspectRatio: sourceData.generationParams?.aspectRatio,
      resolution: sourceData.generationParams?.resolution,
      quality: sourceData.generationParams?.quality,
      durationSeconds: sourceData.generationParams?.durationSeconds,
      trimRange: params.trimRange,
      cropRect: params.cropRect,
      targetTracks: params.targetTracks,
      outputFormat: params.outputFormat,
      editOperation: params.editOperation,
      deriveFromNodeId: sourceNodeId,
      referenceVideo: sourceUrl,
    };

    addNode({
      id: derivedId,
      type: params.nodeType,
      position: { x: base.x + 360, y: base.y + Math.random() * 40 - 20 },
      data: {
        customTitle: params.title,
        status: 'idle',
        sourceKind: 'derived',
        derivedFromNodeId: sourceNodeId,
        derivationAction: params.action,
        derivationMeta: {
          trimRange: params.trimRange,
          cropRect: params.cropRect,
          outputFormat: params.outputFormat,
          targetTracks: params.targetTracks,
          editOperation: params.editOperation,
        },
        generationParams,
      },
    } as never);
    onConnect({ source: sourceNodeId, target: derivedId, sourceHandle: null, targetHandle: null } as never);
    await runNode(derivedId, { prompt: params.prompt, model: targetModel });
  }, [addNode, onConnect, runNode, sourceData.generationParams, sourceModel, sourceNode, sourceNodeId, sourceUrl]);

  const handleSubmit = async () => {
    if (!session || busy || !sourceUrl) return;
    setBusy(true);
    try {
      const d = session.draft;
      if (session.action === 'trim') {
        await spawnDerivedNode({
          nodeType: 'videoNode',
          action: session.action,
          prompt: d.prompt,
          title: language === 'zh' ? '剪辑结果' : 'Trimmed clip',
          trimRange: { start: Math.max(0, d.trimStart), end: Math.max(Math.max(0, d.trimStart), d.trimEnd) },
          outputFormat: d.outputFormat || 'mp4',
          targetTracks: d.targetTracks,
          editOperation: 'trim',
        });
      } else if (session.action === 'crop') {
        await spawnDerivedNode({
          nodeType: 'videoNode',
          action: session.action,
          prompt: d.prompt,
          title: language === 'zh' ? '裁剪结果' : 'Cropped clip',
          cropRect: {
            x: Math.max(0, d.cropX),
            y: Math.max(0, d.cropY),
            width: Math.max(0.05, d.cropWidth),
            height: Math.max(0.05, d.cropHeight),
          },
          outputFormat: d.outputFormat || 'mp4',
          targetTracks: d.targetTracks,
          editOperation: 'crop',
        });
      } else if (session.action === 'enhance') {
        await spawnDerivedNode({
          nodeType: 'videoNode',
          action: session.action,
          prompt: d.prompt,
          title: language === 'zh' ? '高清结果' : 'Enhanced clip',
          outputFormat: d.outputFormat || 'mp4',
          targetTracks: d.targetTracks,
          editOperation: 'enhance',
        });
      } else if (session.action === 'subtitle-clean') {
        await spawnDerivedNode({
          nodeType: 'videoNode',
          action: session.action,
          prompt: d.prompt,
          title: language === 'zh' ? '去字幕结果' : 'Subtitle-cleaned clip',
          outputFormat: d.outputFormat || 'mp4',
          targetTracks: d.targetTracks,
          editOperation: 'subtitle_clean',
        });
      } else if (session.action === 'parse') {
        await spawnDerivedNode({
          nodeType: 'textNode',
          action: session.action,
          prompt: d.prompt,
          title: language === 'zh' ? '视频解析' : 'Video parse',
          outputFormat: d.outputFormat || 'txt',
          targetTracks: d.targetTracks,
          editOperation: 'parse',
        });
      } else if (session.action === 'audio-separate') {
        await spawnDerivedNode({
          nodeType: 'audioNode',
          action: session.action,
          prompt: d.prompt,
          title: language === 'zh' ? '音频分离结果' : 'Separated audio',
          outputFormat: d.outputFormat || 'wav',
          targetTracks: d.targetTracks,
          editOperation: 'audio_separate',
        });
      }
      setSession(null);
    } finally {
      setBusy(false);
    }
  };

  if (!sourceNode || sourceNode.type !== 'videoNode' || !sourceUrl) return null;

  return (
    <>
      <div className="flex items-center gap-1 rounded-full border border-white/12 bg-[#0f141d]/88 px-2 py-1.5 text-neutral-100 backdrop-blur-xl shadow-[0_16px_40px_-18px_rgba(2,8,20,0.75),0_0_0_1px_rgba(56,189,248,0.08)]">
        <Button variant="ghost" size="sm" onClick={() => openSession('trim')} className={actionButtonClass}>
          <Scissors className="h-3.5 w-3.5" />
          {language === 'zh' ? '剪辑' : 'Trim'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openSession('crop')} className={actionButtonClass}>
          <Crop className="h-3.5 w-3.5" />
          {language === 'zh' ? '裁剪' : 'Crop'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openSession('enhance')} className={actionButtonClass}>
          <Sparkles className="h-3.5 w-3.5" />
          {language === 'zh' ? '高清' : 'HD'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={actionButtonClass}>
              <FileText className="h-3.5 w-3.5" />
              {language === 'zh' ? '解析' : 'Parse'}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {VIDEO_PARSE_PRESETS.map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onClick={() => openSession('parse', { prompt: language === 'zh' ? `解析视频并输出${preset.labelZh}` : `Parse the video and output ${preset.labelEn.toLowerCase()}.`, targetTracks: preset.targetTracks })}
              >
                {language === 'zh' ? preset.labelZh : preset.labelEn}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={actionButtonClass}>
              <Highlighter className="h-3.5 w-3.5" />
              {language === 'zh' ? '智能去字幕' : 'Subtitle clean'}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {VIDEO_EDIT_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset.id} onClick={() => openSession('subtitle-clean', { prompt: preset.prompt })}>
                {language === 'zh' ? preset.labelZh : preset.labelEn}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={actionButtonClass}>
              <Music className="h-3.5 w-3.5" />
              {language === 'zh' ? '音频分离' : 'Audio split'}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {VIDEO_AUDIO_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset.id} onClick={() => openSession('audio-separate', { targetTracks: preset.targetTracks })}>
                {language === 'zh' ? preset.labelZh : preset.labelEn}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="mx-1 h-5 w-px bg-white/10" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            void downloadAsset(sourceUrl, `${(sourceData.customTitle || sourceNodeId).replace(/[^a-z0-9_-]+/gi, '-') || 'video'}.mp4`);
          }}
          title={language === 'zh' ? '下载' : 'Download'}
        >
          <Download className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setFullscreenOpen(true)} title={language === 'zh' ? '全屏' : 'Fullscreen'}>
          <Expand className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={Boolean(session?.open)} onOpenChange={(open) => { if (!open) setSession(null); }}>
        <DialogContent className="max-w-2xl border-white/10 bg-[#111318] text-neutral-100">
          <DialogHeader>
            <DialogTitle>{sourceTitle}</DialogTitle>
          </DialogHeader>
          {session ? (
            <div className="space-y-4">
              <Textarea
                value={session.draft.prompt}
                onChange={(event) => setSession({ ...session, draft: { ...session.draft, prompt: event.target.value } })}
                className="min-h-[120px] border-white/10 bg-white/[0.03] text-sm"
                placeholder={language === 'zh' ? '输入处理说明' : 'Enter the processing prompt'}
              />
              {(session.action === 'trim' || session.action === 'crop') ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {session.action === 'trim' ? (
                    <>
                      <label className="space-y-1 text-xs text-neutral-400">
                        <span>{language === 'zh' ? '开始时间(秒)' : 'Start (s)'}</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={session.draft.trimStart}
                          onChange={(event) => setSession({ ...session, draft: { ...session.draft, trimStart: Number(event.target.value) } })}
                          className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-neutral-400">
                        <span>{language === 'zh' ? '结束时间(秒)' : 'End (s)'}</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={session.draft.trimEnd}
                          onChange={(event) => setSession({ ...session, draft: { ...session.draft, trimEnd: Number(event.target.value) } })}
                          className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm"
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      {(['cropX', 'cropY', 'cropWidth', 'cropHeight'] as const).map((field) => (
                        <label key={field} className="space-y-1 text-xs text-neutral-400">
                          <span>{field}</span>
                          <input
                            type="number"
                            min="0"
                            step="0.05"
                            value={session.draft[field]}
                            onChange={(event) => setSession({ ...session, draft: { ...session.draft, [field]: Number(event.target.value) } })}
                            className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm"
                          />
                        </label>
                      ))}
                    </>
                  )}
                </div>
              ) : null}
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-xs text-neutral-400">
                  <span>{language === 'zh' ? '输出格式' : 'Output format'}</span>
                  <input
                    value={session.draft.outputFormat}
                    onChange={(event) => setSession({ ...session, draft: { ...session.draft, outputFormat: event.target.value } })}
                    className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm"
                  />
                </label>
                <label className="space-y-1 text-xs text-neutral-400">
                  <span>{language === 'zh' ? '目标轨道' : 'Target tracks'}</span>
                  <input
                    value={session.draft.targetTracks.join(',')}
                    onChange={(event) => setSession({ ...session, draft: { ...session.draft, targetTracks: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } })}
                    className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setSession(null)} disabled={busy}>
                  {language === 'zh' ? '取消' : 'Cancel'}
                </Button>
                <Button onClick={() => void handleSubmit()} disabled={busy} className="bg-orange-500 text-white hover:bg-orange-600">
                  {busy ? (language === 'zh' ? '处理中…' : 'Working…') : (language === 'zh' ? '生成派生节点' : 'Create derivative')}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {fullscreenOpen && sourceUrl ? <PreviewModal kind="video" src={sourceUrl} onClose={() => setFullscreenOpen(false)} /> : null}
    </>
  );
}

/** 音频节点的浮动工具条（选中且有音频时出现，音频生成/音频上传共用）：
 *  变速（真实生效，写 data.playbackRate 由播放器应用）· 音频裁剪 · 格式转换 ·
 *  音频提取 · 内容检测 · 下载。裁剪/转换/提取/检测暂无后端能力 — 按钮占位
 *  禁用，悬停提示即将上线。 */
const AUDIO_PLAYBACK_RATES = [1, 1.25, 1.5, 2, 0.5] as const;

function AudioActionToolbar({ sourceNodeId }: { sourceNodeId: string }) {
  const language = useStore((state) => state.language);
  const nodes = useStore((state) => state.nodes);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  const sourceData = (sourceNode?.data ?? {}) as Record<string, any>;
  const sourceUrl = typeof sourceData.url === 'string' ? sourceData.url : '';
  if (!sourceNode || !['audioNode', 'referenceAudioNode'].includes(sourceNode.type ?? '') || !sourceUrl) return null;

  const zh = language === 'zh';
  const rate = Number(sourceData.playbackRate) || 1;
  const cycleRate = () => {
    const idx = AUDIO_PLAYBACK_RATES.indexOf(rate as (typeof AUDIO_PLAYBACK_RATES)[number]);
    const next = AUDIO_PLAYBACK_RATES[(idx + 1) % AUDIO_PLAYBACK_RATES.length];
    updateNodeData(sourceNodeId, { playbackRate: next });
  };
  const comingSoon = zh ? '即将上线' : 'Coming soon';
  const actionButtonClass = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-100/88 transition-colors hover:bg-white/10 hover:text-white';
  const disabledClass = 'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-100/88';
  const downloadName = `${String(sourceData.customTitle || sourceData.sourceName || sourceNodeId).replace(/[^a-z0-9_\-一-鿿]+/gi, '-') || 'audio'}.mp3`;

  return (
    <div className="flex items-center gap-1 rounded-full border border-white/12 bg-[#0f141d]/88 px-2 py-1.5 text-neutral-100 backdrop-blur-xl shadow-[0_16px_40px_-18px_rgba(2,8,20,0.75),0_0_0_1px_rgba(56,189,248,0.08)]">
      <Button
        variant="ghost"
        size="sm"
        className={clsx(actionButtonClass, 'min-w-[52px] justify-center tabular-nums')}
        onClick={cycleRate}
        title={zh ? '播放速度（点击切换）' : 'Playback speed (click to cycle)'}
      >
        {rate}x
      </Button>
      <Button variant="ghost" size="sm" className={clsx(actionButtonClass, disabledClass)} disabled title={comingSoon}>
        <Scissors className="h-3.5 w-3.5" />
        {zh ? '音频裁剪' : 'Trim'}
      </Button>
      <Button variant="ghost" size="sm" className={clsx(actionButtonClass, disabledClass)} disabled title={comingSoon}>
        <ArrowRightLeft className="h-3.5 w-3.5" />
        {zh ? '格式转换' : 'Convert'}
      </Button>
      <Button variant="ghost" size="sm" className={clsx(actionButtonClass, disabledClass)} disabled title={comingSoon}>
        <Mic className="h-3.5 w-3.5" />
        {zh ? '音频提取' : 'Extract'}
      </Button>
      <div className="mx-1 h-5 w-px bg-white/10" />
      <Button variant="ghost" size="icon" className={disabledClass} disabled title={zh ? `内容检测 · ${comingSoon}` : `Safety check · ${comingSoon}`}>
        <ShieldCheck className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => {
          void downloadAsset(sourceUrl, downloadName);
        }}
        title={zh ? '下载' : 'Download'}
      >
        <Download className="h-4 w-4" />
      </Button>
    </div>
  );
}

export const TextNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  return (
    <BaseNode
      icon={Type}
      title={language === 'zh' ? '生成文本' : 'Generate Text'}
      tone="text"
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="text" fallbackModel="gpt-4.1-mini" />}
    >
      <div className={clsx('w-full min-h-[88px] rounded-[12px] border p-3 text-xs text-neutral-300 shadow-inner', NODE_TONE_STYLES.text.surface)}>
        {data.content || (language === 'zh' ? '输入文本后结果会出现在这里...' : 'Generated text will appear here...')}
      </div>
    </BaseNode>
  );
};

export const ImageNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const [preview, setPreview] = useState(false);
  const [panoramaPreview, setPanoramaPreview] = useState(false);
  const [naturalRatio, setNaturalRatio] = useState<string | null>(null);
  const paramAspect = getNodeParams(data).aspectRatio;
  const isPanorama = isLikelyPanoramaData(data);

  // Use the actual loaded image ratio if available, otherwise fall back to param.
  const effectiveAspect = naturalRatio ?? paramAspect;
  const genBox = mediaBoxFromAspect(parseAspectRatio(effectiveAspect));

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w && h) {
      const r = w / h;
      // Map to closest named ratio.
      if (r > 1.9) setNaturalRatio('2:1');
      else if (r > 1.6) setNaturalRatio('16:9');
      else if (r > 1.4) setNaturalRatio('3:2');
      else if (r > 1.2) setNaturalRatio('4:3');
      else if (r > 1.05) setNaturalRatio('5:4');
      else if (r > 0.95) setNaturalRatio('1:1');
      else if (r > 0.8) setNaturalRatio('4:5');
      else if (r > 0.7) setNaturalRatio('3:4');
      else if (r > 0.6) setNaturalRatio('2:3');
      else setNaturalRatio('9:16');
    }
  };

  return (
    <BaseNode
      icon={ImageIcon}
      tone="image"
      title={language === 'zh' ? '生成图像' : 'Generate Image'}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      width={genBox.width}
      smoothResize
      topFloatingPanel={data.url && data.status !== 'uploading' ? <ImageActionToolbar sourceNodeId={id} /> : undefined}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      {data.url ? (
        <div
          className={clsx('relative w-full overflow-hidden rounded-[12px] cursor-zoom-in transition-[height] duration-300 ease-out motion-reduce:transition-none', NODE_TONE_STYLES.image.surface)}
          style={{ height: genBox.height }}
          onDoubleClick={() => (isPanorama ? setPanoramaPreview(true) : setPreview(true))}
        >
          <ResilientImage
            src={data.url}
            alt=""
            className="h-full w-full object-cover select-none"
            onLoad={handleImageLoad}
            zh={language === 'zh'}
          />
          {isPanorama ? (
            <PanoramaOpenButton
              onClick={(event) => {
                event.stopPropagation();
                setPanoramaPreview(true);
              }}
              compact
            />
          ) : null}
        </div>
      ) : (
        <MediaEmptyPlaceholder
          icon={ImageIcon}
          zh={language === 'zh'}
          className={clsx('w-full transition-[height] duration-300 ease-out motion-reduce:transition-none', NODE_TONE_STYLES.image.surface)}
          style={{ height: genBox.height }}
          caption={{ zh: '输入提示词生成图片', en: 'Enter a prompt to generate' }}
        />
      )}
      {preview && data.url ? <PreviewModal kind="image" src={data.url} onClose={() => setPreview(false)} /> : null}
      {panoramaPreview && data.url ? <PanoramaPreviewModal src={data.url} nodeId={id} onClose={() => setPanoramaPreview(false)} /> : null}
    </BaseNode>
  );
};

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

function captureVideoFrame(video: HTMLVideoElement): string | null {
  try {
    const w = video.videoWidth || video.clientWidth;
    const h = video.videoHeight || video.clientHeight;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

async function captureViaProxy(videoUrl: string, time: number): Promise<string | null> {
  try {
    const proxyUrl = toRenderableMediaUrl(videoUrl);
    const resp = await fetch(proxyUrl, { credentials: 'include' });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const localUrl = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = localUrl;
    await new Promise<void>((r, j) => { v.onloadeddata = () => r(); v.onerror = () => j(); v.load(); });
    v.currentTime = time;
    await new Promise<void>((r) => { v.onseeked = () => r(); });
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    URL.revokeObjectURL(localUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

const VideoHoverControls = ({
  videoRef,
  hovered,
  onCapture,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  hovered: boolean;
  onCapture: (mode: 'current' | 'first' | 'last') => void;
}) => {
  const language = useStore((state) => state.language);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [captureOpen, setCaptureOpen] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);

  // Re-attach on hover too: the <video> element can mount AFTER this effect
  // first ran (a generated url arriving later), and the ref OBJECT identity
  // never changes — with [videoRef] alone the listeners were never bound and
  // the progress bar stayed frozen forever.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => setDuration(v.duration || 0);
    const onEnd = () => setPlaying(false);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('durationchange', onMeta);
    v.addEventListener('ended', onEnd);
    if (v.duration) setDuration(v.duration);
    setPlaying(!v.paused);
    setCurrentTime(v.currentTime);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('durationchange', onMeta);
      v.removeEventListener('ended', onEnd);
    };
  }, [videoRef, hovered]);

  // Smooth playhead: timeupdate only fires ~4 Hz; drive the bar per-frame
  // while playing so it glides instead of jumping.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setCurrentTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, videoRef]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {
        // A transient proxy failure at initial load bricks the element;
        // reload once and retry so the play button isn't permanently dead.
        v.load();
        v.play().catch(() => {});
      });
    } else {
      v.pause();
    }
  };

  const seekToClientX = (clientX: number) => {
    const bar = progressRef.current;
    const v = videoRef.current;
    if (!bar || !v || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * duration;
    setCurrentTime(v.currentTime);
  };

  if (!hovered) return null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 rounded-b-[20px] bg-gradient-to-t from-black/70 to-transparent px-3 py-2 nodrag" onClick={(e) => e.stopPropagation()}>
      <button onClick={togglePlay} className="flex h-6 w-6 shrink-0 items-center justify-center text-white/90 hover:text-white">
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <span className="shrink-0 text-[10px] tabular-nums text-white/70">{formatTime(currentTime)}</span>
      <div
        ref={progressRef}
        className="nodrag nopan relative flex-1 cursor-pointer touch-none py-1"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          seekToClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if ((e.buttons & 1) === 1) {
            e.stopPropagation();
            seekToClientX(e.clientX);
          }
        }}
      >
        <div className="h-1 rounded-full bg-white/20">
          <div className="h-full rounded-full bg-white/80" style={{ width: `${progress}%` }} />
        </div>
        <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white shadow" style={{ left: `${progress}%` }} />
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-white/70">{formatTime(duration)}</span>
      <div
        className="relative"
        onMouseEnter={() => setCaptureOpen(true)}
        onMouseLeave={() => setCaptureOpen(false)}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onCapture('current'); }}
          className="flex h-6 w-6 shrink-0 items-center justify-center text-white/70 hover:text-white"
        >
          <Camera className="h-3.5 w-3.5" />
        </button>
        {captureOpen ? (
          <div className="absolute bottom-full right-0 z-30 mb-0 min-w-[120px] rounded-lg border border-white/10 bg-[#1a1d22]/95 py-1 shadow-xl backdrop-blur-xl">
            <button onClick={(e) => { e.stopPropagation(); onCapture('first'); setCaptureOpen(false); }} className="w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/5">
              {language === 'zh' ? '截取首帧' : 'First frame'}
            </button>
            <button onClick={(e) => { e.stopPropagation(); onCapture('last'); setCaptureOpen(false); }} className="w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/5">
              {language === 'zh' ? '截取尾帧' : 'Last frame'}
            </button>
            <button onClick={(e) => { e.stopPropagation(); onCapture('current'); setCaptureOpen(false); }} className="w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/5">
              {language === 'zh' ? '截取当前帧' : 'Current frame'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

// SmartVideo — gallery-style hover preview for canvas video nodes (NeoWow-like).
//   • out of view  → the <video> is UNMOUNTED (no decode, no buffering); the
//                    poster is shown dimmed + grayscale, or a neutral grey box
//                    when there is no poster yet.
//   • in view, idle → first frame: a cheap poster <img> when available, else a
//                    paused <video preload="metadata"> painting frame 0.
//   • in view, hover → the <video> plays muted + looped.
// An IntersectionObserver with a 300px rootMargin warms items just before they
// scroll into view so hover-to-play feels instant; once fetched the browser's
// HTTP cache (proxy sends Cache-Control: max-age) makes re-entry instant too.
// The element is exposed via `videoRef` so frame-capture / hover-controls work.
function SmartVideo({
  src,
  poster,
  hovered: controlledHovered,
  videoRef: externalVideoRef,
  onLoadedMetadata,
}: {
  src: string;
  poster?: string;
  // Controlled by the parent when it also needs hover (e.g. to show capture
  // controls); otherwise omit and SmartVideo manages hover itself.
  hovered?: boolean;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  onLoadedMetadata?: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoRef = externalVideoRef ?? internalVideoRef;
  const [inView, setInView] = useState(false);
  const [internalHovered, setInternalHovered] = useState(false);
  const selfManageHover = controlledHovered === undefined;
  const hovered = controlledHovered ?? internalHovered;
  const renderable = toRenderableMediaUrl(src);
  const posterSrc = poster ? toRenderableMediaUrl(poster) : '';

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? false),
      { root: null, rootMargin: '300px', threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const playing = inView && hovered;
  // Mount the <video> when it should play, or when in view without a poster (so
  // the first frame can still paint). With a poster, idle-in-view stays a cheap
  // <img> and the decoder is only spun up on hover.
  const mountVideo = inView && (hovered || !posterSrc);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.play().catch(() => {});
    } else {
      v.pause();
      try { v.currentTime = 0; } catch { /* */ }
    }
  }, [playing, mountVideo, videoRef]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      onMouseEnter={selfManageHover ? () => setInternalHovered(true) : undefined}
      onMouseLeave={selfManageHover ? () => setInternalHovered(false) : undefined}
    >
      {posterSrc ? (
        <img
          src={posterSrc}
          alt=""
          draggable={false}
          className={clsx(
            'absolute inset-0 h-full w-full object-cover select-none transition-opacity duration-200',
            playing ? 'opacity-0' : inView ? 'opacity-100' : 'opacity-50 grayscale',
          )}
        />
      ) : !inView ? (
        <div className="absolute inset-0 bg-white/[0.03]" />
      ) : null}
      {mountVideo ? (
        <video
          ref={videoRef}
          src={renderable}
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover select-none"
          muted
          loop
          playsInline
          preload={playing ? 'auto' : 'metadata'}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            // Nudge the playhead a hair past zero so the browser paints exactly
            // one frame even when not playing (avoids a black idle tile).
            try { if (video.currentTime < 0.01) video.currentTime = 0.01; } catch { /* */ }
            if (playing) video.play().catch(() => {});
            onLoadedMetadata?.(event);
          }}
        />
      ) : null}
    </div>
  );
}

export const VideoNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const addNode = useStore((state) => state.addNode);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const saveCanvasToBackend = useStore((state) => state.saveCanvasToBackend);
  const nodes = useStore((state) => state.nodes);
  const [preview, setPreview] = useState(false);
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaAspectStyle = getMediaAspectRatioStyle(data);
  const aspectClass = getAspectRatioClass(getNodeParams(data).aspectRatio, 'aspect-video');

  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleMouseEnter = () => {
    if (hoverTimeout.current) {
      clearTimeout(hoverTimeout.current);
    }
    setHovered(true);
    videoRef.current?.play().catch(() => {});
  };
  const handleMouseLeave = () => {
    hoverTimeout.current = setTimeout(() => {
      setHovered(false);
      const v = videoRef.current;
      if (v) { v.pause(); v.currentTime = 0; }
    }, 150);
  };

  const handleCapture = useCallback(async (mode: 'current' | 'first' | 'last') => {
    const v = videoRef.current;
    if (!v || !data.url) return;

    const targetTime = mode === 'first' ? 0 : mode === 'last' ? Math.max(0, (v.duration || 0) - 0.05) : v.currentTime;

    if (mode !== 'current') {
      await new Promise<void>((resolve) => {
        const onSeeked = () => { v.removeEventListener('seeked', onSeeked); resolve(); };
        v.addEventListener('seeked', onSeeked);
        v.currentTime = targetTime;
      });
    }

    let dataUrl = captureVideoFrame(v);
    if (!dataUrl) {
      dataUrl = await captureViaProxy(data.url, targetTime);
    }
    if (!dataUrl) return;

    // Convert data URL to blob and upload to backend for a stable, lightweight URL.
    let stableUrl = dataUrl;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const form = new FormData();
      form.append('file', blob, `capture-${mode}-${Date.now()}.png`);
      const uploadResp = await fetch(resolveApiUrl('/api/app/upload'), { method: 'POST', body: form, credentials: 'include' });
      if (uploadResp.ok) {
        const json = await uploadResp.json();
        const rawUrl = json?.data?.url as string;
        if (rawUrl) {
          const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '') as string;
          stableUrl = apiBase ? `${apiBase.replace(/\/+$/, '')}${rawUrl}` : rawUrl;
        }
      }
    } catch { /* fall back to dataUrl if upload fails */ }

    const thisNode = nodes.find((n) => n.id === id);
    const pos = thisNode?.position ?? { x: 0, y: 0 };
    const label = mode === 'first' ? '首帧截图' : mode === 'last' ? '尾帧截图' : '视频截图';
    addNode({
      id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      type: 'referenceImageNode',
      position: { x: pos.x + 340, y: pos.y },
      data: { url: stableUrl, sourceName: label },
    } as any);
  }, [addNode, data.url, id, nodes]);

  return (
    <BaseNode
      icon={Video}
      tone="video"
      title={language === 'zh' ? '生成视频' : 'Generate Video'}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="video" fallbackModel="runway-gen3" />}
    >
      <div
        className="relative"
        onMouseEnter={data.url ? handleMouseEnter : undefined}
        onMouseLeave={data.url ? handleMouseLeave : undefined}
      >
        <div
          className={clsx(
            'relative flex items-center justify-center overflow-hidden rounded-[12px] border text-violet-100/40',
            NODE_TONE_STYLES.video.surface,
            mediaAspectStyle ? 'min-h-[120px]' : aspectClass,
            data.url && 'cursor-zoom-in',
          )}
          style={mediaAspectStyle}
          onDoubleClick={() => data.url && setPreview(true)}
        >
          {data.url ? (
            <SmartVideo
              src={data.url}
              poster={data.poster}
              hovered={hovered}
              videoRef={videoRef}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                const { videoWidth, videoHeight } = video;
                if (videoWidth && videoHeight && (data.mediaWidth !== videoWidth || data.mediaHeight !== videoHeight)) {
                  updateNodeData(id, { mediaWidth: videoWidth, mediaHeight: videoHeight });
                }
              }}
            />
          ) : data.poster ? (
            <img src={toRenderableMediaUrl(data.poster)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-60 select-none" />
          ) : null}
          {!data.url ? (
            <div className="relative z-10 flex flex-col items-center gap-2 text-neutral-500">
              <Video className="h-7 w-7 text-neutral-600" />
              <span className="text-[12px]">{language === 'zh' ? '输入提示词生成视频' : 'Enter a prompt to generate'}</span>
            </div>
          ) : null}
        </div>
        {data.url ? <VideoHoverControls videoRef={videoRef} hovered={hovered} onCapture={handleCapture} /> : null}
      </div>
      {preview && data.url ? <PreviewModal kind="video" src={data.url} onClose={() => setPreview(false)} /> : null}
    </BaseNode>
  );
};

export const ReferenceImageNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const [preview, setPreview] = useState(false);
  const [panoramaPreview, setPanoramaPreview] = useState(false);
  const displayName = getReferenceDisplayName(data);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const resolutionLabel = formatMediaResolution(data.mediaWidth, data.mediaHeight);
  const mediaBox = data.mediaWidth && data.mediaHeight ? mediaBoxFromAspect(data.mediaWidth / data.mediaHeight) : null;
  const isPanorama = isLikelyPanoramaData(data);
  const sourceKindLabel = data.sourceKind === 'upload'
    ? (language === 'zh' ? '上传' : 'Upload')
    : data.sourceKind === 'derived'
      ? (language === 'zh' ? '派生' : 'Derived')
      : data.sourceKind === 'generated'
        ? (language === 'zh' ? '生成' : 'Generated')
        : '';

  return (
    <BaseNode
      icon={ImageIcon}
      tone="neutral"
      title={<EditableNodeTitle nodeId={id} value={displayName || "Untitled"} field="sourceName" preserveExtension />}
      headerRight={[resolutionLabel, sourceKindLabel].filter(Boolean).join(' · ')}
      selected={selected}
      error={data.error}
      width={mediaBox?.width}
      topFloatingPanel={data.url && data.status !== 'uploading' ? <ImageActionToolbar sourceNodeId={id} /> : undefined}
    >
      <div
        className={clsx(
          // Node width follows the image aspect (wide 16:9 / narrow 9:16) at a
          // similar footprint; the box matches the aspect exactly so the image
          // fills it with no crop, no letterbox padding, no border.
          "relative w-full overflow-hidden rounded-[12px] cursor-zoom-in",
          NODE_TONE_STYLES.neutral.surface,
          mediaBox ? undefined : "aspect-video",
        )}
        style={mediaBox ? { height: mediaBox.height } : undefined}
        onDoubleClick={() => data.url && (isPanorama ? setPanoramaPreview(true) : setPreview(true))}
      >
        {data.url ? (
          <ResilientImage
            src={data.url}
            alt={displayName}
            className="h-full w-full object-cover select-none"
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (
                naturalWidth &&
                naturalHeight &&
                (data.mediaWidth !== naturalWidth || data.mediaHeight !== naturalHeight)
              ) {
                updateNodeData(id, { mediaWidth: naturalWidth, mediaHeight: naturalHeight });
              }
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-6 w-6 text-sky-100/40" />
          </div>
        )}
        {data.url && isPanorama ? (
          <PanoramaOpenButton
            onClick={(event) => {
              event.stopPropagation();
              setPanoramaPreview(true);
            }}
            compact
          />
        ) : null}
        {data.status === 'uploading' ? <UploadingOverlay progress={data.progress} /> : null}
      </div>
      {preview && data.url ? <PreviewModal kind="image" src={data.url} onClose={() => setPreview(false)} /> : null}
      {panoramaPreview && data.url ? <PanoramaPreviewModal src={data.url} nodeId={id} onClose={() => setPanoramaPreview(false)} /> : null}
    </BaseNode>
  );
};

export const ReferenceVideoNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const [preview, setPreview] = useState(false);
  const displayName = getReferenceDisplayName(data);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const resolutionLabel = formatMediaResolution(data.mediaWidth, data.mediaHeight);
  const mediaBox = data.mediaWidth && data.mediaHeight ? mediaBoxFromAspect(data.mediaWidth / data.mediaHeight) : null;
  const sourceKindLabel = data.sourceKind === 'upload'
    ? (language === 'zh' ? '上传' : 'Upload')
    : data.sourceKind === 'derived'
      ? (language === 'zh' ? '派生' : 'Derived')
      : data.sourceKind === 'generated'
        ? (language === 'zh' ? '生成' : 'Generated')
        : '';

  return (
    <BaseNode
      icon={Video}
      tone="neutral"
      title={<EditableNodeTitle nodeId={id} value={displayName || "Untitled"} field="sourceName" preserveExtension />}
      headerRight={[resolutionLabel, sourceKindLabel].filter(Boolean).join(' · ')}
      selected={selected}
      error={data.error}
      width={mediaBox?.width}
      topFloatingPanel={data.url && data.status !== 'uploading' ? <VideoActionToolbar sourceNodeId={id} /> : undefined}
    >
      <div
        className={clsx(
          // Node width follows the video aspect; the box matches it exactly
          // (borderless, no padding). See ReferenceImageNode.
          "relative w-full overflow-hidden rounded-[12px] cursor-zoom-in",
          NODE_TONE_STYLES.neutral.surface,
          mediaBox ? undefined : "aspect-video",
        )}
        style={mediaBox ? { height: mediaBox.height } : undefined}
        onDoubleClick={() => data.url && setPreview(true)}
      >
        {data.url ? (
          <SmartVideo
            src={data.url}
            poster={data.poster}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              const { videoWidth, videoHeight } = video;
              if (
                videoWidth &&
                videoHeight &&
                (data.mediaWidth !== videoWidth || data.mediaHeight !== videoHeight)
              ) {
                updateNodeData(id, { mediaWidth: videoWidth, mediaHeight: videoHeight });
              }
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Video className="h-6 w-6 text-sky-100/40" />
          </div>
        )}
        {data.status === 'uploading' ? <UploadingOverlay progress={data.progress} /> : null}
      </div>
      {preview && data.url ? <PreviewModal kind="video" src={data.url} onClose={() => setPreview(false)} /> : null}
    </BaseNode>
  );
};

export const AudioNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  return (
    <BaseNode
      icon={Music}
      tone="audio"
      title={language === 'zh' ? '生成音频' : 'Generate Audio'}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="audio" fallbackModel="suno-v4" />}
    >
      <div className={clsx('flex items-center space-x-3 rounded-[12px] border p-3 text-neutral-200 shadow-inner', NODE_TONE_STYLES.audio.surface)}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/18">
          <Music className="h-3.5 w-3.5 text-emerald-300" />
        </div>
        <div className="flex-1">
          <div className="flex h-6 items-end gap-[2px]">
            {Array.from({ length: 28 }).map((_, index) => (
              <div
                key={index}
                className="flex-1 rounded-sm bg-emerald-300/45"
                style={{ height: `${20 + Math.abs(Math.sin(index * 0.7) * 80)}%` }}
              />
            ))}
          </div>
        </div>
      </div>
    </BaseNode>
  );
};

// Audio time as m:ss.s (tenths) to match the reference design's readout.
// Guards NaN/Infinity — an <audio> reports NaN duration until metadata loads,
// which otherwise rendered "NaN:0NaN" in the total-time slot.
const formatAudioTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const tenth = Math.floor((s * 10) % 10);
  return `${m}:${String(sec).padStart(2, '0')}.${tenth}`;
};

// Deterministic per-node waveform bar heights (0.28..1.0). We don't decode the
// actual PCM (cheap + avoids CORS on remote audio); a stable pseudo-random
// silhouette reads as a waveform and never reflows between renders.
const AUDIO_BAR_COUNT = 34;
function audioBarHeights(seed: string): number[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < AUDIO_BAR_COUNT; i++) {
    h = (Math.imul(h, 1103515245) + 12345) & 0x7fffffff;
    out.push(0.28 + (h % 1000) / 1000 * 0.72);
  }
  return out;
}

/** 可复用的波形播放卡 — 音频上传 / 音频生成节点共用同一套播放器。
 *  伪波形（按节点 id 确定性生成）、点击/拖拽 seek、rAF 平滑播放头、m:ss.s
 *  读数、格式角标、右上角下载；播放速率由节点 data.playbackRate 驱动
 *  （AudioActionToolbar 写入，这里应用到 <audio> 元素）。 */
function AudioWaveformPlayer({
  nodeId,
  rawUrl,
  downloadName,
  formatBadge,
  playbackRate = 1,
}: {
  nodeId: string;
  /** 未包装的原始 url（下载用）；播放地址内部再走 toRenderableMediaUrl。 */
  rawUrl: string;
  downloadName: string;
  formatBadge: string;
  playbackRate?: number;
}) {
  const language = useStore((state) => state.language);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const bars = useMemo(() => audioBarHeights(nodeId), [nodeId]);
  const playableUrl = rawUrl ? toRenderableMediaUrl(rawUrl) : '';
  const effectiveRate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(a.currentTime);
    const onMeta = () => { if (Number.isFinite(a.duration)) setDuration(a.duration); };
    const onEnd = () => { setPlaying(false); setCurrentTime(0); };
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    a.addEventListener('ended', onEnd);
    if (Number.isFinite(a.duration)) setDuration(a.duration);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.removeEventListener('ended', onEnd);
    };
  }, [playableUrl]);

  // 变速：url 变化会重建元素、load() 重试会重置速率，两处都要重放。
  useEffect(() => {
    const a = audioRef.current;
    if (a) a.playbackRate = effectiveRate;
  }, [effectiveRate, playableUrl]);

  // Smooth playhead: timeupdate only fires ~4 Hz; advance the waveform
  // per-frame while playing so the bars sweep instead of stuttering.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) setCurrentTime(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = (event: React.MouseEvent) => {
    event.stopPropagation();
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().catch(() => {
        // A transient proxy failure at initial load bricks the element;
        // reload once and retry so play isn't permanently dead.
        a.load();
        a.playbackRate = effectiveRate;
        a.play().catch(() => {});
      });
    } else {
      a.pause();
    }
  };

  const seekToClientX = (clientX: number) => {
    const bar = barRef.current;
    const a = audioRef.current;
    if (!bar || !a || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setCurrentTime(a.currentTime);
  };

  const progress = duration > 0 ? currentTime / duration : 0;
  const playedBars = Math.round(progress * bars.length);

  return (
    <div className={clsx('relative rounded-[12px] border p-3 pt-2.5 text-neutral-200 shadow-inner', NODE_TONE_STYLES.audio.surface)}>
      {playableUrl ? <audio ref={audioRef} src={playableUrl} preload="metadata" className="hidden" /> : null}

      {/* download — mirrors the reference's top-right affordance */}
      {playableUrl ? (
        <button
          type="button"
          className="nodrag absolute right-2.5 top-2.5 z-10 flex h-6 w-6 items-center justify-center rounded-md text-white/45 transition hover:bg-white/10 hover:text-white/80"
          title={language === 'zh' ? '下载' : 'Download'}
          onClick={(event) => {
            event.stopPropagation();
            void downloadAsset(rawUrl, downloadName);
          }}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      ) : null}

      {/* seekable waveform — click or drag to scrub */}
      <div
        ref={barRef}
        className="nodrag nopan mt-3 flex h-12 cursor-pointer touch-none items-center gap-[2px]"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          seekToClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if ((event.buttons & 1) === 1) {
            event.stopPropagation();
            seekToClientX(event.clientX);
          }
        }}
      >
        {bars.map((height, index) => (
          <div
            key={index}
            className={clsx(
              'flex-1 rounded-full transition-colors',
              index < playedBars ? 'bg-emerald-300/85' : 'bg-white/18',
            )}
            style={{ height: `${Math.round(height * 100)}%` }}
          />
        ))}
      </div>

      {/* transport: time · play · format */}
      <div className="mt-2.5 flex items-center gap-3">
        <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">
          {formatAudioTime(currentTime)} / {formatAudioTime(duration)}
        </span>
        <div className="flex flex-1 justify-center">
          <button
            type="button"
            onClick={togglePlay}
            disabled={!playableUrl}
            className="nodrag flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/90 transition hover:bg-white/15 disabled:opacity-40"
            title={playing ? (language === 'zh' ? '暂停' : 'Pause') : (language === 'zh' ? '播放' : 'Play')}
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="ml-0.5 h-3.5 w-3.5" />}
          </button>
        </div>
        <span className="shrink-0 rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-400">
          {formatBadge}
        </span>
      </div>
    </div>
  );
}

/**
 * Uploaded-audio reference node — an MP3/WAV/etc. dropped onto the canvas.
 * Renders the shared AudioWaveformPlayer card, mirroring the reference design.
 * Distinct from AudioNode (the decorative TTS "generate audio" node).
 */
export const AudioReferenceNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const displayName = getReferenceDisplayName(data);
  const formatBadge = (String(data.sourceName ?? '').split('.').pop() || 'audio')
    .toUpperCase()
    .slice(0, 4);
  const sourceKindLabel = data.sourceKind === 'upload'
    ? (language === 'zh' ? '上传' : 'Upload')
    : data.sourceKind === 'derived'
      ? (language === 'zh' ? '派生' : 'Derived')
      : data.sourceKind === 'generated'
        ? (language === 'zh' ? '生成' : 'Generated')
        : '';

  return (
    <BaseNode
      icon={Music}
      tone="audio"
      title={<EditableNodeTitle nodeId={id} value={displayName || 'Audio'} field="sourceName" preserveExtension />}
      headerRight={sourceKindLabel}
      selected={selected}
      error={data.error}
      topFloatingPanel={data.url && data.status !== 'uploading' ? <AudioActionToolbar sourceNodeId={id} /> : undefined}
    >
      <div className="relative">
        <AudioWaveformPlayer
          nodeId={id}
          rawUrl={String(data.url ?? '')}
          downloadName={displayName || `audio.${formatBadge.toLowerCase()}`}
          formatBadge={formatBadge}
          playbackRate={Number(data.playbackRate) || 1}
        />
        {data.status === 'uploading' ? <UploadingOverlay progress={data.progress} /> : null}
      </div>
    </BaseNode>
  );
};

export const PanoramaNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const [panoramaPreview, setPanoramaPreview] = useState(false);
  const aspectClass = getAspectRatioClass(getNodeParams(data).aspectRatio, 'aspect-[2/1]');
  return (
    <BaseNode
      icon={Globe}
      tone="neutral"
      title={language === 'zh' ? '生成全景' : '360 Environment'}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      topFloatingPanel={data.url && data.status !== 'uploading' ? <ImageActionToolbar sourceNodeId={id} /> : undefined}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      <div
        className={clsx('relative flex items-center justify-center overflow-hidden rounded-[12px]', NODE_TONE_STYLES.neutral.surface, aspectClass, data.url && 'cursor-zoom-in')}
        onDoubleClick={() => data.url && setPanoramaPreview(true)}
      >
        {data.url ? (
          <>
            <ResilientImage src={data.url} alt="" className="h-full w-full object-cover select-none" zh={language === 'zh'} />
            <PanoramaOpenButton
              onClick={(event) => {
                event.stopPropagation();
                setPanoramaPreview(true);
              }}
            />
          </>
        ) : <Globe className="h-6 w-6 text-sky-100/40" />}
      </div>
      {panoramaPreview && data.url ? <PanoramaPreviewModal src={data.url} nodeId={id} onClose={() => setPanoramaPreview(false)} /> : null}
    </BaseNode>
  );
};

const RenamableTextNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const title = data.customTitle || (language === 'zh' ? '生成文本' : 'Generate Text');
  return (
    <BaseNode
      icon={Type}
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      tone="text"
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="text" fallbackModel="gpt-4.1-mini" />}
    >
      <div className={clsx('w-full min-h-[88px] rounded-[12px] border p-3 text-xs text-neutral-300 shadow-inner', NODE_TONE_STYLES.text.surface)}>
        {data.content || (language === 'zh' ? '输入文本后结果会出现在这里...' : 'Generated text will appear here...')}
      </div>
    </BaseNode>
  );
};

/**
 * Loads `<img>` and surfaces failures with a retry affordance. Image
 * generation often returns a third-party URL that gets blocked by CORS,
 * mixed-content rules, or just expires before the user comes back — a
 * silent blank rectangle is a much worse UX than a clickable "retry" pill.
 *
 * - onLoad bubbles up so consumers can record naturalWidth/Height
 * - onError catches network/decode failures and shows a fallback
 * - Clicking the fallback re-tries with a cache-busting query
 */
function ResilientImage({
  src,
  alt = "",
  className,
  onLoad,
  zh = true,
}: {
  src: string;
  alt?: string;
  className?: string;
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  zh?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [useProxy, setUseProxy] = useState(false);
  const [bust, setBust] = useState(0);
  // 自动退避重试次数(across direct+proxy 之后的软重试)。刚生成成功的图常因
  // COS 最终一致性/代理瞬时抖动首次加载失败,退避几次多半就好了 —— 之前直接
  // 弹「点击重试」,用户手动点一下才成,体验割裂。
  const autoRetries = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const MAX_AUTO_RETRIES = 4;

  // First load: try the raw asset directly. If that fails and it's a remote
  // URL, automatically retry via the backend's /api/app/proxy-media endpoint —
  // sidesteps CORS, referrer policy, and mixed-content blocks in one shot.
  // `src` may itself already be proxy-wrapped (legacy persisted data); peel it
  // for the direct attempt and use the idempotent helper for the proxy retry
  // so neither path can double-wrap.
  const directSrc = extractOriginalMediaUrl(src) || src;
  const isRemote = /^https?:\/\//.test(directSrc);
  const proxiedSrc = toRenderableMediaUrl(src);
  const baseSrc = useProxy ? proxiedSrc : directSrc;
  const finalSrc = bust > 0 ? `${baseSrc}${baseSrc.includes("?") ? "&" : "?"}_r=${bust}` : baseSrc;

  useEffect(() => {
    setFailed(false);
    setUseProxy(false);
    setBust(0);
    autoRetries.current = 0;
    return () => { if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; } };
  }, [src]);

  const handleError = () => {
    // First failure on a remote URL → fall back to backend proxy silently.
    if (isRemote && !useProxy) {
      setUseProxy(true);
      return;
    }
    // 直连 + 代理都失败:先做退避软重试(700/1400/2800/5600ms,带 cache-bust
    // 绕过负缓存),仍不行才亮「点击重试」。
    if (autoRetries.current < MAX_AUTO_RETRIES) {
      const n = (autoRetries.current += 1);
      const delay = Math.min(6000, 700 * 2 ** (n - 1));
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = window.setTimeout(() => { setBust((b) => b + 1); }, delay);
      return;
    }
    setFailed(true);
  };

  const handleLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    autoRetries.current = 0;
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    onLoad?.(event);
  };

  if (failed) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setFailed(false);
          autoRetries.current = 0;
          setBust((n) => n + 1);
        }}
        className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-[12px] border border-rose-400/20 bg-rose-500/[0.04] text-[11px] text-rose-200 transition hover:bg-rose-500/10"
        title={src}
      >
        <ImageOff className="h-5 w-5" />
        <span>{zh ? "图片加载失败 · 点击重试" : "Image failed · click to retry"}</span>
      </button>
    );
  }
  return (
    <img
      src={finalSrc}
      alt={alt}
      draggable={false}
      className={className}
      // Many third-party image hosts (Chinese provider relays, Cloudflare-
      // protected R2 buckets, etc.) reject requests where the Referer
      // header points at a different origin. `no-referrer` strips the
      // header entirely — fixes the silent-blank-image case for direct
      // loads (we also have the backend proxy fallback above).
      referrerPolicy="no-referrer"
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}

// PanoramaSphere renders the equirectangular panorama on the inside of a
// sphere (BackSide), with the camera at the origin. This is the standard
// way to view a 2:1 360 panorama as a true sphere — instead of a flat
// horizontally-scrolling strip, the viewer sees the world projected onto
// the inside of the sphere and can look around in 360°.
function PanoramaSphere({ texture }: { texture: THREE.Texture }) {
  return (
    <mesh scale={[-1, 1, 1]}>
      <sphereGeometry args={[50, 64, 40]} />
      <meshBasicMaterial map={texture} side={THREE.BackSide} toneMapped={false} />
    </mesh>
  );
}

// PanoramaCameraRig drives the camera rotation from yaw/pitch state. The
// camera stays at origin (we never translate it — only rotate). Yaw rotates
// around world-Y, pitch tilts up/down.
function PanoramaCameraRig({ yaw, pitch, fov }: { yaw: number; pitch: number; fov: number }) {
  const { camera } = useThree();
  useEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }, [camera, fov]);
  useFrame(() => {
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    camera.rotation.z = 0;
  });
  return null;
}

function PanoramaPreviewModal({
  src,
  nodeId,
  onClose,
}: {
  src: string;
  nodeId: string;
  onClose: () => void;
}) {
  const language = useStore((state) => state.language);
  const nodes = useStore((state) => state.nodes);
  const addNode = useStore((state) => state.addNode);
  const onConnect = useStore((state) => state.onConnect);
  // yaw / pitch in radians, mapped to camera rotation. yaw wraps over 2π,
  // pitch clamped to ±~75° so the viewer can't flip past the poles.
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [fov, setFov] = useState(75);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number; width: number; height: number } | null>(null);
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const sourceNode = nodes.find((node) => node.id === nodeId);

  // Load the panorama as a Three.js texture. We go through loadImageElement
  // (which fetches via the proxy-media endpoint into a blob: URL) — blob
  // URLs are CORS-free, which sidesteps the "tainted canvas" / CORS failure
  // that bare TextureLoader hits on cross-origin equirectangular images.
  useEffect(() => {
    let cancelled = false;
    let createdTexture: THREE.Texture | null = null;
    (async () => {
      try {
        const img = await loadImageElement(src);
        if (cancelled) return;
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        createdTexture = tex;
        setTexture(tex);
      } catch (err) {
        if (cancelled) return;
        // Surface a useful message: loadImageElement may throw a real Error
        // (proxy non-2xx), but DOM image errors come through as plain
        // exceptions with name "Error" too.
        const msg = err instanceof Error && err.message ? err.message : 'Failed to load panorama';
        setError(msg);
      }
    })();
    return () => {
      cancelled = true;
      if (createdTexture) createdTexture.dispose();
    };
  }, [src]);

  // Capture the current view by reading the WebGL canvas directly. We force
  // a render before reading so the buffer matches what the user sees, then
  // resize-blit it to a 1280x720 output canvas (consistent with what the
  // backend treats as a "reference image"). The renderer is created with
  // preserveDrawingBuffer:true so toDataURL doesn't return a blank image.
  const captureCurrentView = useCallback(async () => {
    if (capturing) return;
    const gl = glRef.current;
    if (!gl) {
      setError('Renderer not ready');
      return;
    }
    setCapturing(true);
    setError(null);
    try {
      // Force a render pass so the framebuffer reflects the current pose.
      const scene = (gl as unknown as { scene?: THREE.Scene }).scene;
      const camera = (gl as unknown as { camera?: THREE.Camera }).camera;
      if (scene && camera) {
        gl.render(scene, camera);
      }
      const srcCanvas = gl.domElement;
      const outW = 1280;
      const outH = 720;
      const outCanvas = document.createElement('canvas');
      outCanvas.width = outW;
      outCanvas.height = outH;
      const ctx = outCanvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, outW, outH);

      const dataUrl = await canvasToDataUrl(outCanvas);
      let stableUrl = dataUrl;
      try {
        stableUrl = await uploadImageSource(dataUrl, `panorama-view-${Date.now()}.png`);
      } catch {
        // DataURL still works locally if upload is temporarily unavailable.
      }
      const base = sourceNode?.position ?? { x: 0, y: 0 };
      const captureId = `pano-view-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      addNode({
        id: captureId,
        type: 'referenceImageNode',
        position: { x: base.x + 360, y: base.y + 90 },
        data: {
          url: stableUrl,
          sourceName: language === 'zh' ? '全景视角截图.png' : 'panorama-view.png',
          sourceKind: 'derived',
          sourceNodeId: nodeId,
          derivedFromNodeId: nodeId,
          derivationAction: 'panorama_capture',
          mediaWidth: outW,
          mediaHeight: outH,
        },
      } as never);
      onConnect({ source: nodeId, target: captureId, sourceHandle: null, targetHandle: null } as never);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  }, [addNode, capturing, language, nodeId, onConnect, sourceNode?.position]);

  // Drag converts pixel deltas into camera rotation: full panel width
  // covers 360° yaw, full panel height covers ~135° pitch.
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = { x: event.clientX, y: event.clientY, yaw, pitch, width: rect.width, height: rect.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const yawSpan = Math.PI * 2;
    const pitchSpan = Math.PI * 0.75;
    const pitchLimit = Math.PI * 0.42;
    const nextYaw = start.yaw - (dx / Math.max(1, start.width)) * yawSpan;
    const nextPitch = clampNumber(start.pitch + (dy / Math.max(1, start.height)) * pitchSpan, -pitchLimit, pitchLimit);
    setYaw(nextYaw);
    setPitch(nextPitch);
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer may already be released by the browser.
    }
  };

  // Wheel zooms by changing FOV (smaller fov = closer view).
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
    setFov((prev) => clampNumber(prev + (event.deltaY > 0 ? 4 : -4), 30, 100));
  };

  // Yaw normalized to 0–360 for the readout.
  const yawDeg = (((yaw * 180 / Math.PI) % 360) + 360) % 360;
  const pitchDeg = -pitch * 180 / Math.PI;

  return createPortal(
    <div className="fixed inset-0 z-[240] flex items-center justify-center bg-black/86 p-6 backdrop-blur-xl" onMouseDown={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-white/12 bg-[#0d1015] shadow-[0_30px_120px_rgba(0,0,0,0.62)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-white">{language === 'zh' ? '720° 全景预览' : '720° panorama preview'}</div>
            <div className="mt-1 text-xs text-neutral-400">
              {language === 'zh' ? '拖动旋转视角，滚轮缩放，截出当前角度会生成新的参考图节点。' : 'Drag to rotate, wheel to zoom. Capture creates a new reference image node.'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={captureCurrentView}
              disabled={capturing || !texture}
              className="rounded-xl border border-cyan-300/25 bg-cyan-400/12 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {capturing ? (language === 'zh' ? '截图中...' : 'Capturing...') : (language === 'zh' ? '截出当前角度' : 'Capture angle')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-neutral-200 transition hover:bg-white/10"
            >
              {language === 'zh' ? '关闭' : 'Close'}
            </button>
          </div>
        </div>
        <div className="p-5">
          <div
            className="relative h-[68vh] min-h-[360px] overflow-hidden rounded-2xl border border-white/10 bg-black shadow-inner cursor-grab active:cursor-grabbing select-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
          >
            {texture ? (
              <Canvas
                gl={{ preserveDrawingBuffer: true, antialias: true }}
                camera={{ fov, near: 0.1, far: 1100, position: [0, 0, 0] }}
                onCreated={(state) => {
                  glRef.current = state.gl;
                  // Stash scene/camera on the renderer so captureCurrentView
                  // can force a render before reading the framebuffer.
                  (state.gl as unknown as { scene?: THREE.Scene; camera?: THREE.Camera }).scene = state.scene;
                  (state.gl as unknown as { scene?: THREE.Scene; camera?: THREE.Camera }).camera = state.camera;
                }}
                className="absolute inset-0"
              >
                <PanoramaSphere texture={texture} />
                <PanoramaCameraRig yaw={yaw} pitch={pitch} fov={fov} />
              </Canvas>
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-neutral-500">
                {language === 'zh' ? '加载中...' : 'Loading...'}
              </div>
            )}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/45 to-transparent" />
            <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-cyan-200/35" />
            <div className="pointer-events-none absolute left-4 top-4 rounded-full border border-white/12 bg-black/45 px-3 py-1 text-xs text-white/80 backdrop-blur tabular-nums">
              yaw {Math.round(yawDeg)}° · pitch {Math.round(pitchDeg)}° · fov {Math.round(fov)}°
            </div>
          </div>
          {error ? (
            <div className="mt-3 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
              {language === 'zh' ? `预览失败：${error}` : `Preview failed: ${error}`}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PanoramaOpenButton({ onClick, compact = false }: { onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-xl border border-white/12 bg-black/55 text-[11px] font-semibold text-white/85 shadow-lg backdrop-blur-md transition hover:border-cyan-300/35 hover:bg-cyan-400/20 hover:text-cyan-50',
        compact ? 'px-2 py-1' : 'px-2.5 py-1.5',
      )}
      title="Panorama preview"
    >
      <Globe className="h-3.5 w-3.5" />
      720
    </button>
  );
}

const RenamableImageNode = ({ id, data: rawData, selected }: any) => {
  // Defensive: agent-created nodes (or other producers) may omit `data`.
  // Without this fallback, React crashes the entire workspace on render.
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const addNode = useStore((state) => state.addNode);
  const onConnect = useStore((state) => state.onConnect);
  const addHistory = useStore((state) => state.addHistory);
  const [preview, setPreview] = useState(false);
  const [panoramaPreview, setPanoramaPreview] = useState(false);
  const [naturalRatio, setNaturalRatio] = useState<string | null>(null);
  const paramAspect = getNodeParams(data).aspectRatio;
  const title = data.customTitle || (language === 'zh' ? '生成图像' : 'Generate Image');
  const effectiveAspect = naturalRatio ?? paramAspect;
  const genBox = mediaBoxFromAspect(parseAspectRatio(effectiveAspect));
  const isPanorama = isLikelyPanoramaData(data);

  // 画笔标注 session: null = off. Ops/redo live here so the toolbar (in the
  // topFloatingPanel slot) and the drawing layer (over the media box) share
  // one source of truth.
  const [annotate, setAnnotate] = useState<null | {
    tool: 'pen' | 'text';
    color: string;
    width: number;
    ops: AnnotateOp[];
    redo: AnnotateOp[];
  }>(null);
  const [annotateSaving, setAnnotateSaving] = useState(false);
  const annotating = annotate !== null;
  const isConnectionDragging = useStore((state) => state.isConnectionDragging);

  // 标注期间接管全局快捷键（capture 期，压过画布的删除/撤销处理器）：
  // Backspace/Delete/Ctrl+Z = 撤销一笔（而不是删掉整个节点/画布撤销），
  // Ctrl+Shift+Z / Ctrl+Y = 重做，Esc = 退出标注。
  useEffect(() => {
    if (!annotating) return;
    const undoOp = () => setAnnotate((s) => (s && s.ops.length > 0 ? { ...s, ops: s.ops.slice(0, -1), redo: [...s.redo, s.ops[s.ops.length - 1]] } : s));
    const redoOp = () => setAnnotate((s) => (s && s.redo.length > 0 ? { ...s, ops: [...s.ops, s.redo[s.redo.length - 1]], redo: s.redo.slice(0, -1) } : s));
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
      if (event.key === 'Escape') {
        if (typing) return; // let the text-draft input handle its own Escape
        event.preventDefault();
        event.stopPropagation();
        setAnnotate(null);
        return;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !typing) {
        event.preventDefault();
        event.stopPropagation();
        undoOp();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) redoOp();
        else undoOp();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        event.stopPropagation();
        redoOp();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [annotating]);

  // 取消选中时：空白标注会话直接退出（工具栏跟着选中态走，避免只剩
  // 一层没有出口的画布）；已有笔迹则保留会话，点回节点即可继续。
  useEffect(() => {
    if (!annotating || selected) return;
    setAnnotate((s) => (s && s.ops.length === 0 ? null : s));
  }, [annotating, selected]);

  const handleAnnotateSave = async () => {
    if (!annotate || annotateSaving) return;
    if (annotate.ops.length === 0) {
      setAnnotate(null);
      return;
    }
    setAnnotateSaving(true);
    try {
      const blob = await renderAnnotatedImage(String(data.url), annotate.ops, genBox.width, genBox.height);
      const objectUrl = URL.createObjectURL(blob);
      let stableUrl: string;
      try {
        stableUrl = await uploadImageSource(objectUrl, `annotated-${id}-${Date.now()}.png`);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      // 原图不动：标注结果落成一个新的派生节点并连线（与超分一致的模式）。
      const annotatedId = `img-annotate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const basePosition = useStore.getState().nodes.find((node) => node.id === id)?.position ?? { x: 0, y: 0 };
      addNode({
        id: annotatedId,
        type: 'imageNode',
        position: { x: basePosition.x + 360, y: basePosition.y + Math.random() * 40 - 20 },
        data: {
          customTitle: language === 'zh' ? '标注图' : 'Annotated image',
          url: stableUrl,
          output: stableUrl,
          status: 'done',
          sourceKind: 'derived',
          derivedFromNodeId: id,
          derivationAction: 'annotate',
          generationParams: {
            aspectRatio: effectiveAspect,
          },
        },
      } as never);
      onConnect({ source: id, target: annotatedId, sourceHandle: null, targetHandle: null } as never);
      addHistory({
        id: `annotate-${id}-${Date.now()}`,
        title: `${data.customTitle || (language === 'zh' ? '画笔标注' : 'Annotated image')}`,
        type: 'image',
        mediaType: 'image',
        timestamp: Date.now(),
        thumbnail: stableUrl,
        promptExcerpt: typeof data.prompt === 'string' ? data.prompt.slice(0, 120) : undefined,
        sourceNodeId: id,
        derivationAction: 'annotate',
      });
      setAnnotate(null);
    } catch (err) {
      toast.error(language === 'zh' ? `标注保存失败：${err instanceof Error ? err.message : String(err)}` : `Failed to save annotation: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAnnotateSaving(false);
    }
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w && h) {
      const r = w / h;
      if (r > 1.9) setNaturalRatio('2:1');
      else if (r > 1.6) setNaturalRatio('16:9');
      else if (r > 1.4) setNaturalRatio('3:2');
      else if (r > 1.2) setNaturalRatio('4:3');
      else if (r > 1.05) setNaturalRatio('5:4');
      else if (r > 0.95) setNaturalRatio('1:1');
      else if (r > 0.8) setNaturalRatio('4:5');
      else if (r > 0.7) setNaturalRatio('3:4');
      else if (r > 0.6) setNaturalRatio('2:3');
      else setNaturalRatio('9:16');
    }
  };

  return (
    <BaseNode
      icon={ImageIcon}
      tone="image"
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      selected={selected}
      width={genBox.width}
      smoothResize
      topFloatingPanel={
        annotate
          ? (
            <ImageAnnotateToolbar
              zh={language === 'zh'}
              tool={annotate.tool}
              setTool={(tool) => setAnnotate((s) => (s ? { ...s, tool } : s))}
              color={annotate.color}
              setColor={(color) => setAnnotate((s) => (s ? { ...s, color } : s))}
              width={annotate.width}
              setWidth={(width) => setAnnotate((s) => (s ? { ...s, width } : s))}
              canUndo={annotate.ops.length > 0}
              canRedo={annotate.redo.length > 0}
              onUndo={() => setAnnotate((s) => (s && s.ops.length > 0 ? { ...s, ops: s.ops.slice(0, -1), redo: [...s.redo, s.ops[s.ops.length - 1]] } : s))}
              onRedo={() => setAnnotate((s) => (s && s.redo.length > 0 ? { ...s, ops: [...s.ops, s.redo[s.redo.length - 1]], redo: s.redo.slice(0, -1) } : s))}
              onExit={() => setAnnotate(null)}
              onSave={() => void handleAnnotateSave()}
              saving={annotateSaving}
            />
          )
          : data.url && data.status !== 'uploading'
            ? (
              <ImageActionToolbar
                sourceNodeId={id}
                onAnnotate={() => setAnnotate({ tool: 'pen', color: ANNOTATE_COLORS[0], width: 6, ops: [], redo: [] })}
              />
            )
            : undefined
      }
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      {data.url ? (
        <div
          className={clsx(
            'relative w-full overflow-hidden rounded-[12px]',
            annotate ? 'cursor-crosshair' : 'cursor-zoom-in',
            // 标注中不做高度过渡 — 画笔层按最终尺寸测量位图，动画中间值会量错。
            !annotate && 'transition-[height] duration-300 ease-out motion-reduce:transition-none',
            NODE_TONE_STYLES.image.surface,
          )}
          style={{ height: genBox.height }}
          onDoubleClick={() => {
            if (annotate) return;
            if (isPanorama) setPanoramaPreview(true);
            else setPreview(true);
          }}
        >
          <ResilientImage
            src={data.url}
            className="h-full w-full object-cover select-none"
            onLoad={handleImageLoad}
            zh={language === 'zh'}
          />
          <NodeVersionsBadge
            nodeId={id}
            activeUrl={data.url}
            activePrompt={data.prompt}
            activeModel={data.model}
            versions={(data.versions ?? []) as NodeVersion[]}
            mediaKind="image"
          />
          {isPanorama && !annotate ? (
            <PanoramaOpenButton
              onClick={(event) => {
                event.stopPropagation();
                setPanoramaPreview(true);
              }}
              compact
            />
          ) : null}
          {annotate ? (
            <ImageAnnotateLayer
              // Re-key on media box changes (e.g. naturalRatio arriving) so the
              // bitmap re-measures; ops are normalized and survive the remount.
              key={`${genBox.width}x${genBox.height}`}
              tool={annotate.tool}
              color={annotate.color}
              width={annotate.width}
              ops={annotate.ops}
              suspended={annotateSaving || isConnectionDragging}
              onCommit={(op) => setAnnotate((s) => (s ? { ...s, ops: [...s.ops, op], redo: [] } : s))}
            />
          ) : null}
        </div>
      ) : (
        <MediaEmptyPlaceholder
          icon={ImageIcon}
          zh={language === 'zh'}
          className={clsx('w-full transition-[height] duration-300 ease-out motion-reduce:transition-none', NODE_TONE_STYLES.image.surface)}
          style={{ height: genBox.height }}
          caption={{ zh: '输入提示词生成图片', en: 'Enter a prompt to generate' }}
        />
      )}
      {preview && data.url ? <PreviewModal kind="image" src={data.url} onClose={() => setPreview(false)} /> : null}
      {panoramaPreview && data.url ? <PanoramaPreviewModal src={data.url} nodeId={id} onClose={() => setPanoramaPreview(false)} /> : null}
    </BaseNode>
  );
};

const RenamableVideoNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const addNode = useStore((state) => state.addNode);
  const nodes = useStore((state) => state.nodes);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const [preview, setPreview] = useState(false);
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoBox = data.mediaWidth && data.mediaHeight
    ? mediaBoxFromAspect(data.mediaWidth / data.mediaHeight)
    : mediaBoxFromAspect(parseAspectRatio(getNodeParams(data).aspectRatio));
  const title = data.customTitle || (language === 'zh' ? '生成视频' : 'Generate Video');

  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleMouseEnter = () => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setHovered(true);
    videoRef.current?.play().catch(() => {});
  };
  const handleMouseLeave = () => {
    hoverTimeout.current = setTimeout(() => {
      setHovered(false);
      const v = videoRef.current;
      if (v) { v.pause(); v.currentTime = 0; }
    }, 150);
  };

  const handleCapture = useCallback(async (mode: 'current' | 'first' | 'last') => {
    const v = videoRef.current;
    if (!v || !data.url) return;

    const targetTime = mode === 'first' ? 0 : mode === 'last' ? Math.max(0, (v.duration || 0) - 0.05) : v.currentTime;
    if (mode !== 'current') {
      await new Promise<void>((resolve) => {
        const onSeeked = () => { v.removeEventListener('seeked', onSeeked); resolve(); };
        v.addEventListener('seeked', onSeeked);
        v.currentTime = targetTime;
      });
    }

    let dataUrl = captureVideoFrame(v);
    if (!dataUrl) dataUrl = await captureViaProxy(data.url, targetTime);
    if (!dataUrl) return;

    let stableUrl = dataUrl;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const form = new FormData();
      form.append('file', blob, `capture-${mode}-${Date.now()}.png`);
      const uploadResp = await fetch(resolveApiUrl('/api/app/upload'), { method: 'POST', body: form, credentials: 'include' });
      if (uploadResp.ok) {
        const json = await uploadResp.json();
        const rawUrl = json?.data?.url as string;
        if (rawUrl) {
          const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '') as string;
          stableUrl = apiBase ? `${apiBase.replace(/\/+$/, '')}${rawUrl}` : rawUrl;
        }
      }
    } catch {}

    const thisNode = nodes.find((n) => n.id === id);
    const pos = thisNode?.position ?? { x: 0, y: 0 };
    const label = mode === 'first' ? '首帧截图' : mode === 'last' ? '尾帧截图' : '视频截图';
    addNode({
      id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      type: 'referenceImageNode',
      position: { x: pos.x + 340, y: pos.y },
      data: { url: stableUrl, sourceName: label },
    } as any);
  }, [addNode, data.url, id, nodes]);

  return (
    <BaseNode
      icon={Video}
      tone="video"
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      width={videoBox.width}
      smoothResize
      topFloatingPanel={data.url && data.status !== 'uploading' ? <VideoActionToolbar sourceNodeId={id} /> : undefined}
      promptPanel={<PromptPanel nodeId={id} serviceType="video" fallbackModel="runway-gen3" />}
    >
      <div className="relative" onMouseEnter={data.url ? handleMouseEnter : undefined} onMouseLeave={data.url ? handleMouseLeave : undefined}>
        <div
          className={clsx(
            'relative flex w-full items-center justify-center overflow-hidden rounded-[12px] text-violet-100/40 transition-[height] duration-300 ease-out motion-reduce:transition-none',
            NODE_TONE_STYLES.video.surface,
            data.url && 'cursor-zoom-in',
          )}
          style={{ height: videoBox.height }}
          onDoubleClick={() => data.url && setPreview(true)}
        >
          {data.url ? (
            <SmartVideo
              src={data.url}
              poster={data.poster}
              hovered={hovered}
              videoRef={videoRef}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                const { videoWidth, videoHeight } = video;
                if (videoWidth && videoHeight && (data.mediaWidth !== videoWidth || data.mediaHeight !== videoHeight)) {
                  updateNodeData(id, { mediaWidth: videoWidth, mediaHeight: videoHeight });
                }
                if (video.duration && data.mediaDuration !== video.duration) {
                  updateNodeData(id, { mediaDuration: video.duration });
                }
              }}
            />
          ) : data.poster ? (
            <img src={toRenderableMediaUrl(data.poster)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-60 select-none" />
          ) : null}
          {!data.url ? (
            <div className="relative z-10 flex flex-col items-center gap-2 text-neutral-500">
              <Video className="h-7 w-7 text-neutral-600" />
              <span className="text-[12px]">{language === 'zh' ? '输入提示词生成视频' : 'Enter a prompt to generate'}</span>
            </div>
          ) : null}
          {data.url ? (
            <NodeVersionsBadge
              nodeId={id}
              activeUrl={data.url}
              activePrompt={data.prompt}
              activeModel={data.model}
              versions={(data.versions ?? []) as NodeVersion[]}
              mediaKind="video"
            />
          ) : null}
        </div>
        {data.url ? <VideoHoverControls videoRef={videoRef} hovered={hovered} onCapture={handleCapture} /> : null}
      </div>
      {preview && data.url ? <PreviewModal kind="video" src={data.url} onClose={() => setPreview(false)} /> : null}
    </BaseNode>
  );
};

const RenamableAudioNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const title = data.customTitle || (language === 'zh' ? '生成音频' : 'Generate Audio');
  // 生成完成后变成与「音频上传」一致的波形播放卡；空态用统一的占位框。
  const hasAudio = Boolean(data.url) && data.status !== 'uploading';
  const urlExt = String(data.url ?? '').split('?')[0].split('.').pop() ?? '';
  const formatBadge = (/^[a-z0-9]{2,4}$/i.test(urlExt) ? urlExt : 'mp3').toUpperCase().slice(0, 4);
  return (
    <BaseNode
      icon={Music}
      tone="audio"
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      topFloatingPanel={hasAudio ? <AudioActionToolbar sourceNodeId={id} /> : undefined}
      promptPanel={<PromptPanel nodeId={id} serviceType="audio" fallbackModel="suno-v4" />}
    >
      {hasAudio ? (
        <AudioWaveformPlayer
          nodeId={id}
          rawUrl={String(data.url)}
          downloadName={`${title}.${formatBadge.toLowerCase()}`}
          formatBadge={formatBadge}
          playbackRate={Number(data.playbackRate) || 1}
        />
      ) : (
        <MediaEmptyPlaceholder
          icon={Music}
          zh={language === 'zh'}
          className={clsx('w-full', NODE_TONE_STYLES.audio.surface)}
          style={{ height: 150 }}
          caption={{ zh: '输入提示词生成音频', en: 'Enter a prompt to generate audio' }}
        />
      )}
    </BaseNode>
  );
};

const RenamablePanoramaNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  const [panoramaPreview, setPanoramaPreview] = useState(false);
  const aspectClass = getAspectRatioClass(getNodeParams(data).aspectRatio, 'aspect-[2/1]');
  const title = data.customTitle || (language === 'zh' ? '生成全景' : '360 Environment');
  return (
    <BaseNode
      icon={Globe}
      tone="neutral"
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      loadingNodeId={id}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      <div
        className={clsx('relative flex items-center justify-center overflow-hidden rounded-[12px]', NODE_TONE_STYLES.neutral.surface, aspectClass, data.url && 'cursor-zoom-in')}
        onDoubleClick={() => data.url && setPanoramaPreview(true)}
      >
        {data.url ? (
          <>
            <ResilientImage src={data.url} alt="" className="h-full w-full object-cover select-none" zh={language === 'zh'} />
            <PanoramaOpenButton
              onClick={(event) => {
                event.stopPropagation();
                setPanoramaPreview(true);
              }}
            />
          </>
        ) : <Globe className="h-6 w-6 text-sky-100/40" />}
        {data.url ? (
          <NodeVersionsBadge
            nodeId={id}
            activeUrl={data.url}
            activePrompt={data.prompt}
            activeModel={data.model}
            versions={(data.versions ?? []) as NodeVersion[]}
            mediaKind="image"
          />
        ) : null}
      </div>
      {panoramaPreview && data.url ? <PanoramaPreviewModal src={data.url} nodeId={id} onClose={() => setPanoramaPreview(false)} /> : null}
    </BaseNode>
  );
};

/** Text-node box sizing + background palette. The node is user-resizable from
 *  its bottom-right corner (persisted as data.boxWidth / data.boxHeight) and its
 *  shell background is user-pickable (data.bgColor). Backgrounds are translucent
 *  tints so the light body text stays readable over the dark canvas. */
const TEXT_NODE_DEFAULT_WIDTH = 320;
const TEXT_NODE_MIN_WIDTH = 220;
const TEXT_NODE_MIN_HEIGHT = 160;
const TEXT_NODE_BG_COLORS: string[] = [
  'rgba(244,63,94,0.28)', 'rgba(249,115,22,0.28)', 'rgba(245,158,11,0.28)',
  'rgba(234,179,8,0.28)', 'rgba(132,204,22,0.28)', 'rgba(34,197,94,0.28)',
  'rgba(16,185,129,0.28)', 'rgba(20,184,166,0.28)', 'rgba(6,182,212,0.28)',
  'rgba(14,165,233,0.28)', 'rgba(59,130,246,0.30)', 'rgba(99,102,241,0.30)',
  'rgba(139,92,246,0.30)', 'rgba(168,85,247,0.30)', 'rgba(217,70,239,0.28)',
  'rgba(236,72,153,0.28)', 'rgba(100,116,139,0.32)',
];

/** Toolbar glyph for the text-highlight tool: an "A" on a yellow chip.
 *  Deliberately NOT the pen/Highlighter icon — that glyph already means the
 *  image BRUSH elsewhere in the app and reads as 画笔, not 高亮. */
const HighlightChipIcon = ({ className }: { className?: string }) => (
  <span
    className={clsx(
      'flex items-center justify-center rounded-[4px] bg-[#fde68a] text-[9px] font-bold leading-none text-[#1a1d22]',
      className,
    )}
  >
    A
  </span>
);

const ModeTextNode = ({ id, data: rawData, selected }: any) => {
  const data = rawData ?? {};
  const language = useStore((state) => state.language);
  // shellBackground 是内联样式，CSS 主题覆盖不到 — 按主题取底色。
  const shellBase = useStore((state) => state.theme) === 'light' ? '#ffffff' : '#16181d';
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const backendModels = useStore((state) => state.backendModels);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const title = data.customTitle || (language === 'zh' ? '文本节点' : 'Text Node');
  const activeMode = getTextNodeMode(data.textMode);
  const [isSubmittingReverse, setSubmittingReverse] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const fullscreenEditorRef = useRef<HTMLDivElement>(null);

  // Background color + corner-resize. Live size is tracked locally during a
  // drag and committed to node data ONCE on pointer-up (updateNodeData pushes an
  // undo snapshot, so per-move writes would flood the undo stack).
  // Zoom is read LAZILY at drag time (getViewport) instead of useViewport —
  // subscribing every text node to pan/zoom made panning re-render them all.
  const { getViewport } = useReactFlow();
  const [showBgPalette, setShowBgPalette] = useState(false);
  const [liveSize, setLiveSize] = useState<{ width: number; height: number } | null>(null);
  const liveSizeRef = useRef(liveSize);
  const contentBoxRef = useRef<HTMLDivElement>(null);
  const bgColor = typeof data.bgColor === 'string' ? (data.bgColor as string) : undefined;
  const boxWidth = liveSize?.width ?? (typeof data.boxWidth === 'number' ? (data.boxWidth as number) : TEXT_NODE_DEFAULT_WIDTH);
  const boxHeight = liveSize?.height ?? (typeof data.boxHeight === 'number' ? (data.boxHeight as number) : undefined);

  const resizeStartRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // Corner resize via POINTER CAPTURE: after setPointerCapture, pointermove/up
  // fire on the grip element itself, so these are element-level React handlers —
  // React detaches them on unmount and the browser auto-releases capture. This
  // avoids the window-listener leak if the node is deleted mid-drag.
  const startResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* no-op */ }
    resizeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      w: typeof data.boxWidth === 'number' ? (data.boxWidth as number) : TEXT_NODE_DEFAULT_WIDTH,
      h: typeof data.boxHeight === 'number' ? (data.boxHeight as number) : (contentBoxRef.current?.offsetHeight ?? TEXT_NODE_MIN_HEIGHT),
    };
  }, [data.boxWidth, data.boxHeight]);

  const moveResize = useCallback((event: React.PointerEvent) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const z = getViewport().zoom || 1;
    const next = {
      width: Math.round(Math.max(TEXT_NODE_MIN_WIDTH, start.w + (event.clientX - start.x) / z)),
      height: Math.round(Math.max(TEXT_NODE_MIN_HEIGHT, start.h + (event.clientY - start.y) / z)),
    };
    liveSizeRef.current = next;
    setLiveSize(next);
  }, [getViewport]);

  const endResize = useCallback((event: React.PointerEvent) => {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
    const final = liveSizeRef.current;
    liveSizeRef.current = null;
    if (final) updateNodeData(id, { boxWidth: final.width, boxHeight: final.height });
    setLiveSize(null);
  }, [id, updateNodeData]);

  /** One-way sync data.content → DOM ONLY when the editor isn't focused.
   *  Prevents React re-renders from overwriting the DOM while typing
   *  (which was resetting the caret to the start). */
  const dataContent = String(data.content || '');
  useEffect(() => {
    const node = editorRef.current;
    if (node && document.activeElement !== node && node.innerHTML !== dataContent) {
      node.innerHTML = dataContent;
    }
    const fs = fullscreenEditorRef.current;
    if (fs && document.activeElement !== fs && fs.innerHTML !== dataContent) {
      fs.innerHTML = dataContent;
    }
  }, [dataContent, isFullscreen]);

  /** Apply a document.execCommand and persist the resulting HTML. */
  const exec = useCallback((cmd: string, value?: string) => {
    // Choose whichever editor currently holds focus (inline or fullscreen).
    const target = (document.activeElement === fullscreenEditorRef.current ? fullscreenEditorRef.current : editorRef.current) ?? editorRef.current;
    if (!target) return;
    target.focus();
    document.execCommand(cmd, false, value);
    updateNodeData(id, { content: target.innerHTML });
  }, [id, updateNodeData]);

  /** Toggle the yellow text highlight: clicking with the caret/selection
   *  inside already-highlighted text CLEARS it instead of stacking more. */
  const toggleHighlight = useCallback(() => {
    let isOn = false;
    try {
      const current = String(document.queryCommandValue('hiliteColor') || document.queryCommandValue('backColor') || '');
      isOn = current !== '' && current !== 'false' && current !== 'transparent' && current !== 'rgba(0, 0, 0, 0)';
    } catch { /* unsupported query — fall through to applying */ }
    exec('hiliteColor', isOn ? 'transparent' : '#fde68a');
  }, [exec]);

  const upstreamIds = useMemo(
    () => edges.filter((edge) => edge.target === id).map((edge) => edge.source),
    [edges, id],
  );
  const upstreamNodes = useMemo(
    () => upstreamIds.map((sourceId) => nodes.find((node) => node.id === sourceId)).filter(Boolean),
    [nodes, upstreamIds],
  );
  const firstReferenceImage = getFirstUpstreamReferenceImage(upstreamNodes as any);
  const reversePromptEnabled = canUseReversePrompt(upstreamNodes as any);
  const reversePromptModels = useMemo(
    () => filterReversePromptModels(backendModels).map((model) => ({
      label: `${model.vendor} · ${model.name}`,
      value: model.default_model || model.model_list[0] || model.name,
    })),
    [backendModels],
  );
  const selectedReverseModel = data.reversePromptModel || reversePromptModels[0]?.value || '';
  const reverseDisabledReason = !reversePromptEnabled
    ? '请先连接参考图片'
    : reversePromptModels.length === 0
      ? '当前没有可用的视觉模型'
      : undefined;

  /** Formatting toolbar markup — reused both as the floating bar above
   *  the selected node and inside the fullscreen editor modal. */
  const renderEditorToolbar = () => (
    <div className="flex items-center gap-1 rounded-full border border-white/10 bg-[#1a1d22]/95 px-2 py-1.5 shadow-2xl backdrop-blur-xl">
      {/* Whole-box background color — a swatch palette that recolors the node
          shell (data.bgColor). Distinct from the text-highlight tool below. */}
      <div className="relative" onMouseDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          title={language === 'zh' ? '背景颜色' : 'Background color'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setShowBgPalette((v) => !v)}
          className={clsx(
            'flex h-7 w-7 items-center justify-center rounded-md text-neutral-300 transition hover:bg-white/10 hover:text-white',
            showBgPalette && 'bg-white/10 text-white',
          )}
        >
          <Palette className="h-3.5 w-3.5" />
        </button>
        {showBgPalette ? (
          <div
            className="absolute left-0 top-9 z-30 w-[168px] rounded-xl border border-white/10 bg-[#1a1d22]/98 p-2 shadow-2xl backdrop-blur-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="grid grid-cols-6 gap-1.5">
              <button
                type="button"
                title={language === 'zh' ? '默认' : 'Default'}
                onClick={() => { updateNodeData(id, { bgColor: undefined }); setShowBgPalette(false); }}
                className={clsx(
                  'relative flex h-5 w-5 items-center justify-center rounded-md border border-white/15 bg-[#111]',
                  !bgColor && 'ring-2 ring-white/70',
                )}
              >
                <span className="pointer-events-none text-[11px] leading-none text-white/45">/</span>
              </button>
              {TEXT_NODE_BG_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { updateNodeData(id, { bgColor: c }); setShowBgPalette(false); }}
                  className={clsx('h-5 w-5 rounded-md border border-white/10 transition hover:scale-110', bgColor === c && 'ring-2 ring-white')}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="mx-0.5 h-4 w-px bg-white/10" />
      {([
        { Icon: HighlightChipIcon, key: 'bg', title: language === 'zh' ? '高亮背景色（再点取消）' : 'Highlight (click again to clear)', onClick: toggleHighlight },
        { Icon: Heading1, key: 'h1', title: 'H1', onClick: () => exec('formatBlock', 'H1') },
        { Icon: Heading2, key: 'h2', title: 'H2', onClick: () => exec('formatBlock', 'H2') },
        { Icon: Heading3, key: 'h3', title: 'H3', onClick: () => exec('formatBlock', 'H3') },
        { Icon: Pilcrow, key: 'p', title: language === 'zh' ? '正文' : 'Paragraph', onClick: () => exec('formatBlock', 'P') },
        { Icon: Bold, key: 'b', title: language === 'zh' ? '加粗' : 'Bold', onClick: () => exec('bold') },
        { Icon: Italic, key: 'i', title: language === 'zh' ? '斜体' : 'Italic', onClick: () => exec('italic') },
        { divider: true, key: 'd1' },
        { Icon: List, key: 'ul', title: language === 'zh' ? '无序列表' : 'Bullet list', onClick: () => exec('insertUnorderedList') },
        { Icon: ListOrdered, key: 'ol', title: language === 'zh' ? '有序列表' : 'Numbered list', onClick: () => exec('insertOrderedList') },
        { Icon: Minus, key: 'hr', title: language === 'zh' ? '分割线' : 'Horizontal rule', onClick: () => exec('insertHorizontalRule') },
        { Icon: CopyIcon, key: 'copy', title: language === 'zh' ? '复制纯文本' : 'Copy text', onClick: () => navigator.clipboard?.writeText(editorRef.current?.innerText ?? '') },
        { Icon: Expand, key: 'exp', title: language === 'zh' ? '放大' : 'Expand', onClick: () => setIsFullscreen(true) },
      ] as Array<{ Icon?: React.ComponentType<{ className?: string }>; divider?: boolean; key: string; title?: string; onClick?: () => void }>).map((item) => (
        item.divider
          ? <div key={item.key} className="mx-0.5 h-4 w-px bg-white/10" />
          : (
            <button
              key={item.key}
              type="button"
              title={item.title}
              onClick={item.onClick}
              className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-300 transition hover:bg-white/10 hover:text-white"
              onMouseDown={(event) => event.preventDefault()}
            >
              {item.Icon ? <item.Icon className="h-3.5 w-3.5" /> : null}
            </button>
          )
      ))}
    </div>
  );

  const editorToolbar = activeMode === 'editor' && (isEditing || selected)
    ? renderEditorToolbar()
    : undefined;

  return (
    <BaseNode
      icon={Type}
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      tone="text"
      selected={selected}
      error={data.error}
      width={boxWidth}
      // Solid dark shell (the node used to be transparent over the canvas
      // grid). A user-picked tint layers OVER the solid base so pale tints
      // still read as opaque.
      shellBackground={bgColor ? `linear-gradient(${bgColor}, ${bgColor}), ${shellBase}` : shellBase}
      topFloatingPanel={editorToolbar}
      promptPanel={activeMode === 'chooser' ? <PromptPanel nodeId={id} serviceType="text" fallbackModel="gpt-4.1-mini" /> : undefined}
    >
      <div
        className={clsx(
          'nodrag nopan space-y-2 p-3 text-sm',
          // Only apply the inner-bordered "surface" frame in non-editor modes.
          // In editor mode the contentEditable sits flush on the BaseNode shell.
          activeMode !== 'editor' && clsx('rounded-[12px] border shadow-inner', NODE_TONE_STYLES.text.surface),
        )}
        onMouseDown={stopNodeGesture}
        onPointerDown={stopNodeGesture}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          // Double-click anywhere on the text node → open fullscreen editor.
          // We don't gate on activeMode because the chooser surface also
          // benefits from entering fullscreen directly. The handler runs
          // BEFORE the contentEditable's native word-select, so we let
          // that proceed (no stopPropagation) and just trigger the modal.
          if (!isFullscreen) {
            // Auto-flip to editor mode if user double-clicks from chooser,
            // so the fullscreen editor has something coherent to render.
            if (activeMode !== 'editor') {
              updateNodeData(id, { textMode: 'editor' });
            }
            setIsFullscreen(true);
          }
        }}
      >
        {activeMode === 'chooser' ? (
          <>
            <div className="text-[11px] text-neutral-500">{language === 'zh' ? '尝试:' : 'Try:'}</div>
            <button
              type="button"
              onClick={() => updateNodeData(id, { textMode: 'editor' })}
              className="nodrag nopan flex w-full items-center gap-2 rounded-lg bg-white/8 px-2 py-2 text-left text-white transition hover:bg-white/10"
              onMouseDown={stopNodeGesture}
              onPointerDown={stopNodeGesture}
            >
              <Type className="h-4 w-4" />
              <span>{language === 'zh' ? '自己编写内容' : 'Edit Content'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (!reversePromptEnabled) return;
                updateNodeData(id, { textMode: 'reverse_prompt' });
              }}
              disabled={!reversePromptEnabled}
              className="nodrag nopan flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-neutral-300 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
              onMouseDown={stopNodeGesture}
              onPointerDown={stopNodeGesture}
            >
              <ImageIcon className="h-4 w-4" />
              <span>{language === 'zh' ? '图片反推提示词' : 'Reverse Prompt'}</span>
            </button>
            <div className="pt-2 text-xs text-neutral-500">
              {language === 'zh' ? '选择一种模式开始编写内容，或直接在下方输入提示词生成文本。' : 'Pick a mode, or type a prompt below to generate.'}
            </div>
          </>
        ) : null}

        {activeMode === 'editor' ? (
          <div ref={contentBoxRef} className="relative" style={boxHeight ? { height: boxHeight } : undefined}>
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={(event) => updateNodeData(id, { content: (event.target as HTMLDivElement).innerHTML })}
              onFocus={() => setIsEditing(true)}
              onBlur={() => setIsEditing(false)}
              onMouseDown={stopNodeGesture}
              onPointerDown={stopNodeGesture}
              className={clsx(
                'nodrag nopan rich-text-editor w-full bg-transparent p-2 text-sm text-neutral-100 outline-none',
                boxHeight ? 'prompt-editor-scroll h-full overflow-auto' : 'min-h-[220px]',
              )}
            />
            {!data.content ? (
              <div className="pointer-events-none absolute left-2 top-2 text-sm text-neutral-500">
                {language === 'zh' ? '输入内容...' : 'Type here...'}
              </div>
            ) : null}
          </div>
        ) : null}

        {activeMode === 'reverse_prompt' ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              {((firstReferenceImage?.data as Record<string, unknown> | undefined)?.url as string | undefined) ? (
                <img
                  src={((firstReferenceImage?.data as Record<string, unknown>).url as string)}
                  alt=""
                  className="h-12 w-12 rounded-xl object-cover"
                />
              ) : null}
              <p className="text-sm text-neutral-200">
                根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。
              </p>
            </div>
            <textarea
              value={String(data.reversePromptDraft || data.content || '')}
              onChange={(event) => updateNodeData(id, { reversePromptDraft: event.target.value })}
              className="nodrag nopan min-h-[180px] w-full resize-none rounded-xl border border-white/10 bg-[#171717] p-3 text-sm text-neutral-100 outline-none"
              onMouseDown={stopNodeGesture}
              onPointerDown={stopNodeGesture}
            />
            <div className="flex items-center justify-between gap-3">
              <select
                value={selectedReverseModel}
                onChange={(event) => updateNodeData(id, { reversePromptModel: event.target.value })}
                className="nodrag nopan min-w-[180px] rounded-xl border border-white/10 bg-[#171717] px-3 py-2 text-sm text-neutral-100 outline-none"
                onMouseDown={stopNodeGesture}
                onPointerDown={stopNodeGesture}
              >
                {reversePromptModels.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={async () => {
                  if (reverseDisabledReason) return;
                  setSubmittingReverse(true);
                  const imageName = String((firstReferenceImage?.data as Record<string, unknown> | undefined)?.sourceName || '参考图');
                  const nextPrompt = String(data.reversePromptDraft || '').trim() || `主体：基于参考图“${imageName}”提炼主体形象与关键动作。
环境：描述场景位置、时间、天气与空间氛围。
光影：说明主光源方向、明暗层次、色温与质感。
镜头：补充景别、机位、构图与镜头语言。
风格：总结画风、材质、情绪和关键词。`;
                  updateNodeData(id, {
                    reversePromptModel: selectedReverseModel,
                    reversePromptDraft: nextPrompt,
                    content: nextPrompt,
                  });
                  setSubmittingReverse(false);
                }}
                disabled={Boolean(reverseDisabledReason) || isSubmittingReverse}
                className="nodrag nopan rounded-xl bg-white px-4 py-2 text-sm text-black disabled:opacity-40"
                onMouseDown={stopNodeGesture}
                onPointerDown={stopNodeGesture}
              >
                {isSubmittingReverse ? (language === 'zh' ? '处理中...' : 'Processing...') : (language === 'zh' ? '发送' : 'Send')}
              </button>
            </div>
            {reverseDisabledReason ? <div className="text-xs text-rose-300">{reverseDisabledReason}</div> : null}
          </div>
        ) : null}

        {/* Bottom-right corner grip — drag to resize the box (editor mode).
            ALWAYS pinned to the shell's bottom-right corner (not gated on
            selection, so it never appears to come and go / move around). */}
        {activeMode === 'editor' ? (
          <div
            className="group/grip nodrag nopan absolute bottom-1 right-1 z-20 flex h-5 w-5 cursor-nwse-resize items-center justify-center text-neutral-500 transition"
            title={language === 'zh' ? '拖动调整大小' : 'Drag to resize'}
            onPointerDown={startResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {/* Default: subtle corner lines. Hover: diagonal resize arrows. */}
            <svg viewBox="0 0 10 10" className="h-3 w-3 transition-opacity group-hover/grip:opacity-0" aria-hidden>
              <path d="M2.5 9L9 2.5M5.5 9L9 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
            </svg>
            <MoveDiagonal2 className="absolute h-3.5 w-3.5 text-cyan-300 opacity-0 transition-opacity group-hover/grip:opacity-100" />
          </div>
        ) : null}
      </div>
      {isFullscreen ? createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm" onClick={() => setIsFullscreen(false)}>
          <div className="relative flex h-[82vh] w-[58vw] min-w-[720px] max-w-[92vw] flex-col rounded-2xl border border-white/10 bg-[#1a1d22]/98 px-6 py-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              onClick={() => setIsFullscreen(false)}
              className="absolute right-5 top-5 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
            >
              <X className="h-4 w-4" />
            </button>
            {/* Title on the left, formatting toolbar centered — matches the
                NeoWOW fullscreen layout where H1/H2/B/I/list sit at the top
                of the editor. */}
            <div className="mb-3 flex items-center justify-between gap-4 pr-12">
              <div className="text-sm text-neutral-300">{title}</div>
              {renderEditorToolbar()}
            </div>
            <div
              ref={fullscreenEditorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={(event) => updateNodeData(id, { content: (event.target as HTMLDivElement).innerHTML })}
              onFocus={() => setIsEditing(true)}
              className="prompt-editor-scroll rich-text-editor flex-1 w-full overflow-auto rounded-xl bg-transparent p-4 text-sm text-neutral-100 outline-none"
            />
          </div>
        </div>,
        document.body,
      ) : null}
    </BaseNode>
  );
};

import { AgentNode } from './AgentNode';
import { StickyNoteNode } from './StickyNoteNode';
import { DirectorStageNode } from './DirectorStageNode';
import { NodeVersionsBadge } from './NodeVersions';
import type { NodeVersion } from '../../store';
import { CompositionPreviewNode } from './CompositionPreviewNode';
import { LayerEditorNode } from './LayerEditorNode';

// Every node component is memoized: React Flow re-renders ALL registered node
// components whenever its nodes array changes identity (i.e. every drag frame
// for every node) unless they bail out on unchanged props. RF passes stable
// per-node props (id / data / selected / ...), so a plain shallow memo skips
// the (heavy) unaffected nodes while the dragged one still re-renders.
export const nodeTypes = {
  textNode: memo(ModeTextNode),
  imageNode: memo(RenamableImageNode),
  videoNode: memo(RenamableVideoNode),
  audioNode: memo(RenamableAudioNode),
  panoramaNode: memo(RenamablePanoramaNode),
  referenceImageNode: memo(ReferenceImageNode),
  referenceVideoNode: memo(ReferenceVideoNode),
  referenceAudioNode: memo(AudioReferenceNode),
  agentNode: memo(AgentNode),
  stickyNoteNode: memo(StickyNoteNode),
  directorStageNode: memo(DirectorStageNode),
  compositionPreviewNode: memo(CompositionPreviewNode),
  layerEditorNode: memo(LayerEditorNode),
};

