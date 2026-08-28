import { REFERENCE_MODE_SPECS, type ReferenceModeKey, type ReferenceRequirementOverride } from '../../reference-modes';

type Range = { min: number; max: number };
export type ReferenceLimits = { images: Range; videos: Range; audios: Range };

/** Use declared capabilities only; an unknown model must not advertise invented limits. */
export function resolveReferenceLimits({ mode, override, imageRange, suffixRequires }: {
  mode?: ReferenceModeKey | null;
  override?: ReferenceRequirementOverride;
  imageRange?: Range;
  suffixRequires?: { images: Range; videos: Range } | null;
}): ReferenceLimits | null {
  const none = { min: 0, max: 0 };
  if (suffixRequires) return { ...suffixRequires, audios: none };
  if (mode) return {
    ...REFERENCE_MODE_SPECS[mode].requires,
    ...override,
    audios: mode === 'all-in-one' ? { min: 0, max: 3 } : none,
  };
  return imageRange ? { images: imageRange, videos: none, audios: none } : null;
}

export function ReferenceLimitsBar({ limits, counts, zh, serviceType, canSwitchToAudioMode = false }: {
  limits: ReferenceLimits | null;
  counts: { images: number; videos: number; audios: number };
  zh: boolean;
  serviceType: string;
  canSwitchToAudioMode?: boolean;
}) {
  if (!limits) return null;
  const kinds = [
    { key: 'images', label: zh ? '图片' : 'Images' },
    { key: 'videos', label: zh ? '视频' : 'Videos' },
    { key: 'audios', label: zh ? '音频' : 'Audio' },
  ] as const;
  const supported = kinds.filter(({ key }) => limits[key].max > 0);
  const warnings = kinds.flatMap(({ key, label }) => {
    if (counts[key] <= limits[key].max) return [];
    if (limits[key].max === 0) {
      if (key === 'audios' && canSwitchToAudioMode) return [zh ? '请切换到全能参考以使用音频' : 'Switch to All-in-one to use audio'];
      return [zh ? `当前模型 / 模式不支持${label}参考` : `This model / mode takes no ${label.toLowerCase()} references`];
    }
    return [zh ? `${label}参考最多 ${limits[key].max}，当前 ${counts[key]}` : `${label}: at most ${limits[key].max}; currently ${counts[key]}`];
  });
  const textOnly = serviceType === 'image'
    ? (zh ? '仅文生图 · 不支持参考素材' : 'Text to image only · No references')
    : (zh ? '仅文生视频 · 不支持参考素材' : 'Text to video only · No references');
  return (
    <div aria-label={zh ? '参考素材限制' : 'Reference limits'} className="mb-2 flex flex-wrap items-center justify-end gap-1.5 px-1">
      {supported.length === 0 ? <span className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-neutral-400">{textOnly}</span> : supported.map(({ key, label }) => (
        <span key={key} title={zh ? `${label}参考：${limits[key].min}–${limits[key].max}` : `${label} references: ${limits[key].min}–${limits[key].max}`} className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-neutral-400">
          {label} ≤ {limits[key].max}
        </span>
      ))}
      {warnings.map(warning => <span key={warning} role="status" className="rounded-md bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-300">{warning}</span>)}
    </div>
  );
}
