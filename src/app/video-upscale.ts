import type { AppProviderConfig } from './api/providerConfigs';

export const VISIONULAR_UPSCALE_TIERS = [
  { resolution: '1080p', model: 'visionular-genopt-1080p', template: 'genopt_1080p', zh: '高清', en: 'Full HD' },
  { resolution: '1440p', model: 'visionular-genopt-1440p', template: 'genopt_1440p', zh: '超清', en: 'QHD' },
  { resolution: '2160p', model: 'visionular-genopt-2160p', template: 'genopt_2160p', zh: '4K 极清', en: '4K UHD' },
] as const;

export type VideoUpscaleSelection =
  | { engine: 'seedvr2'; scale: number; quality: 'MEDIUM' | 'HIGH' | 'ULTRA' }
  | { engine: 'visionular'; resolution: typeof VISIONULAR_UPSCALE_TIERS[number]['resolution'] };

export function visionularUpscaleProvider(configs: AppProviderConfig[], model: string) {
  return configs.find(config => config.vendor.toLowerCase() === 'visionular'
    && config.service_type === 'video' && config.model_list.includes(model));
}
