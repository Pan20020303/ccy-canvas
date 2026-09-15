export type LocalImageKind = 'klein' | 'krea2';
export type LocalImageParams = { steps?: number; cfg?: number; lora?: 'none' | 'darkbrush'; loraStrength?: number };
export type LocalImageSettings = Partial<Record<LocalImageKind, LocalImageParams>>;

export function buildLocalImageParams(kind: LocalImageKind, settings?: LocalImageSettings) {
  const p = settings?.[kind];
  return kind === 'klein'
    ? { steps: p?.steps ?? 20, cfg: p?.cfg ?? 5 }
    : { steps: p?.steps ?? 8, lora: p?.lora ?? 'none', lora_strength: p?.loraStrength ?? 1 };
}
