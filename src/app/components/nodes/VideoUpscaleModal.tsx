import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Loader2, X } from 'lucide-react';
import clsx from 'clsx';
import { toRenderableMediaUrl } from '../../reference-media';
import { VISIONULAR_UPSCALE_TIERS, type VideoUpscaleSelection } from '../../video-upscale';

export function VideoUpscaleModal({ sourceUrl, zh, busy, availableModels, onSubmit, onClose }: {
  sourceUrl: string;
  zh: boolean;
  busy: boolean;
  availableModels: string[];
  onSubmit: (selection: VideoUpscaleSelection) => void;
  onClose: () => void;
}) {
  const availableTiers = VISIONULAR_UPSCALE_TIERS.filter(tier => availableModels.includes(tier.model));
  const [engine, setEngine] = useState<'visionular' | 'seedvr2'>(availableTiers.length ? 'visionular' : 'seedvr2');
  const [resolution, setResolution] = useState<typeof VISIONULAR_UPSCALE_TIERS[number]['resolution']>(availableTiers[0]?.resolution ?? '1080p');
  const [scale, setScale] = useState(2);
  const [quality, setQuality] = useState<'MEDIUM' | 'HIGH' | 'ULTRA'>('ULTRA');
  const tier = VISIONULAR_UPSCALE_TIERS.find(item => item.resolution === resolution)!;
  const disabled = busy || !sourceUrl || (engine === 'visionular' && !availableModels.includes(tier.model));
  const choiceClass = (active: boolean) => clsx('rounded-lg border px-3 py-2 text-xs transition disabled:cursor-not-allowed disabled:opacity-40', active ? 'border-cyan-300 bg-cyan-400/10 text-cyan-100' : 'border-white/15 text-neutral-300 hover:border-white/40');
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/85 p-6 backdrop-blur-md" onClick={onClose}>
      <section role="dialog" aria-label={zh ? '视频超分' : 'Video upscale'} aria-modal="true" className="flex h-[min(680px,84vh)] w-[min(1080px,94vw)] overflow-hidden rounded-2xl border border-white/10 bg-[#101218]" onClick={event => event.stopPropagation()}>
        <div className="flex min-w-0 flex-1 items-center justify-center bg-black/40 p-6"><video src={toRenderableMediaUrl(sourceUrl)} controls preload="metadata" className="max-h-full max-w-full rounded-lg" /></div>
        <div className="flex w-[340px] max-w-full shrink-0 flex-col border-l border-white/10">
          <div className="flex items-center justify-between p-5"><h2 className="font-semibold text-neutral-100">{zh ? '视频超分' : 'Video upscale'}</h2><button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}><X className="h-4 w-4 text-neutral-400" /></button></div>
          <div className="flex-1 space-y-5 overflow-y-auto px-5 pb-5">
            <div><div className="mb-2 text-xs text-neutral-400">{zh ? '超分引擎' : 'Engine'}</div><div className="grid grid-cols-2 gap-2">
              <button type="button" aria-pressed={engine === 'visionular'} onClick={() => setEngine('visionular')} className={choiceClass(engine === 'visionular')}>Visionular · {zh ? '云端' : 'Cloud'}</button>
              <button type="button" aria-pressed={engine === 'seedvr2'} onClick={() => setEngine('seedvr2')} className={choiceClass(engine === 'seedvr2')}>SeedVR2 · {zh ? '本地' : 'Local'}</button>
            </div></div>
            {engine === 'visionular' ? <>
              <p className="text-xs leading-relaxed text-cyan-100/75">{zh ? '使用云端画质增强模板修复细节，按目标分辨率分档，不裁切或截短原视频。' : 'Cloud video enhancement with resolution-based tiers; no cropping or trimming.'}</p>
              <div><div className="mb-2 text-xs text-neutral-400">{zh ? '目标分辨率档位' : 'Output tier'}</div><div className="space-y-2">{VISIONULAR_UPSCALE_TIERS.map(item => <button key={item.model} type="button" aria-pressed={resolution === item.resolution} disabled={!availableModels.includes(item.model)} onClick={() => setResolution(item.resolution)} className={clsx(choiceClass(resolution === item.resolution), 'flex w-full items-center justify-between')}><strong>{item.resolution}</strong><span>{zh ? item.zh : item.en}</span></button>)}</div></div>
              {!availableTiers.length && <p role="status" className="text-xs leading-relaxed text-amber-200">{zh ? '云端渠道未启用，请管理员配置 Visionular 密钥、管道和存储后刷新。也可使用本地引擎。' : 'Ask an administrator to enable the Visionular channel, then refresh. Local upscale is still available.'}</p>}
              <p className="text-[11px] leading-relaxed text-neutral-400">{zh ? '原视频需已上传至公网 OSS/COS。使用后台配置的对应档位积分价格；处理结果保存到新的派生节点。' : 'Requires a public OSS/COS source URL. Uses the configured tier credit price and creates a new result node.'}</p>
            </> : <>
              <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-100/75">SeedVR2 3B INT8 · {zh ? '本机时序一致性修复超分，自动分块，保留原帧率与音轨。' : 'Local restoration with temporal chunking, preserving FPS and audio.'}</div>
              <div><div className="mb-2 text-xs text-neutral-400">{zh ? '放大倍率' : 'Scale'}</div><div className="flex gap-2">{[2, 3, 4].map(value => <button key={value} type="button" aria-pressed={scale === value} onClick={() => setScale(value)} className={choiceClass(scale === value)}>{value}×</button>)}</div></div>
              <div><div className="mb-2 text-xs text-neutral-400">{zh ? '质量' : 'Quality'}</div><div className="flex gap-2">{(['MEDIUM', 'HIGH', 'ULTRA'] as const).map(value => <button key={value} type="button" aria-pressed={quality === value} onClick={() => setQuality(value)} className={choiceClass(quality === value)}>{value}</button>)}</div></div>
            </>}
            <p className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] leading-relaxed text-amber-100/70">{zh ? '视频越长、目标分辨率越高，处理时间和资源消耗越大。云端超分不会调用本机显卡。' : 'Longer videos and higher resolutions require more processing. Cloud upscale does not use your GPU.'}</p>
          </div>
          <div className="flex items-center justify-between border-t border-white/10 p-4"><span className="text-xs text-neutral-300">{engine === 'visionular' ? `Visionular · ${resolution}` : `SeedVR2 · ${scale}× · ${quality}`}</span><button type="button" aria-label={zh ? '开始超分' : 'Start upscale'} disabled={disabled} onClick={() => onSubmit(engine === 'visionular' ? { engine, resolution } : { engine, scale, quality })} className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}</button></div>
        </div>
      </section>
    </div>, document.body,
  );
}
