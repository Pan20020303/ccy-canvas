import { useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import clsx from 'clsx';
import * as Popover from '@radix-ui/react-popover';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { useStore } from '../../store';
import type { ModelTemplate } from '../../model-templates';
import type { LocalImageSettings } from '../../local-image-params';
import type { ZImageParams } from '../../zimage-params';
import { ZImageParamsControls } from './ZImageParamsControls';
import { LocalImageParamsControls } from './LocalImageParamsControls';
import { useCanvasThemeStyle } from '../../use-canvas-theme';
import './node-generation-controls.css';

export const Dropdown = ({
  label,
  value,
  displayValue,
  options,
  onChange,
  align = 'left',
  side = 'top',
  renderOption,
  menuMinWidth,
}: {
  label?: React.ReactNode;
  value: string;
  displayValue?: string;
  options: string[];
  onChange: (v: string) => void;
  align?: 'left' | 'right';
  side?: 'top' | 'bottom';
  /** Optional custom renderer for each option row (gets the raw option + selected state). */
  renderOption?: (option: string, selected: boolean) => React.ReactNode;
  /** Override the popup min-width — model dropdown needs more room for icons + duration. */
  menuMinWidth?: number;
}) => {
  const style = useCanvasThemeStyle();
  return <Menu.Root>
    <Menu.Trigger asChild>
      <button type="button" className="node-control-pill nodrag nopan">
        {label}<span>{displayValue ?? value}</span><ChevronDown size={12} />
      </button>
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className="node-model-menu nodrag nopan" style={{ ...style, minWidth: menuMinWidth ?? 160 }}
        side={side} align={align === 'right' ? 'end' : 'start'} sideOffset={8} collisionPadding={12}
        onWheel={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        {options.map(option => <Menu.Item key={option} className="node-model-option" data-selected={option === value}
          onSelect={() => onChange(option)}>
          <span>{renderOption ? renderOption(option, option === value) : option}</span>
          {option === value && <Check size={14} />}
        </Menu.Item>)}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
};

/** Evenly spaced, valid values from the actual model range (never fake options). */
export function durationTicks(min: number, max: number, step: number): number[] {
  if (max <= min || step <= 0) return [min];
  const stride = Math.max(step, Math.ceil((max - min) / (7 * step)) * step);
  const ticks = [min];
  for (let value = min + stride; value < max; value += stride) ticks.push(Number(value.toFixed(2)));
  return [...ticks, max];
}

/** Unified media params popover: aspect ratio + resolution + duration in one panel. */
export const MediaParamsPopover = ({
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
  audioSpeed,
  voiceDescription,
  voiceLanguage,
  seed,
  onAudioSetting,
  onAudioSpeed,
  onVoiceDescription,
  onVoiceLanguage,
  onSeed,
  zImage,
  onZImage,
  localImage,
  onLocalImage,
}: {
  template: ModelTemplate;
  resolution: string;
  quality: string;
  aspectRatio: string;
  duration: number;
  outputFormat: string;
  audioSetting?: string;
  audioSpeed?: number;
  voiceDescription?: string;
  voiceLanguage?: string;
  seed?: number;
  onResolution: (v: string) => void;
  onQuality: (v: string) => void;
  onAspectRatio: (v: string) => void;
  onDuration: (v: number) => void;
  onOutputFormat: (v: string) => void;
  onAudioSetting?: (v: string) => void;
  onAudioSpeed?: (v: number) => void;
  onVoiceDescription?: (v: string) => void;
  onVoiceLanguage?: (v: string) => void;
  onSeed?: (v: number | undefined) => void;
  zImage?: ZImageParams;
  localImage?: LocalImageSettings;
  onLocalImage?: (value: LocalImageSettings) => void;
  onZImage?: (v: ZImageParams) => void;
}) => {
  const [open, setOpen] = useState(false);
  const language = useStore((state) => state.language);
  const themeStyle = useCanvasThemeStyle();

  const labelParts = [
    template.supportsResolution ? resolution : null,
    // Only show a duration chip when an actual duration control renders — the
    // provider schema may set supportsDuration for the family while a specific
    // mode (e.g. video-edit) has no range/options and doesn't send duration.
    (template.supportsDuration && (template.durationRange || template.durationOptions?.length)) ? `${duration}s` : null,
    template.supportsAspectRatio ? (aspectRatio === 'auto' ? (language === 'zh' ? '自适应' : 'Auto') : aspectRatio) : null,
    template.supportsQuality ? quality : null,
    template.serviceType === 'audio' && template.supportsOutputFormat ? outputFormat : null,
    template.audioSpeedRange ? `${audioSpeed ?? template.audioSpeedRange.defaultValue}×` : null,
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
  const hasAudioSpeed = !!template.audioSpeedRange && !!onAudioSpeed;
  const hasVoiceDescription = !!template.supportsVoiceDescription && !!onVoiceDescription;
  const hasVoiceLanguage = (template.audioLanguageOptions?.length ?? 0) > 0 && !!onVoiceLanguage;
  const hasSeed = !!template.supportsSeed && !!onSeed;
  const AUDIO_LABEL: Record<string, string> = {
    auto: language === 'zh' ? '自动' : 'Auto',
    origin: language === 'zh' ? '保留原声' : 'Keep source',
    // 可灵 Kling：audio 是布尔（是否生成音效），复用 audioSetting 通道。
    off: language === 'zh' ? '无声' : 'Silent',
    on: language === 'zh' ? '生成音效' : 'With audio',
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="node-control-pill nodrag nopan" aria-label={language === 'zh' ? '生成参数' : 'Generation parameters'}>
          <span>{labelParts.join(' · ') || (language === 'zh' ? '参数' : 'Parameters')}</span><ChevronDown size={12} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="node-params-menu nodrag nopan" style={themeStyle} side="top" align="start"
          sideOffset={12} collisionPadding={12} aria-label={language === 'zh' ? '生成参数' : 'Generation parameters'}
          onWheel={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            {/* ── Duration ────────────────────────────────────────────── */}
            {(hasDurationSlider || hasDurationOptions) ? (
              <div className="mb-4">
                <div className="node-param-heading"><span>{language === 'zh' ? '时长' : 'Duration'}</span><output>{duration}s</output></div>
                {hasDurationSlider ? (
                  <>
                    <input
                      type="range"
                      aria-label={language === 'zh' ? '时长' : 'Duration'}
                      min={template.durationRange!.min}
                      max={template.durationRange!.max}
                      step={template.durationRange!.step}
                      value={duration}
                      onChange={(event) => onDuration(Number(event.target.value))}
                      className="prompt-duration-slider w-full accent-white"
                    />
                    <div className="node-duration-ticks" aria-hidden="true">
                      {durationTicks(template.durationRange!.min, template.durationRange!.max, template.durationRange!.step).map(tick =>
                        <span key={tick} style={{ left: `${100 * (tick - template.durationRange!.min) / (template.durationRange!.max - template.durationRange!.min || 1)}%` }}>{tick}s</span>)}
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

            {/* ── Aspect ratio (one row of compact shape chips) ────────── */}
            {hasAspect ? (
              <div>
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '宽高比' : 'Aspect ratio'}</div>
                <div className="node-aspect-options">
                  {template.supportsAutoAspect ? (
                    <AspectBlockButton
                      ratio="auto"
                      active={aspectRatio === 'auto'}
                      onClick={() => onAspectRatio('auto')}
                      label={language === 'zh' ? '自适应' : 'Auto'}
                    />
                  ) : null}
                  {template.aspectRatioOptions!.filter(option => option !== 'auto').map((option) => (
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

            {/* ── Output format ──────────────────────────────────────── */}
            {hasOutputFormat ? (
              <div className="mb-4">
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '输出格式' : 'Output format'}</div>
                <div className="node-param-options">
                  {template.outputFormatOptions!.map((option) => (
                    <PillButton key={option} active={option === outputFormat} onClick={() => onOutputFormat(option)}>
                      {option.toUpperCase()}
                    </PillButton>
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
                    aria-label={language === 'zh' ? '生成音效' : 'Generate audio'}
                    aria-checked={audioSetting === 'on'}
                    onClick={() => onAudioSetting!(audioSetting === 'on' ? 'off' : 'on')}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                      audioSetting === 'on' ? 'node-audio-switch is-on' : 'node-audio-switch'
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

            {hasAudioSpeed ? (
              <div className="mt-4">
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '语速' : 'Speech speed'}</div>
                <div className="mb-2 text-xl font-medium tracking-tight text-white">{(audioSpeed ?? template.audioSpeedRange!.defaultValue).toFixed(2)}×</div>
                <input
                  type="range"
                  aria-label={language === 'zh' ? '语速' : 'Speech speed'}
                  min={template.audioSpeedRange!.min}
                  max={template.audioSpeedRange!.max}
                  step={template.audioSpeedRange!.step}
                  value={audioSpeed ?? template.audioSpeedRange!.defaultValue}
                  onChange={(event) => onAudioSpeed!(Number(event.target.value))}
                  className="prompt-duration-slider w-full accent-white"
                />
                <div className="mt-1 flex justify-between text-[10px] text-neutral-500 tabular-nums">
                  <span>{template.audioSpeedRange!.min}×</span>
                  <span>{template.audioSpeedRange!.max}×</span>
                </div>
              </div>
            ) : null}

            {hasVoiceDescription ? (
              <div className="mt-4">
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '音色描述' : 'Voice description'}</div>
                <textarea
                  aria-label={language === 'zh' ? '音色描述' : 'Voice description'}
                  value={voiceDescription ?? ''}
                  onChange={(event) => onVoiceDescription!(event.target.value)}
                  rows={4}
                  placeholder={language === 'zh'
                    ? '例如：年轻女声，声音温柔清晰，普通话自然，语速适中'
                    : 'e.g. A young warm female voice, clear and natural'}
                  className="w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs leading-relaxed text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-white/25"
                />
              </div>
            ) : null}

            {hasVoiceLanguage ? (
              <div className="mt-4">
                <div className="mb-2 text-[11px] text-neutral-400">{language === 'zh' ? '朗读语言' : 'Language'}</div>
                <div className="flex flex-wrap gap-1.5">
                  {template.audioLanguageOptions!.map((option) => (
                    <PillButton key={option} active={option === (voiceLanguage ?? 'Auto')} onClick={() => onVoiceLanguage!(option)}>
                      {option === 'Auto' && language === 'zh' ? '自动' : option}
                    </PillButton>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ── Seed (reproducible generation) ───────────────────────── */}
            {template.supportsZImageParams && onZImage ? (
              <ZImageParamsControls value={zImage} onChange={onZImage} zh={language === 'zh'} />
            ) : null}
            {template.localImageKind && onLocalImage ? (
              <LocalImageParamsControls kind={template.localImageKind} value={localImage?.[template.localImageKind]}
                onChange={value => onLocalImage({ ...localImage, [template.localImageKind!]: value })} zh={language === 'zh'} />
            ) : null}
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
                  aria-label={language === 'zh' ? '随机种子' : 'Seed'}
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

function PillButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className="node-param-option" aria-pressed={active} onClick={onClick}>{children}</button>;
}
function BlockButton({ active, onClick, children, className }: { active: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return <button type="button" className={clsx('node-param-option', className)} aria-pressed={active} onClick={onClick}>{children}</button>;
}
function AspectBlockButton({ ratio, active, onClick, label }: { ratio: string; active: boolean; onClick: () => void; label: string }) {
  const [w, h] = ratio.split(':').map(Number);
  const aspect = w > 0 && h > 0 ? w / h : 1.5;
  return <button type="button" className="node-param-option node-aspect-option" aria-pressed={active} onClick={onClick}>
    <span className="node-aspect-icon" style={{ width: aspect >= 1 ? 14 : 14 * aspect, height: aspect >= 1 ? 14 / aspect : 14 }} />
    <span>{label}</span>
  </button>;
}
