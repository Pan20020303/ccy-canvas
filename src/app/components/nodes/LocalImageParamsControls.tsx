import type { LocalImageKind, LocalImageParams } from '../../local-image-params';

export function LocalImageParamsControls({ kind, value, onChange, zh }: {
  kind: LocalImageKind; value?: LocalImageParams; onChange: (value: LocalImageParams) => void; zh: boolean;
}) {
  const klein = kind === 'klein';
  const patch = (next: Partial<LocalImageParams>) => onChange({ ...value, ...next });
  const inputClass = 'mt-1 w-full rounded-lg border border-white/10 bg-[#202329] px-2 py-2 text-xs text-neutral-200';
  return <div className="mt-4 space-y-3 border-t border-white/10 pt-3" data-testid="local-image-parameters">
    <p className="text-[11px] leading-5 text-neutral-400">{klein
      ? (zh ? 'FLUX.2 Klein Base · 0–4 图参考；不是 4 步蒸馏版。参考图按连线顺序独立编码，每张最多约 0.5MP。' : 'Klein Base · 0–4 separate references, ~0.5MP each. Not a 4-step distilled model.')
      : (zh ? 'Krea-2 Turbo · 文生图 / Darkbrush LoRA，CFG 固定 1。参考编辑请选 FLUX.2 Klein。' : 'Krea-2 Turbo · text-to-image / Darkbrush LoRA · CFG 1. Use Klein for references.')}</p>
    <p className="text-[11px] text-neutral-400">{zh ? '分辨率为长边；宽高对齐 16 像素。每次生成 1 张。' : 'Long-edge resolution; 16px alignment; one image per run.'}</p>
    <label className="block text-[11px] text-neutral-400">{zh ? '采样步数' : 'Steps'}
      <select aria-label={zh ? '本地模型采样步数' : 'Local model steps'} className={inputClass} value={value?.steps ?? (klein ? 20 : 8)} onChange={e => patch({ steps: Number(e.target.value) })}>
        {(klein ? [10, 20, 30, 40, 50] : [4, 6, 8, 12, 16]).map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
    {klein ? <label className="block text-[11px] text-neutral-400">CFG · {(value?.cfg ?? 5).toFixed(1)}
      <input aria-label="FLUX CFG" className="mt-2 w-full" type="range" min={1} max={10} step={0.5} value={value?.cfg ?? 5} onChange={e => patch({ cfg: Number(e.target.value) })} />
    </label> : <>
      <label className="block text-[11px] text-neutral-400">LoRA
        <select aria-label="Krea LoRA" className={inputClass} value={value?.lora ?? 'none'} onChange={e => patch({ lora: e.target.value as 'none' | 'darkbrush' })}>
          <option value="none">{zh ? '关闭' : 'Off'}</option><option value="darkbrush">Darkbrush · {zh ? '单色水墨' : 'Ink wash'}</option>
        </select>
      </label>
      {value?.lora === 'darkbrush' && <label className="block text-[11px] text-neutral-400">{zh ? 'LoRA 强度' : 'LoRA strength'} · {(value?.loraStrength ?? 1).toFixed(2)}
        <input aria-label="Krea LoRA strength" className="mt-2 w-full" type="range" min={0} max={1.5} step={0.05} value={value?.loraStrength ?? 1} onChange={e => patch({ loraStrength: Number(e.target.value) })} />
        <span>{zh ? '自动附加风格触发词；0 为关闭。' : 'Style trigger added automatically; 0 disables LoRA.'}</span>
      </label>}
    </>}
  </div>;
}
