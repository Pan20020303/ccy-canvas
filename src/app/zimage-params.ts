export type ZImageParams = {
  steps?: number;
  sampler?: 'res_multistep' | 'euler';
  scheduler?: 'simple' | 'beta';
  lora?: 'none' | 'pixel-art';
  loraStrength?: number;
};

export function buildZImageParams(params?: ZImageParams) {
  return {
    steps: params?.steps ?? 8,
    sampler: params?.sampler ?? 'res_multistep',
    scheduler: params?.scheduler ?? 'simple',
    lora: params?.lora ?? 'none',
    lora_strength: params?.loraStrength ?? 0.8,
  };
}
