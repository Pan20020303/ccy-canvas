import type { ZImageParams } from '../../zimage-params';
import { buildZImageParams } from '../../zimage-params';

export function ZImageParamsControls({ value, onChange, zh }: {
  value?: ZImageParams;
  onChange: (value: ZImageParams) => void;
  zh: boolean;
}) {
  const p = buildZImageParams(value);
  const patch = (next: Partial<ZImageParams>) => onChange({ ...value, ...next });
  const selectClass = 'mt-1 w-full rounded-lg border border-white/10 bg-[#202329] px-2 py-2 text-xs text-neutral-200';
  return (
    <div className="mt-4 space-y-3 border-t border-white/10 pt-3" data-testid="zimage-parameters">
      <div className="text-[11px] leading-5 text-neutral-400">
        {zh ? '本地 Z-Image · 文生图 · CFG 固定 1。分辨率为长边，宽高对齐到 16 像素。' : 'Local text-to-image · CFG 1. Resolution is the long edge; dimensions align to 16px.'}
      </div>
      <label className="block text-[11px] text-neutral-400">
        {zh ? '采样步数（推荐 8）' : 'Steps (recommended: 8)'}
        <input aria-label={zh ? '采样步数' : 'Steps'} className={selectClass} type="number" min={4} max={20} step={1} value={p.steps}
          onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 4 && n <= 20) patch({ steps: n }); }} />
      </label>
      <label className="block text-[11px] text-neutral-400">
        {zh ? '采样器' : 'Sampler'}
        <select aria-label={zh ? '采样器' : 'Sampler'} className={selectClass} value={p.sampler} onChange={e => patch({ sampler: e.target.value as ZImageParams['sampler'] })}>
          <option value="res_multistep">res_multistep</option><option value="euler">euler</option>
        </select>
      </label>
      <label className="block text-[11px] text-neutral-400">
        {zh ? '调度器' : 'Scheduler'}
        <select aria-label={zh ? '调度器' : 'Scheduler'} className={selectClass} value={p.scheduler} onChange={e => patch({ scheduler: e.target.value as ZImageParams['scheduler'] })}>
          <option value="simple">simple</option><option value="beta">beta</option>
        </select>
      </label>
      <label className="block text-[11px] text-neutral-400">
        LoRA
        <select aria-label="Z-Image LoRA" className={selectClass} value={p.lora} onChange={e => patch({ lora: e.target.value as ZImageParams['lora'] })}>
          <option value="none">{zh ? '关闭 · 原模型' : 'Off · Base model'}</option>
          <option value="pixel-art">{zh ? '像素画风格 · Pixel Art' : 'Pixel Art style'}</option>
        </select>
      </label>
      {p.lora === 'pixel-art' && (
        <label className="block text-[11px] text-neutral-400">
          {zh ? 'LoRA 强度' : 'LoRA strength'} · {p.lora_strength.toFixed(2)}
          <input aria-label={zh ? 'LoRA 强度' : 'LoRA strength'} className="mt-2 w-full accent-emerald-400" type="range" min={0} max={1.5} step={0.05} value={p.lora_strength} onChange={e => patch({ loraStrength: Number(e.target.value) })} />
          <span className="block">{zh ? '0 为关闭；建议从 0.8 开始，提示词可加入 pixel art。' : '0 disables LoRA. Start at 0.8; try “pixel art” in your prompt.'}</span>
        </label>
      )}
    </div>
  );
}
