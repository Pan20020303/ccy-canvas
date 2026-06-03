import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import {
  Type,
  Image as ImageIcon,
  Video,
  Music,
  Globe,
  ChevronDown,
  ArrowUp,
  LayoutTemplate,
  Sparkles,
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
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../../store';
import type { ServiceType } from '../../model-config';
import { getModelTemplate, type ModelTemplate } from '../../model-templates';
import { ModelBrandIcon } from '../ModelBrandIcon';
import {
  canUseReversePrompt,
  filterReversePromptModels,
  getFirstUpstreamReferenceImage,
  getTextNodeMode,
  splitFilenameExtension,
} from '../../text-node-modes';

// ─── Node Loading Overlay (water-fill + timer) ─────────────────────────────

/** Water sweep �?left-to-right fill inside the node (lives inside overflow-hidden container). */
function NodeLoadingWater() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 200);
    return () => clearInterval(id);
  }, []);
  const progress = Math.min(100, (elapsed / 60) * 100);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[22px]">
      <div
        className="absolute inset-y-0 left-0 bg-gradient-to-r from-cyan-500/20 via-cyan-400/10 to-transparent transition-[width] duration-1000 ease-linear"
        style={{ width: `${progress}%` }}
      />
      <div
        className="absolute inset-y-0 w-10 animate-pulse bg-gradient-to-r from-transparent via-cyan-400/25 to-transparent transition-[left] duration-1000 ease-linear"
        style={{ left: `${progress}%` }}
      />
    </div>
  );
}

/** Timer badge �?sits OUTSIDE the node frame, at top-right corner. */
function NodeLoadingTimer() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 200);
    return () => clearInterval(id);
  }, []);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <div className="pointer-events-none absolute -top-5 right-0 flex items-center gap-1 rounded bg-black/60 px-1.5 py-[2px] text-[9px] font-mono leading-none text-cyan-300/80 backdrop-blur-sm">
      <div className="h-1 w-1 animate-pulse rounded-full bg-cyan-400" />
      {mm}:{ss}
    </div>
  );
}

const Dropdown = ({
  label,
  value,
  options,
  onChange,
  align = 'left',
  renderOption,
  menuMinWidth,
}: {
  label?: React.ReactNode;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  align?: 'left' | 'right';
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
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-300 transition hover:bg-white/5"
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
              'bottom-full',
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
  aspectRatio,
  duration,
  onResolution,
  onAspectRatio,
  onDuration,
}: {
  template: ModelTemplate;
  resolution: string;
  aspectRatio: string;
  duration: number;
  onResolution: (v: string) => void;
  onAspectRatio: (v: string) => void;
  onDuration: (v: number) => void;
}) => {
  const [open, setOpen] = useState(false);
  const language = useStore((state) => state.language);

  const labelParts = [
    template.supportsAutoAspect && aspectRatio === 'auto' ? (language === 'zh' ? '自适应' : 'Auto') : aspectRatio,
    template.supportsResolution ? resolution : null,
    template.supportsDuration ? `${duration}s` : null,
  ].filter(Boolean);

  const hasAspect = template.supportsAspectRatio && template.aspectRatioOptions?.length;
  const hasResolution = template.supportsResolution && template.resolutionOptions?.length;
  const hasDurationSlider = template.supportsDuration && template.durationRange && !template.durationOptions?.length;
  const hasDurationOptions = template.supportsDuration && template.durationOptions?.length;

  return (
    <div className="relative nodrag">
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-300 transition hover:bg-white/5"
      >
        <LayoutTemplate className="h-3 w-3 text-neutral-400" />
        <span>{labelParts.join(' · ')}</span>
        <ChevronDown className="h-3 w-3 text-neutral-500" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-2 w-[340px] rounded-xl border border-white/10 bg-[#1a1d22]/95 p-4 shadow-2xl backdrop-blur-xl">
            {/* Aspect Ratio */}
            {hasAspect ? (
              <>
                <div className="mb-2 text-xs text-neutral-400">{language === 'zh' ? '比例' : 'Ratio'}</div>
                <div className="mb-4 grid grid-cols-5 gap-2">
                  {template.supportsAutoAspect ? (
                    <button
                      onClick={() => onAspectRatio('auto')}
                      className={clsx(
                        'col-span-2 flex flex-col items-start justify-center gap-1 rounded-md border p-3 transition',
                        aspectRatio === 'auto'
                          ? 'border-white/15 bg-white/10 text-white'
                          : 'border-transparent text-neutral-400 hover:bg-white/5',
                      )}
                    >
                      <LayoutTemplate className="h-4 w-4" />
                      <span className="text-xs">{language === 'zh' ? '自适应' : 'Auto'}</span>
                    </button>
                  ) : null}
                  {template.aspectRatioOptions!.map((option) => (
                    <button
                      key={option}
                      onClick={() => onAspectRatio(option)}
                      className={clsx(
                        'flex flex-col items-center gap-1 rounded-md border p-1.5 transition',
                        option === aspectRatio ? 'border-white/15 bg-white/10' : 'border-transparent hover:bg-white/5',
                      )}
                    >
                      <RatioPreview ratio={option} />
                      <span className="text-[10px] text-neutral-400">{option}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {/* Resolution */}
            {hasResolution ? (
              <>
                <div className="mb-2 text-xs text-neutral-400">{language === 'zh' ? '清晰度' : 'Resolution'}</div>
                <div className="mb-4 grid grid-cols-3 gap-2">
                  {template.resolutionOptions!.map((option) => (
                    <button
                      key={option}
                      onClick={() => onResolution(option)}
                      className={clsx(
                        'rounded-lg py-2 text-sm transition',
                        option === resolution
                          ? 'border border-white/15 bg-white/10 text-white'
                          : 'text-neutral-400 hover:bg-white/5',
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {/* Duration — slider */}
            {hasDurationSlider ? (
              <>
                <div className="mb-2 text-xs text-neutral-400">{language === 'zh' ? '视频时长' : 'Duration'}</div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={template.durationRange!.min}
                    max={template.durationRange!.max}
                    step={template.durationRange!.step}
                    value={duration}
                    onChange={(event) => onDuration(Number(event.target.value))}
                    className="flex-1 accent-cyan-400"
                  />
                  <span className="text-sm text-neutral-300">{duration}s</span>
                </div>
              </>
            ) : null}
            {/* Duration — fixed options */}
            {hasDurationOptions ? (
              <>
                <div className="mb-2 text-xs text-neutral-400">{language === 'zh' ? '视频时长' : 'Duration'}</div>
                <div className={clsx('grid gap-2', template.durationOptions!.length <= 3 ? 'grid-cols-2' : 'grid-cols-3')}>
                  {template.durationOptions!.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => onDuration(opt)}
                      className={clsx(
                        'rounded-lg py-2 text-sm transition',
                        opt === duration
                          ? 'border border-white/15 bg-white/10 text-white'
                          : 'text-neutral-400 hover:bg-white/5',
                      )}
                    >
                      {opt}s
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
};

const getNodeParams = (data: any) => ((data?.generationParams ?? {}) as Record<string, any>);

/** Render text with inline mention thumbnails. Splits on `[@xxx]` tags. */
function renderMentionRichText(text: string, mentions: { tag: string; id: string; thumb: string }[]): React.ReactNode {
  if (!mentions.length) return text;

  // Build a regex that matches any of the mention tags.
  const escaped = mentions.map((m) => m.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'g');
  const parts = text.split(regex);

  return parts.map((part, i) => {
    const mention = mentions.find((m) => m.tag === part);
    if (mention) {
      return (
        <span key={i} className="inline-flex items-center gap-1 rounded bg-white/[0.08] px-1 py-0.5 align-middle text-[12px] text-cyan-300">
          {mention.thumb ? (
            <img src={mention.thumb} alt="" className="inline-block h-4 w-4 rounded-sm object-cover" />
          ) : (
            <span className="inline-block h-4 w-4 rounded-sm bg-white/10 text-center text-[10px] leading-4">🖼</span>
          )}
          <span>{part.slice(2, -1)}</span>
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
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

// All node types now share a neutral shell; semantic color is removed from the outer frame.
const NEUTRAL_NODE_SHELL = {
  shell: 'border-white/10 before:from-white/[0.05] before:to-transparent shadow-[0_18px_48px_-28px_rgba(0,0,0,0.85)]',
  selected: 'shadow-[0_0_0_1px_rgba(255,255,255,0.22),0_20px_56px_-28px_rgba(0,0,0,0.92)]',
  surface: 'border-white/8 bg-[linear-gradient(180deg,rgba(42,42,42,0.92),rgba(29,29,29,0.96))]',
} as const;

const NODE_TONE_STYLES = {
  text: NEUTRAL_NODE_SHELL,
  image: NEUTRAL_NODE_SHELL,
  video: NEUTRAL_NODE_SHELL,
  audio: NEUTRAL_NODE_SHELL,
  neutral: NEUTRAL_NODE_SHELL,
} as const;

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

const PromptPanel = ({
  nodeId,
  serviceType,
  fallbackModel,
}: {
  nodeId: string;
  serviceType: ServiceType;
  fallbackModel: string;
}) => {
  const language = useStore((state) => state.language);
  const edges = useStore((state) => state.edges);
  const allNodes = useStore((state) => state.nodes);
  const runNode = useStore((state) => state.runNode);
  const backendModels = useStore((state) => state.backendModels);
  const updateNodeGenerationParams = useStore((state) => state.updateNodeGenerationParams);
  const upstreamIds = edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  const upstreamNodes = useMemo(() => upstreamIds.map((id, idx) => {
    const n = allNodes.find((node) => node.id === id);
    const d = (n?.data ?? {}) as Record<string, string>;
    const type = n?.type ?? '';
    const isImage = type === 'imageNode' || type === 'referenceImageNode';
    const isVideo = type === 'videoNode' || type === 'referenceVideoNode';
    const thumb = d.url || d.thumbnail || '';
    const label = isImage ? `图片 ${idx + 1}` : isVideo ? `视频 ${idx + 1}` : `节点 ${idx + 1}`;
    const icon = isImage ? '图' : isVideo ? '视' : '节';
    return { id, type, thumb, label, icon };
  }), [upstreamIds, allNodes]);

  const [text, setText] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const compactOverlayRef = useRef<HTMLDivElement>(null);
  const expandedOverlayRef = useRef<HTMLDivElement>(null);
  const currentNode = allNodes.find((node) => node.id === nodeId);
  const params = getNodeParams(currentNode?.data);

  const enabledConfigs = useMemo(
    () => backendModels
      .filter((pc) => pc.service_type === serviceType)
      .map((pc) => ({
        vendor: pc.vendor,
        name: pc.name,
        modelList: pc.model_list,
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

  const availableModels = useMemo(
    () => enabledConfigs
      .filter((config) => config.vendor === activeVendor)
      .flatMap((config) => config.modelList)
      .filter((value, index, values) => values.indexOf(value) === index),
    [activeVendor, enabledConfigs],
  );

  const modelIsDisabled = Boolean(params.model) && !enabledConfigs.some((config) => config.modelList.includes(params.model));
  const activeModel = useMemo(() => {
    if (params.model && availableModels.includes(params.model)) {
      return params.model;
    }
    return availableModels[0] ?? fallbackModel;
  }, [availableModels, fallbackModel, params.model]);

  const template = getModelTemplate(activeModel);
  const currentMode = params.mode ?? template?.defaults?.mode ?? template?.modeOptions?.[0] ?? '';
  const currentResolution = params.resolution ?? template?.defaults?.resolution ?? template?.resolutionOptions?.[0] ?? '';
  const currentAspectRatio = params.aspectRatio
    ?? (template?.supportsAutoAspect ? 'auto' : template?.defaults?.aspectRatio ?? template?.aspectRatioOptions?.[0] ?? '');
  const currentDuration = params.durationSeconds ?? template?.durationRange?.defaultValue ?? template?.durationRange?.min ?? 5;

  useEffect(() => {
    if (!template) {
      return;
    }
    const nextPatch: Record<string, unknown> = {};

    if (!params.vendor && activeVendor) nextPatch.vendor = activeVendor;
    if (!params.model && activeModel) nextPatch.model = activeModel;
    if (template.supportsMode && !params.mode && currentMode) nextPatch.mode = currentMode;
    if (template.supportsResolution && !params.resolution && currentResolution) nextPatch.resolution = currentResolution;
    if ((template.supportsAspectRatio || template.supportsAutoAspect) && !params.aspectRatio && currentAspectRatio) nextPatch.aspectRatio = currentAspectRatio;
    if (template.supportsDuration && !params.durationSeconds && currentDuration) nextPatch.durationSeconds = currentDuration;

    if (Object.keys(nextPatch).length > 0) {
      updateNodeGenerationParams(nodeId, nextPatch);
    }
  }, [
    activeModel,
    activeVendor,
    currentAspectRatio,
    currentDuration,
    currentMode,
    currentResolution,
    nodeId,
    params.aspectRatio,
    params.durationSeconds,
    params.mode,
    params.model,
    params.resolution,
    params.vendor,
    template,
    updateNodeGenerationParams,
  ]);

  const [mentions, setMentions] = useState<{ tag: string; id: string; thumb: string }[]>([]);
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
    setMentions((prev) => [...prev.filter((m) => m.id !== upstream.id), { tag, id: upstream.id, thumb: upstream.thumb }]);
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

  const handleVendorChange = (nextVendor: string) => {
    const nextModels = enabledConfigs
      .filter((config) => config.vendor === nextVendor)
      .flatMap((config) => config.modelList)
      .filter((value, index, values) => values.indexOf(value) === index);
    const nextModel = nextModels[0];
    const nextTemplate = getModelTemplate(nextModel);
    updateNodeGenerationParams(nodeId, {
      vendor: nextVendor,
      model: nextModel,
      mode: nextTemplate?.defaults?.mode ?? nextTemplate?.modeOptions?.[0],
      resolution: nextTemplate?.defaults?.resolution ?? nextTemplate?.resolutionOptions?.[0],
      aspectRatio: nextTemplate?.supportsAutoAspect ? 'auto' : nextTemplate?.defaults?.aspectRatio ?? nextTemplate?.aspectRatioOptions?.[0],
      durationSeconds: nextTemplate?.durationRange?.defaultValue,
    });
  };

  const handleModelChange = (nextModel: string) => {
    const nextTemplate = getModelTemplate(nextModel);
    updateNodeGenerationParams(nodeId, {
      vendor: nextTemplate?.vendor ?? activeVendor,
      model: nextModel,
      mode: nextTemplate?.defaults?.mode ?? nextTemplate?.modeOptions?.[0],
      resolution: nextTemplate?.defaults?.resolution ?? nextTemplate?.resolutionOptions?.[0],
      aspectRatio: nextTemplate?.supportsAutoAspect ? 'auto' : nextTemplate?.defaults?.aspectRatio ?? nextTemplate?.aspectRatioOptions?.[0],
      durationSeconds: nextTemplate?.durationRange?.defaultValue,
    });
  };

  const submit = () => {
    if (!text.trim()) return;
    runNode(nodeId, { prompt: resolveTagsToMentions(text), model: activeModel });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const syncOverlayScroll = (textarea: HTMLTextAreaElement | null, overlay: HTMLDivElement | null) => {
    if (!textarea || !overlay) return;
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
  };

  const previewStrip = upstreamNodes.length ? (
    <div className="mb-3 flex items-center gap-2 overflow-x-auto">
      {upstreamNodes.map((up) => (
        <div key={up.id} className="shrink-0">
          {up.thumb ? (
            <img src={up.thumb} alt="" className="h-10 w-10 rounded-lg object-cover" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400">
              {up.icon}
            </div>
          )}
        </div>
      ))}
    </div>
  ) : null;

  const renderPromptEditor = (expandedMode = false) => {
    const overlayRef = expandedMode ? expandedOverlayRef : compactOverlayRef;
    const heightClass = expandedMode ? 'flex-1' : 'h-[160px]';
    const paddingClass = expandedMode ? 'px-4 py-4' : 'px-3 py-3';

    return (
      <div className={clsx('relative rounded-xl', expandedMode && 'flex-1 flex flex-col')}>
        <div
          ref={overlayRef}
          className={clsx(
            'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-200',
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
          onScroll={(event) => syncOverlayScroll(event.currentTarget, overlayRef.current)}
          className={clsx(
            'prompt-editor-scroll relative w-full resize-none overflow-auto bg-transparent text-[13px] leading-relaxed text-transparent caret-neutral-200 focus:outline-none',
            expandedMode ? 'flex-1' : 'h-[160px]',
            paddingClass,
          )}
          style={{ caretColor: '#e5e5e5' }}
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
                  <img src={up.thumb} alt="" className="h-8 w-8 rounded-md object-cover border border-white/10 flex-shrink-0" />
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
    <div className="mt-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-1 min-w-0">
        {vendorOptions.length ? (
          <Dropdown value={activeVendor} options={vendorOptions} onChange={handleVendorChange} />
        ) : null}
        <Dropdown
          label={<ModelBrandIcon model={modelIsDisabled && params.model ? params.model : activeModel} size={14} />}
          value={modelIsDisabled && params.model ? `${params.model}（已停用）` : activeModel}
          options={availableModels}
          onChange={handleModelChange}
          menuMinWidth={240}
          renderOption={(option, selected) => {
            // Show the model's default video duration on the right (when applicable).
            const optTemplate = getModelTemplate(option);
            const dur = optTemplate?.durationRange?.defaultValue
              ?? optTemplate?.durationOptions?.[0];
            return (
              <div className="flex w-full items-center gap-2">
                <ModelBrandIcon model={option} size={18} />
                <span className={clsx('flex-1 truncate', selected ? 'text-cyan-300' : 'text-neutral-200')}>{option}</span>
                {dur ? <span className="shrink-0 text-[10px] text-neutral-500">{dur}s</span> : null}
              </div>
            );
          }}
        />
        {template?.supportsMode && template.modeOptions?.length ? (
          <Dropdown
            value={currentMode}
            options={template.modeOptions}
            onChange={(value) => updateNodeGenerationParams(nodeId, { mode: value })}
          />
        ) : null}
        {template && (template.supportsResolution || template.supportsAspectRatio || template.supportsAutoAspect || template.supportsDuration) ? (
          <MediaParamsPopover
            template={template}
            resolution={currentResolution}
            aspectRatio={currentAspectRatio}
            duration={currentDuration}
            onResolution={(value) => updateNodeGenerationParams(nodeId, { resolution: value })}
            onAspectRatio={(value) => updateNodeGenerationParams(nodeId, { aspectRatio: value })}
            onDuration={(value) => updateNodeGenerationParams(nodeId, { durationSeconds: value })}
          />
        ) : null}
      </div>
      <button
        onClick={submit}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-500/20 text-cyan-200 transition hover:bg-cyan-500/40"
      >
        <ArrowUp className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <>
      <div className="relative mt-6 -ml-[80px] w-[520px] rounded-2xl border border-white/[0.06] bg-[#15181d]/92 px-5 py-4 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-2xl nodrag">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute right-4 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
          title="放大"
        >
          <Expand className="h-3.5 w-3.5" />
        </button>
        {previewStrip}
        {renderPromptEditor(false)}
        {bottomControls}
      </div>
      {expanded ? createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm">
          <div className="relative flex h-[80vh] w-[52vw] min-w-[720px] max-w-[92vw] flex-col rounded-[16px] border border-white/10 bg-[#1a1d22]/96 px-6 py-5 shadow-2xl">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
            >
              <X className="h-4 w-4" />
            </button>
            {previewStrip}
            {renderPromptEditor(true)}
            {bottomControls}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
};

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
  error,
  tone = 'neutral',
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
  error?: string;
  tone?: keyof typeof NODE_TONE_STYLES;
}) => {
  const toneStyles = NODE_TONE_STYLES[tone];
  const isConnectionDragging = useStore((state) => state.isConnectionDragging);
  const multiSelectActive = useStore((state) => state.nodes.filter((node) => node.selected).length > 1);
  return (
    <div className="group w-[300px]">
      {selected && !multiSelectActive && topFloatingPanel ? (
        <div className="pointer-events-auto absolute left-1/2 z-30 -translate-x-1/2 -translate-y-full pb-3" style={{ top: 0 }}>
          {topFloatingPanel}
        </div>
      ) : null}
      <div className="mb-2 flex items-center justify-between gap-3 pl-1 text-[11px] text-neutral-400">
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className="h-3 w-3 shrink-0" />
          <div className="min-w-0">{title}</div>
        </div>
        {headerRight ? <div className="shrink-0 text-[10px] text-neutral-500">{headerRight}</div> : null}
      </div>

      <div className="relative">
        <div
          className={clsx(
            'relative overflow-hidden rounded-[22px] border bg-[linear-gradient(180deg,rgba(29,34,42,0.82),rgba(15,18,24,0.74))] text-neutral-100 transition-all duration-200 backdrop-blur-2xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,rgba(29,34,42,0.62),rgba(15,18,24,0.56))] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-16 before:bg-gradient-to-b after:pointer-events-none after:absolute after:inset-[1px] after:rounded-[20px] after:border after:border-white/[0.03]',
            toneStyles.shell,
            selected ? toneStyles.selected : 'shadow-[0_16px_50px_-32px_rgba(0,0,0,0.9)]',
          )}
        >
          <div>{children}</div>
          {error ? <NodeErrorBanner error={error} /> : null}
          {loading ? <NodeLoadingWater /> : null}
        </div>
        {loading ? <NodeLoadingTimer /> : null}

        <Handle
          type="target"
          position={Position.Left}
          className="!left-0 !top-0 !h-full !w-full !cursor-default !rounded-[22px] !border-0 !bg-transparent !opacity-0"
          style={{ transform: 'none', pointerEvents: isConnectionDragging ? 'auto' : 'none' }}
        />
        <div
          className={clsx(
            'pointer-events-none absolute left-0 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100',
            selected && '!opacity-100',
          )}
        >
          <div className="flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-[#1a1d22]/90 backdrop-blur-md">
            <Plus className="h-3 w-3 text-neutral-300" />
          </div>
        </div>
        <Handle
          type="source"
          position={Position.Right}
          className={clsx(
            '!h-6 !w-6 !-right-3 !rounded-full !border-0 !bg-transparent opacity-0 transition-opacity group-hover:opacity-100',
            selected && '!opacity-100',
          )}
          style={{ transform: 'translate(0, -50%)' }}
        >
          <div className="pointer-events-none flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-[#1a1d22]/90 backdrop-blur-md">
            <Plus className="h-3 w-3 text-neutral-300" />
          </div>
        </Handle>
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
    if (e.includes('quota')) return language === 'zh' ? '本地存储已满，画布已成功生成但未能保存到本地。' : 'Local storage full; generated, not saved locally.';
    if (e.includes('invalid token') || e.includes('unauthorized')) return language === 'zh' ? '模型授权失败，请联系管理员检查 API token。' : 'Model auth failed — contact admin.';
    if (e.includes('timeout') || e.includes('timed out')) return language === 'zh' ? '请求超时，请稍后重试。' : 'Request timed out — please retry.';
    if (e.includes('network')) return language === 'zh' ? '网络错误，请检查连接后重试。' : 'Network error — please retry.';
    if (e.includes('rate') && e.includes('limit')) return language === 'zh' ? '请求过于频繁，请稍后重试。' : 'Rate limited — please slow down.';
    if (e.includes('422') || e.includes('validation') || e.includes('minlength') || e.includes('required')) {
      if (e.includes('prompt')) return language === 'zh' ? '提示词不能为空，请填写描述后重试。' : 'Prompt is required.';
      return language === 'zh' ? '请求参数有误，请检查后重试。' : 'Invalid request parameters.';
    }
    return language === 'zh' ? '生成失败，请稍后重试。' : 'Generation failed — please retry.';
  })();

  const copyDetail = () => { try { navigator.clipboard?.writeText(error); } catch { /* ignore */ } };

  return (
    <div className="px-3 pb-3 pt-1">
      <div className="rounded-md border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5 text-[11px] text-rose-300">
        <div className="flex items-center justify-between gap-2">
          <span className="break-words">{summary}</span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
          >
            {expanded ? (language === 'zh' ? '收起' : 'Hide') : (language === 'zh' ? '详情' : 'Details')}
          </button>
        </div>
        {expanded ? (
          <div className="mt-2 flex flex-col gap-1.5">
            <pre className="prompt-editor-scroll max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 text-[10px] text-neutral-400">{error}</pre>
            <button
              type="button"
              onClick={copyDetail}
              className="self-start rounded px-2 py-0.5 text-[10px] text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
            >
              {language === 'zh' ? '复制错误' : 'Copy error'}
            </button>
          </div>
        ) : null}
      </div>
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
    const a = document.createElement('a');
    a.href = src;
    a.download = kind === 'image' ? 'generated-image.png' : 'generated-video.mp4';
    a.target = '_blank';
    a.click();
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
            src={src}
            alt=""
            draggable={false}
            className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain shadow-2xl select-none transition-transform duration-150"
            style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})` }}
          />
        ) : (
          <video src={src} controls autoPlay className="max-h-[92vh] max-w-[92vw] rounded-lg shadow-2xl" />
        )}
      </div>
    </div>,
    document.body,
  );
};

export const TextNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  return (
    <BaseNode
      icon={Type}
      title={language === 'zh' ? '生成文本' : 'Generate Text'}
      tone="text"
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="text" fallbackModel="gpt-4.1-mini" />}
    >
      <div className={clsx('w-full min-h-[88px] rounded-[20px] border p-3 text-xs text-neutral-300 shadow-inner', NODE_TONE_STYLES.text.surface)}>
        {data.content || (language === 'zh' ? '输入文本后结果会出现在这里...' : 'Generated text will appear here...')}
      </div>
    </BaseNode>
  );
};

export const ImageNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const [preview, setPreview] = useState(false);
  const [naturalRatio, setNaturalRatio] = useState<string | null>(null);
  const paramAspect = getNodeParams(data).aspectRatio;

  // Use the actual loaded image ratio if available, otherwise fall back to param.
  const effectiveAspect = naturalRatio ?? paramAspect;
  const aspectClass = getAspectRatioClass(effectiveAspect, 'aspect-video');

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
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      {data.url ? (
        <div
          className={clsx('relative overflow-hidden rounded-[20px] border cursor-zoom-in', NODE_TONE_STYLES.image.surface, aspectClass)}
          onDoubleClick={() => setPreview(true)}
        >
          <img src={data.url} alt="" draggable={false} className="h-full w-full object-cover select-none" onLoad={handleImageLoad} />
        </div>
      ) : (
        <div className={clsx('flex items-center justify-center rounded-[20px] border text-orange-100/45', NODE_TONE_STYLES.image.surface, aspectClass)}>
          <ImageIcon className="h-6 w-6" />
        </div>
      )}
      {preview && data.url ? <PreviewModal kind="image" src={data.url} onClose={() => setPreview(false)} /> : null}
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
    const proxyUrl = `/api/app/proxy-media?url=${encodeURIComponent(videoUrl)}`;
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

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => setDuration(v.duration || 0);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    if (v.duration) setDuration(v.duration);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
    };
  }, [videoRef]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const seek = (e: React.MouseEvent) => {
    e.stopPropagation();
    const bar = progressRef.current;
    const v = videoRef.current;
    if (!bar || !v || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    v.currentTime = ratio * duration;
  };

  if (!hovered) return null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 rounded-b-[20px] bg-gradient-to-t from-black/70 to-transparent px-3 py-2 nodrag" onClick={(e) => e.stopPropagation()}>
      <button onClick={togglePlay} className="flex h-6 w-6 shrink-0 items-center justify-center text-white/90 hover:text-white">
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <span className="shrink-0 text-[10px] tabular-nums text-white/70">{formatTime(currentTime)}</span>
      <div ref={progressRef} className="relative flex-1 cursor-pointer py-1" onClick={seek}>
        <div className="h-1 rounded-full bg-white/20">
          <div className="h-full rounded-full bg-white/80 transition-[width] duration-100" style={{ width: `${progress}%` }} />
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

export const VideoNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const addNode = useStore((state) => state.addNode);
  const saveCanvasToBackend = useStore((state) => state.saveCanvasToBackend);
  const nodes = useStore((state) => state.nodes);
  const [preview, setPreview] = useState(false);
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
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
      const uploadResp = await fetch('/api/app/upload', { method: 'POST', body: form, credentials: 'include' });
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
            'relative flex items-center justify-center overflow-hidden rounded-[20px] border text-violet-100/40',
            NODE_TONE_STYLES.video.surface,
            aspectClass,
            data.url && 'cursor-zoom-in',
          )}
          onDoubleClick={() => data.url && setPreview(true)}
        >
          {data.url ? (
            <video ref={videoRef} src={data.url} draggable={false} className="absolute inset-0 h-full w-full object-cover select-none" muted loop preload="auto" />
          ) : data.poster ? (
            <img src={data.poster} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-60 select-none" />
          ) : null}
          {!data.url ? <Video className="relative z-10 h-6 w-6" /> : null}
        </div>
        {data.url ? <VideoHoverControls videoRef={videoRef} hovered={hovered} onCapture={handleCapture} /> : null}
      </div>
      {preview && data.url ? <PreviewModal kind="video" src={data.url} onClose={() => setPreview(false)} /> : null}
    </BaseNode>
  );
};

export const ReferenceImageNode = ({ id, data, selected }: any) => {
  const [preview, setPreview] = useState(false);
  const mediaAspectRatio = data.mediaWidth && data.mediaHeight ? `${data.mediaWidth} / ${data.mediaHeight}` : undefined;
  const displayName = getReferenceDisplayName(data);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const resolutionLabel = formatMediaResolution(data.mediaWidth, data.mediaHeight);

  return (
    <BaseNode
      icon={ImageIcon}
      tone="neutral"
      title={<EditableNodeTitle nodeId={id} value={displayName || "Untitled"} field="sourceName" preserveExtension />}
      headerRight={resolutionLabel}
      selected={selected}
      error={data.error}
    >
      <div
        className={clsx(
          "relative overflow-hidden rounded-[20px] border cursor-zoom-in",
          NODE_TONE_STYLES.neutral.surface,
          mediaAspectRatio ? "min-h-[120px]" : "aspect-video",
        )}
        style={mediaAspectRatio ? { aspectRatio: mediaAspectRatio } : undefined}
        onDoubleClick={() => data.url && setPreview(true)}
      >
        {data.url ? (
          <img
            src={data.url}
            alt={displayName}
            draggable={false}
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
      </div>
      {preview && data.url ? <PreviewModal kind="image" src={data.url} onClose={() => setPreview(false)} /> : null}
    </BaseNode>
  );
};

export const ReferenceVideoNode = ({ id, data, selected }: any) => {
  const [preview, setPreview] = useState(false);
  const mediaAspectRatio = data.mediaWidth && data.mediaHeight ? `${data.mediaWidth} / ${data.mediaHeight}` : undefined;
  const displayName = getReferenceDisplayName(data);
  const updateNodeData = useStore((state) => state.updateNodeData);
  const resolutionLabel = formatMediaResolution(data.mediaWidth, data.mediaHeight);

  return (
    <BaseNode
      icon={Video}
      tone="neutral"
      title={<EditableNodeTitle nodeId={id} value={displayName || "Untitled"} field="sourceName" preserveExtension />}
      headerRight={resolutionLabel}
      selected={selected}
      error={data.error}
    >
      <div
        className={clsx(
          "relative overflow-hidden rounded-[20px] border cursor-zoom-in",
          NODE_TONE_STYLES.neutral.surface,
          mediaAspectRatio ? "min-h-[120px]" : "aspect-video",
        )}
        style={mediaAspectRatio ? { aspectRatio: mediaAspectRatio } : undefined}
        onDoubleClick={() => data.url && setPreview(true)}
      >
        {data.url ? (
          <video
            src={data.url}
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover select-none"
            muted
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
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
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="audio" fallbackModel="suno-v4" />}
    >
      <div className={clsx('flex items-center space-x-3 rounded-[20px] border p-3 text-neutral-200 shadow-inner', NODE_TONE_STYLES.audio.surface)}>
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

export const PanoramaNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const aspectClass = getAspectRatioClass(getNodeParams(data).aspectRatio, 'aspect-[2/1]');
  return (
    <BaseNode
      icon={Globe}
      tone="neutral"
      title={language === 'zh' ? '生成全景' : '360 Environment'}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      <div className={clsx('relative flex items-center justify-center overflow-hidden rounded-[20px] border', NODE_TONE_STYLES.neutral.surface, aspectClass)}>
        {data.url ? <img src={data.url} alt="" draggable={false} className="h-full w-full object-cover select-none" /> : <Globe className="h-6 w-6 text-sky-100/40" />}
      </div>
    </BaseNode>
  );
};

const RenamableTextNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const title = data.customTitle || (language === 'zh' ? '生成文本' : 'Generate Text');
  return (
    <BaseNode
      icon={Type}
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      tone="text"
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="text" fallbackModel="gpt-4.1-mini" />}
    >
      <div className={clsx('w-full min-h-[88px] rounded-[20px] border p-3 text-xs text-neutral-300 shadow-inner', NODE_TONE_STYLES.text.surface)}>
        {data.content || (language === 'zh' ? '输入文本后结果会出现在这里...' : 'Generated text will appear here...')}
      </div>
    </BaseNode>
  );
};

const RenamableImageNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const [preview, setPreview] = useState(false);
  const [naturalRatio, setNaturalRatio] = useState<string | null>(null);
  const paramAspect = getNodeParams(data).aspectRatio;
  const title = data.customTitle || (language === 'zh' ? '生成图像' : 'Generate Image');
  const effectiveAspect = naturalRatio ?? paramAspect;
  const aspectClass = getAspectRatioClass(effectiveAspect, 'aspect-video');

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
      loading={data.status === 'generating' || data.status === 'running'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      {data.url ? (
        <div
          className={clsx('relative overflow-hidden rounded-[20px] border cursor-zoom-in', NODE_TONE_STYLES.image.surface, aspectClass)}
          onDoubleClick={() => setPreview(true)}
        >
          <img src={data.url} alt="" draggable={false} className="h-full w-full object-cover select-none" onLoad={handleImageLoad} />
        </div>
      ) : (
        <div className={clsx('flex items-center justify-center rounded-[20px] border text-orange-100/45', NODE_TONE_STYLES.image.surface, aspectClass)}>
          <ImageIcon className="h-6 w-6" />
        </div>
      )}
      {preview && data.url ? <PreviewModal kind="image" src={data.url} onClose={() => setPreview(false)} /> : null}
    </BaseNode>
  );
};

const RenamableVideoNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const addNode = useStore((state) => state.addNode);
  const nodes = useStore((state) => state.nodes);
  const [preview, setPreview] = useState(false);
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const aspectClass = getAspectRatioClass(getNodeParams(data).aspectRatio, 'aspect-video');
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
      const uploadResp = await fetch('/api/app/upload', { method: 'POST', body: form, credentials: 'include' });
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
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="video" fallbackModel="runway-gen3" />}
    >
      <div className="relative" onMouseEnter={data.url ? handleMouseEnter : undefined} onMouseLeave={data.url ? handleMouseLeave : undefined}>
        <div
          className={clsx(
            'relative flex items-center justify-center overflow-hidden rounded-[20px] border text-violet-100/40',
            NODE_TONE_STYLES.video.surface,
            aspectClass,
            data.url && 'cursor-zoom-in',
          )}
          onDoubleClick={() => data.url && setPreview(true)}
        >
          {data.url ? (
            <video ref={videoRef} src={data.url} draggable={false} className="absolute inset-0 h-full w-full object-cover select-none" muted loop preload="auto" />
          ) : data.poster ? (
            <img src={data.poster} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-60 select-none" />
          ) : null}
          {!data.url ? <Video className="relative z-10 h-6 w-6" /> : null}
        </div>
        {data.url ? <VideoHoverControls videoRef={videoRef} hovered={hovered} onCapture={handleCapture} /> : null}
      </div>
      {preview && data.url ? <PreviewModal kind="video" src={data.url} onClose={() => setPreview(false)} /> : null}
    </BaseNode>
  );
};

const RenamableAudioNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const title = data.customTitle || (language === 'zh' ? '生成音频' : 'Generate Audio');
  return (
    <BaseNode
      icon={Music}
      tone="audio"
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="audio" fallbackModel="suno-v4" />}
    >
      <div className={clsx('flex items-center space-x-3 rounded-[20px] border p-3 text-neutral-200 shadow-inner', NODE_TONE_STYLES.audio.surface)}>
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

const RenamablePanoramaNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const aspectClass = getAspectRatioClass(getNodeParams(data).aspectRatio, 'aspect-[2/1]');
  const title = data.customTitle || (language === 'zh' ? '生成全景' : '360 Environment');
  return (
    <BaseNode
      icon={Globe}
      tone="neutral"
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      selected={selected}
      loading={data.status === 'generating' || data.status === 'running'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      <div className={clsx('relative flex items-center justify-center overflow-hidden rounded-[20px] border', NODE_TONE_STYLES.neutral.surface, aspectClass)}>
        {data.url ? <img src={data.url} alt="" draggable={false} className="h-full w-full object-cover select-none" /> : <Globe className="h-6 w-6 text-sky-100/40" />}
      </div>
    </BaseNode>
  );
};

const ModeTextNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
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

  /** Floating formatting toolbar shown above the node when actively editing. */
  const editorToolbar = activeMode === 'editor' && isEditing ? (
    <div className="flex items-center gap-1 rounded-full border border-white/10 bg-[#1a1d22]/95 px-2 py-1.5 shadow-2xl backdrop-blur-xl">
      {([
        { Icon: Highlighter, key: 'bg', title: language === 'zh' ? '高亮背景色' : 'Highlight', onClick: () => exec('hiliteColor', '#fde68a') },
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
  ) : undefined;

  return (
    <BaseNode
      icon={Type}
      title={<EditableNodeTitle nodeId={id} value={title} field="customTitle" />}
      tone="text"
      selected={selected}
      error={data.error}
      topFloatingPanel={editorToolbar}
      promptPanel={activeMode === 'chooser' ? <PromptPanel nodeId={id} serviceType="text" fallbackModel="gpt-4.1-mini" /> : undefined}
    >
      <div
        className={clsx(
          'nodrag nopan space-y-2 p-3 text-sm',
          // Only apply the inner-bordered "surface" frame in non-editor modes.
          // In editor mode the contentEditable sits flush on the BaseNode shell.
          activeMode !== 'editor' && clsx('rounded-[20px] border shadow-inner', NODE_TONE_STYLES.text.surface),
        )}
        onMouseDown={stopNodeGesture}
        onPointerDown={stopNodeGesture}
        onClick={(event) => event.stopPropagation()}
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
          <div className="relative">
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={(event) => updateNodeData(id, { content: (event.target as HTMLDivElement).innerHTML })}
              onFocus={() => setIsEditing(true)}
              onBlur={() => setIsEditing(false)}
              onMouseDown={stopNodeGesture}
              onPointerDown={stopNodeGesture}
              className="nodrag nopan rich-text-editor min-h-[220px] w-full bg-transparent p-2 text-sm text-neutral-100 outline-none"
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
      </div>
      {isFullscreen ? createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm" onClick={() => setIsFullscreen(false)}>
          <div className="relative flex h-[82vh] w-[58vw] min-w-[720px] max-w-[92vw] flex-col rounded-2xl border border-white/10 bg-[#1a1d22]/98 px-6 py-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              onClick={() => setIsFullscreen(false)}
              className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="mb-3 text-sm text-neutral-300">{title}</div>
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

export const nodeTypes = {
  textNode: ModeTextNode,
  imageNode: RenamableImageNode,
  videoNode: RenamableVideoNode,
  audioNode: RenamableAudioNode,
  panoramaNode: RenamablePanoramaNode,
  referenceImageNode: ReferenceImageNode,
  referenceVideoNode: ReferenceVideoNode,
};

