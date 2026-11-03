import type { AppProviderConfig } from './api/providerConfigs';
import { getModelTemplate } from './model-templates';

/** Confirmed DeepSeek image-input aliases, deliberately not a whole-family match. */
const DEEPSEEK_VISION_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);

export function supportsModelVision(model: string | null | undefined, provider?: AppProviderConfig): boolean {
  const name = model?.trim().toLowerCase() ?? '';
  if (!name || (provider && provider.service_type !== 'text')) return false;
  if (name.startsWith('deepseek')) return DEEPSEEK_VISION_MODELS.has(name);
  const template = getModelTemplate(name, provider);
  if (template?.supportsVision != null) return template.supportsVision;
  return /(-vl|vl-|vision|4o|gemini|glm-4v|qwen3\.7-plus)/i.test(name);
}

/** Keep media analysis on the model chosen for this chat. No silent model switch. */
export function selectAgentVisionModel(configs: AppProviderConfig[], selectedModel: string | null | undefined): string | null {
  const model = selectedModel?.trim();
  if (!model) return null;
  const matching = configs.filter(config => (config.model_list ?? []).includes(model) || config.default_model === model);
  const provider = matching.find(config => config.service_type === 'text') ?? matching[0];
  return supportsModelVision(model, provider) ? model : null;
}
