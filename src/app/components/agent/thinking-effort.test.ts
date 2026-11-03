import { describe, expect, it } from 'vitest';
import { effectiveThinkingEffort, thinkingEfforts, thinkingRequest } from './thinking-effort';
import { shouldAutomaticallyGenerate } from './generation-batch';

describe('agent execution controls', () => {
  it('sends distinct, supported DeepSeek effort values', () => {
    expect(thinkingEfforts('deepseek-flash')).toEqual(['off', 'low', 'high', 'max']);
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(thinkingRequest('deepseek-flash', effort)).toEqual({thinking:true, reasoning_effort:effort});
    }
    expect(thinkingRequest('deepseek-flash', 'off')).toEqual({thinking:false});
  });
  it('does not fake depth levels for on/off or unsupported models', () => {
    expect(thinkingEfforts('qwen3.7-plus')).toEqual(['off', 'high']);
    expect(thinkingRequest('qwen3.7-plus', 'high')).toEqual({thinking:true});
    expect(effectiveThinkingEffort('qwen3.7-plus', 'max')).toBe('off');
    expect(thinkingRequest('gpt-4.1', 'max')).toEqual({});
  });
  it('defaults to manual and requires explicit per-run opt-in on both sides', () => {
    expect(shouldAutomaticallyGenerate(true, true)).toBe(false);
    expect(shouldAutomaticallyGenerate(true, false)).toBe(false);
    expect(shouldAutomaticallyGenerate(false, undefined)).toBe(false);
    expect(shouldAutomaticallyGenerate(false, true)).toBe(false);
    expect(shouldAutomaticallyGenerate(false, false)).toBe(true);
  });
});
