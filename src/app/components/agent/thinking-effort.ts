import { isThinkingCapableModel, isThinkingDefaultOn } from '../../model-templates';

export type ThinkingEffort = 'off' | 'low' | 'high' | 'max';

// Older models do not expose the V4 reasoning-effort control.
export function thinkingEfforts(model: string): ThinkingEffort[] {
  const key = model.trim().toLowerCase();
  if (/^deepseek-(flash|pro)(?:$|-)/.test(key) || key.includes('deepseek-v4')) {
    return ['off', 'low', 'high', 'max'];
  }
  return isThinkingCapableModel(model) ? ['off', 'high'] : [];
}

export function effectiveThinkingEffort(model: string, selected: ThinkingEffort | null): ThinkingEffort {
  const options = thinkingEfforts(model);
  if (selected && options.includes(selected)) return selected;
  return isThinkingDefaultOn(model) && options.includes('high') ? 'high' : 'off';
}

export function thinkingRequest(model: string, selected: ThinkingEffort | null) {
  const options = thinkingEfforts(model);
  if (!options.length) return {};
  const effort = effectiveThinkingEffort(model, selected);
  return {
    thinking: effort !== 'off',
    ...(options.length > 2 && effort !== 'off' ? { reasoning_effort: effort } : {}),
  };
}
