import { useEffect, useMemo, useRef, useState } from 'react';
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
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../../store';
import { getEnabledConfigsForServiceType, ServiceType } from '../../model-config';
import { getModelTemplate, type ModelTemplate } from '../../model-templates';

const Dropdown = ({
  label,
  value,
  options,
  onChange,
  align = 'left',
}: {
  label?: React.ReactNode;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  align?: 'left' | 'right';
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
              'absolute z-20 mb-1 mt-1 min-w-[140px] rounded-lg border border-white/10 bg-[#1a1d22]/95 py-1 shadow-2xl backdrop-blur-xl',
              align === 'right' ? 'right-0' : 'left-0',
              'bottom-full',
            )}
          >
            {options.map((option) => (
              <button
                key={option}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
                className={clsx(
                  'w-full px-3 py-1.5 text-left text-xs transition hover:bg-white/5',
                  option === value ? 'text-cyan-300' : 'text-neutral-300',
                )}
              >
                {option}
              </button>
            ))}
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

const MediaOptionsPopover = ({
  template,
  resolution,
  aspectRatio,
  onResolution,
  onAspectRatio,
}: {
  template: ModelTemplate;
  resolution: string;
  aspectRatio: string;
  onResolution: (v: string) => void;
  onAspectRatio: (v: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const language = useStore((state) => state.language);
  const labelParts = [
    template.supportsAutoAspect && aspectRatio === 'auto' ? (language === 'zh' ? '自适应' : 'Auto') : aspectRatio,
    template.supportsResolution ? resolution : null,
  ].filter(Boolean);

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
          <div className="absolute bottom-full left-0 z-20 mb-2 w-[320px] rounded-xl border border-white/10 bg-[#1a1d22]/95 p-4 shadow-2xl backdrop-blur-xl">
            {template.supportsResolution && template.resolutionOptions?.length ? (
              <>
                <div className="mb-2 text-xs text-neutral-400">{language === 'zh' ? '分辨率' : 'Resolution'}</div>
                <div className="mb-4 grid grid-cols-3 gap-2">
                  {template.resolutionOptions.map((option) => (
                    <button
                      key={option}
                      onClick={() => onResolution(option)}
                      className={clsx(
                        'rounded-md py-2 text-sm transition',
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
            {template.supportsAspectRatio && template.aspectRatioOptions?.length ? (
              <>
                <div className="mb-2 text-xs text-neutral-400">{language === 'zh' ? '比例' : 'Ratio'}</div>
                <div className="grid grid-cols-5 gap-2">
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
                  {template.aspectRatioOptions.map((option) => (
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
          </div>
        </>
      ) : null}
    </div>
  );
};

const DurationPopover = ({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) => {
  const [open, setOpen] = useState(false);
  const language = useStore((state) => state.language);
  return (
    <div className="relative nodrag">
      <button
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-300 transition hover:bg-white/5"
      >
        <span>{value}s</span>
        <ChevronDown className="h-3 w-3 text-neutral-500" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-20 mb-2 w-[180px] rounded-xl border border-white/10 bg-[#1a1d22]/95 p-4 shadow-2xl backdrop-blur-xl">
            <div className="mb-3 text-xs text-neutral-400">{language === 'zh' ? '视频时长' : 'Duration'}</div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={(event) => onChange(Number(event.target.value))}
              className="w-full accent-cyan-400"
            />
            <div className="mt-2 flex items-center justify-between text-[10px] text-neutral-500">
              <span>{min}s</span>
              <span>{max}s</span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
};

const getNodeParams = (data: any) => ((data?.generationParams ?? {}) as Record<string, any>);

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

const NODE_TONE_STYLES = {
  text: {
    shell: 'border-cyan-300/16 before:from-cyan-300/12 before:to-transparent shadow-[0_24px_80px_-34px_rgba(34,211,238,0.32)]',
    selected: 'shadow-[0_0_0_1px_rgba(103,232,249,0.45),0_28px_88px_-34px_rgba(34,211,238,0.42)]',
    surface: 'border-cyan-200/10 bg-[linear-gradient(180deg,rgba(44,86,110,0.26),rgba(18,24,31,0.7))]',
  },
  image: {
    shell: 'border-orange-300/16 before:from-orange-300/12 before:to-transparent shadow-[0_24px_80px_-34px_rgba(251,146,60,0.3)]',
    selected: 'shadow-[0_0_0_1px_rgba(253,186,116,0.45),0_28px_88px_-34px_rgba(249,115,22,0.42)]',
    surface: 'border-orange-200/10 bg-[linear-gradient(180deg,rgba(110,67,34,0.24),rgba(23,19,17,0.72))]',
  },
  video: {
    shell: 'border-violet-300/16 before:from-violet-300/12 before:to-transparent shadow-[0_24px_80px_-34px_rgba(167,139,250,0.32)]',
    selected: 'shadow-[0_0_0_1px_rgba(196,181,253,0.45),0_28px_88px_-34px_rgba(139,92,246,0.42)]',
    surface: 'border-violet-200/10 bg-[linear-gradient(180deg,rgba(69,50,118,0.26),rgba(20,18,33,0.74))]',
  },
  audio: {
    shell: 'border-emerald-300/16 before:from-emerald-300/12 before:to-transparent shadow-[0_24px_80px_-34px_rgba(52,211,153,0.28)]',
    selected: 'shadow-[0_0_0_1px_rgba(110,231,183,0.45),0_28px_88px_-34px_rgba(16,185,129,0.38)]',
    surface: 'border-emerald-200/10 bg-[linear-gradient(180deg,rgba(40,95,76,0.26),rgba(16,27,24,0.72))]',
  },
  neutral: {
    shell: 'border-sky-200/14 before:from-sky-200/10 before:to-transparent shadow-[0_24px_80px_-34px_rgba(96,165,250,0.24)]',
    selected: 'shadow-[0_0_0_1px_rgba(125,211,252,0.4),0_28px_88px_-34px_rgba(59,130,246,0.32)]',
    surface: 'border-slate-200/10 bg-[linear-gradient(180deg,rgba(49,62,86,0.24),rgba(18,24,31,0.72))]',
  },
} as const;

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
  const modelConfigs = useStore((state) => state.modelConfigs);
  const updateNodeGenerationParams = useStore((state) => state.updateNodeGenerationParams);
  const upstreamIds = edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  const [text, setText] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const currentNode = allNodes.find((node) => node.id === nodeId);
  const params = getNodeParams(currentNode?.data);

  const enabledConfigs = useMemo(
    () => getEnabledConfigsForServiceType(modelConfigs, serviceType)
      .map((config) => ({
        ...config,
        modelList: config.modelList.filter((modelName) => !!getModelTemplate(modelName)),
      }))
      .filter((config) => config.modelList.length > 0),
    [modelConfigs, serviceType],
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

  const onChange = (value: string) => {
    setText(value);
    const cursor = taRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const match = /@(\w*)$/.exec(before);
    setMentionOpen(Boolean(match) && upstreamIds.length > 0);
  };

  const insertMention = (id: string) => {
    const cursor = taRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, cursor).replace(/@(\w*)$/, `@${id.slice(0, 6)} `);
    const after = text.slice(cursor);
    setText(before + after);
    setMentionOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
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
    runNode(nodeId, { prompt: text, model: activeModel });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative mt-6 -ml-[80px] w-[460px] rounded-2xl border border-white/[0.06] bg-[#15181d]/80 px-5 py-4 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-2xl nodrag">
      <textarea
        ref={taRef}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={language === 'zh' ? '输入提示词，用 @ 引用已连接节点' : 'Enter a prompt - use @ to reference connected nodes'}
        className="min-h-[88px] w-full resize-none bg-transparent text-[13px] leading-relaxed text-neutral-200 placeholder-neutral-500 focus:outline-none"
      />
      {mentionOpen ? (
        <div className="absolute left-5 top-12 z-30 w-[200px] rounded-lg border border-white/10 bg-[#1a1d22]/95 py-1 shadow-2xl backdrop-blur-xl">
          {upstreamIds.map((id) => {
            const node = allNodes.find((item) => item.id === id);
            return (
              <button
                key={id}
                onClick={() => insertMention(id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition hover:bg-white/5"
              >
                <span className="text-cyan-300">@{id.slice(0, 6)}</span>
                <span className="truncate text-neutral-500">{(node?.type || '').replace('Node', '')}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {vendorOptions.length ? (
            <Dropdown value={activeVendor} options={vendorOptions} onChange={handleVendorChange} />
          ) : null}
          <Dropdown
            label={<Sparkles className="h-3 w-3 text-neutral-400" />}
            value={modelIsDisabled && params.model ? `${params.model}（已停用）` : activeModel}
            options={availableModels}
            onChange={handleModelChange}
          />
          {template?.supportsMode && template.modeOptions?.length ? (
            <Dropdown
              value={currentMode}
              options={template.modeOptions}
              onChange={(value) => updateNodeGenerationParams(nodeId, { mode: value })}
            />
          ) : null}
          {template && (template.supportsResolution || template.supportsAspectRatio || template.supportsAutoAspect) ? (
            <MediaOptionsPopover
              template={template}
              resolution={currentResolution}
              aspectRatio={currentAspectRatio}
              onResolution={(value) => updateNodeGenerationParams(nodeId, { resolution: value })}
              onAspectRatio={(value) => updateNodeGenerationParams(nodeId, { aspectRatio: value })}
            />
          ) : null}
          {template?.supportsDuration && template.durationRange ? (
            <DurationPopover
              value={currentDuration}
              min={template.durationRange.min}
              max={template.durationRange.max}
              step={template.durationRange.step}
              onChange={(value) => updateNodeGenerationParams(nodeId, { durationSeconds: value })}
            />
          ) : null}
        </div>
        <button
          onClick={submit}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-500/20 text-cyan-200 transition hover:bg-cyan-500/40"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

const BaseNode = ({
  icon: Icon,
  title,
  children,
  selected,
  promptPanel,
  loading,
  error,
  tone = 'neutral',
}: {
  icon: any;
  title: string;
  children: React.ReactNode;
  selected?: boolean;
  promptPanel?: React.ReactNode;
  loading?: boolean;
  error?: string;
  tone?: keyof typeof NODE_TONE_STYLES;
}) => {
  const toneStyles = NODE_TONE_STYLES[tone];
  return (
    <div className="group w-[300px]">
      <div className="mb-2 flex items-center gap-1.5 pl-1 text-[11px] text-neutral-400">
        <Icon className="h-3 w-3" />
        <span className="tracking-wide">{title}</span>
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
          {error ? <div className="break-words px-3 pb-3 text-[11px] text-rose-300">{error}</div> : null}
          {loading ? (
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
              <div className="absolute inset-y-0 -left-1/3 w-1/3 animate-[node-sweep_1.8s_linear_infinite] bg-gradient-to-r from-transparent via-cyan-400/30 to-transparent" />
            </div>
          ) : null}
        </div>

        <Handle
          type="target"
          position={Position.Left}
          className={clsx(
            '!h-6 !w-6 !-left-3 !rounded-full !border-0 !bg-transparent opacity-0 transition-opacity group-hover:opacity-100',
            selected && '!opacity-100',
          )}
          style={{ transform: 'translate(0, -50%)' }}
        >
          <div className="pointer-events-none flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-[#1a1d22]/90 backdrop-blur-md">
            <Plus className="h-3 w-3 text-neutral-300" />
          </div>
        </Handle>
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

      {selected ? promptPanel : null}
    </div>
  );
};

const PreviewModal = ({ kind, src, onClose }: { kind: 'image' | 'video'; src: string; onClose: () => void }) => {
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/85 p-8 backdrop-blur-md"
      onClick={onClose}
      onWheel={(event) => event.stopPropagation()}
    >
      <button
        onClick={onClose}
        className="absolute right-6 top-6 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      <div className="max-h-[90vh] max-w-[90vw]" onClick={(event) => event.stopPropagation()}>
        {kind === 'image' ? (
          <img src={src} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl" />
        ) : (
          <video src={src} controls autoPlay className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl" />
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
      loading={data.status === 'generating'}
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
  const aspectClass = getAspectRatioClass(getNodeParams(data).aspectRatio, 'aspect-video');
  return (
    <BaseNode
      icon={ImageIcon}
      tone="image"
      title={language === 'zh' ? '生成图像' : 'Generate Image'}
      selected={selected}
      loading={data.status === 'generating'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      {data.url ? (
        <div
          className={clsx('relative overflow-hidden rounded-[20px] border cursor-zoom-in nodrag', NODE_TONE_STYLES.image.surface, aspectClass)}
          onDoubleClick={() => setPreview(true)}
        >
          <img src={data.url} alt="" className="h-full w-full object-cover" />
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

export const VideoNode = ({ id, data, selected }: any) => {
  const language = useStore((state) => state.language);
  const [preview, setPreview] = useState(false);
  const aspectClass = getAspectRatioClass(getNodeParams(data).aspectRatio, 'aspect-video');
  return (
    <BaseNode
      icon={Video}
      tone="video"
      title={language === 'zh' ? '生成视频' : 'Generate Video'}
      selected={selected}
      loading={data.status === 'generating'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="video" fallbackModel="runway-gen3" />}
    >
      <div
        className={clsx(
          'relative flex items-center justify-center overflow-hidden rounded-[20px] border text-violet-100/40',
          NODE_TONE_STYLES.video.surface,
          aspectClass,
          data.url && 'cursor-zoom-in nodrag',
        )}
        onDoubleClick={() => data.url && setPreview(true)}
      >
        {data.url ? (
          <video src={data.url} className="absolute inset-0 h-full w-full object-cover" muted />
        ) : data.poster ? (
          <img src={data.poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />
        ) : null}
        {!data.url ? <Video className="relative z-10 h-6 w-6" /> : null}
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
      loading={data.status === 'generating'}
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
      loading={data.status === 'generating'}
      error={data.error}
      promptPanel={<PromptPanel nodeId={id} serviceType="image" fallbackModel="gpt-image-2" />}
    >
      <div className={clsx('relative flex items-center justify-center overflow-hidden rounded-[20px] border', NODE_TONE_STYLES.neutral.surface, aspectClass)}>
        {data.url ? <img src={data.url} alt="" className="h-full w-full object-cover" /> : <Globe className="h-6 w-6 text-sky-100/40" />}
      </div>
    </BaseNode>
  );
};

export const nodeTypes = {
  textNode: TextNode,
  imageNode: ImageNode,
  videoNode: VideoNode,
  audioNode: AudioNode,
  panoramaNode: PanoramaNode,
};
