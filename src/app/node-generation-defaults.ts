import type { ServiceType } from './model-config';
import type { NodeGenerationParams } from './store';

export type LastGenerationParams = Partial<Record<ServiceType, NodeGenerationParams>>;

export function generationServiceForNode(type?: string): ServiceType | undefined {
  const services: Record<string, ServiceType | undefined> = { textNode: 'text', imageNode: 'image', panoramaNode: 'image', videoNode: 'video', audioNode: 'audio' };
  return type ? services[type] : undefined;
}

// Keep only reusable controls. References, masks and edit/derivation inputs belong
// to their original node and must never leak into a newly created node.
export function reusableGenerationParams(raw: unknown): NodeGenerationParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['vendor', 'model', 'mode', 'resolution', 'quality', 'aspectRatio', 'outputFormat', 'audioSetting', 'voiceDescription', 'audioLanguage'] as const) {
    if (typeof source[key] === 'string') result[key] = source[key];
  }
  for (const key of ['durationSeconds', 'audioSpeed', 'seed', 'outputCount'] as const) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) result[key] = source[key];
  }
  const controls = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries = Object.entries(value).filter(([key, entry]) => keys.includes(key)
      && (typeof entry === 'string' || typeof entry === 'number' && Number.isFinite(entry)));
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  const zImage = controls(source.zImage, ['steps', 'sampler', 'scheduler', 'lora', 'loraStrength']);
  if (zImage) result.zImage = zImage;
  const local = source.localImage as Record<string, unknown> | undefined;
  if (local && typeof local === 'object' && !Array.isArray(local)) {
    const entries = ['klein', 'krea2'].flatMap(kind => {
      const value = controls(local[kind], ['steps', 'cfg', 'lora', 'loraStrength']);
      return value ? [[kind, value]] : [];
    });
    if (entries.length) result.localImage = Object.fromEntries(entries);
  }
  return result as NodeGenerationParams;
}

export function normalizeLastGenerationParams(raw: unknown): LastGenerationParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: LastGenerationParams = {};
  for (const kind of ['text', 'image', 'video', 'audio'] as const) {
    const params = reusableGenerationParams((raw as Record<string, unknown>)[kind]);
    if (params.model) result[kind] = params;
  }
  return result;
}
