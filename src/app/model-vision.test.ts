import { describe, expect, it } from 'vitest';
import type { AppProviderConfig } from './api/providerConfigs';
import { selectAgentVisionModel, supportsModelVision } from './model-vision';
import { getModelTemplate } from './model-templates';

const config = (models: string[], service_type = 'text') => ({ id: 'test', model_list: models, default_model: models[0], service_type, vendor: 'test' } as AppProviderConfig);

describe('selected chat model vision routing', () => {
  it.each(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])('recognizes confirmed DeepSeek vision alias %s', model => {
    expect(supportsModelVision(model)).toBe(true);
    expect(getModelTemplate(model)?.supportsVision).toBe(true);
    expect(selectAgentVisionModel([config(['qwen3.7-plus', 'gpt-4o', model])], model)).toBe(model);
  });
  it.each(['deepseek-pro', 'deepseek-v4-pro', 'deepseek-v4-pro-vision-exp', 'deepseek-chat', 'deepseek-reasoner'])('does not invent vision support for %s or silently route elsewhere', model => {
    expect(supportsModelVision(model)).toBe(false);
    expect(selectAgentVisionModel([config(['qwen3.7-plus', model])], model)).toBeNull();
  });
  it('does not replace an unselected or unknown model with another configured model', () => {
    expect(selectAgentVisionModel([config(['qwen3.7-plus'])], '')).toBeNull();
    expect(selectAgentVisionModel([config(['qwen3.7-plus', 'unknown-chat'])], 'unknown-chat')).toBeNull();
  });
  it('uses the agent default model even when it is not repeated in the public model list', () => {
    expect(selectAgentVisionModel([], 'deepseek-flash')).toBe('deepseek-flash');
  });
  it('never selects an image-generation channel as a chat vision model', () => {
    expect(selectAgentVisionModel([config(['deepseek-flash'], 'image')], 'deepseek-flash')).toBeNull();
  });
});
