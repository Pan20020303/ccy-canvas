/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { VideoUpscaleModal } from './VideoUpscaleModal';
import { VISIONULAR_UPSCALE_TIERS, visionularUpscaleProvider } from '../../video-upscale';
import type { AppProviderConfig } from '../../api/providerConfigs';

vi.mock('../../reference-media', () => ({ toRenderableMediaUrl: (url: string) => url }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const submit = vi.fn();
const models = VISIONULAR_UPSCALE_TIERS.map(tier => tier.model);
async function render(availableModels: string[] = models, busy = false) {
  await act(async () => root.render(<VideoUpscaleModal sourceUrl="https://example.com/source.mp4" zh busy={busy} availableModels={availableModels} onSubmit={submit} onClose={() => {}} />));
}
function button(text: string) { return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.includes(text) || item.getAttribute('aria-label') === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
beforeEach(() => { submit.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('video upscale engines and tiers', () => {
  it.each(['1080p', '1440p', '2160p'] as const)('submits exactly the chosen %s cloud tier', async resolution => {
    await render();
    expect(button('Visionular · 云端').getAttribute('aria-pressed')).toBe('true');
    await click(resolution);
    await click('开始超分');
    expect(submit).toHaveBeenCalledExactlyOnceWith({ engine: 'visionular', resolution });
  });
  it('retains the local SeedVR2 scale and quality controls', async () => {
    await render(); await click('SeedVR2 · 本地'); await click('3×'); await click('HIGH'); await click('开始超分');
    expect(submit).toHaveBeenCalledExactlyOnceWith({ engine: 'seedvr2', scale: 3, quality: 'HIGH' });
  });
  it('does not submit cloud jobs when no channel is configured', async () => {
    await render([]); await click('Visionular · 云端');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('云端渠道未启用');
    expect(button('开始超分').disabled).toBe(true);
    await click('开始超分'); expect(submit).not.toHaveBeenCalled();
    await click('SeedVR2 · 本地'); expect(button('开始超分').disabled).toBe(false);
  });
  it('disables unavailable tiers and starts with the first available one', async () => {
    await render(['visionular-genopt-1440p']);
    expect(button('1080p').disabled).toBe(true);
    expect(button('2160p').disabled).toBe(true);
    expect(button('1440p').getAttribute('aria-pressed')).toBe('true');
    await click('开始超分'); expect(submit).toHaveBeenCalledWith({ engine: 'visionular', resolution: '1440p' });
  });
  it('prevents duplicate submit while busy', async () => {
    await render(models, true); await click('开始超分'); expect(submit).not.toHaveBeenCalled();
  });
  it('only offers tiers from enabled video channel projections, including hidden utility models', () => {
    const pc = { id: 'channel', vendor: 'Visionular', service_type: 'video', model_list: models } as AppProviderConfig;
    expect(visionularUpscaleProvider([pc], models[0])).toBe(pc);
    expect(visionularUpscaleProvider([{ ...pc, service_type: 'image' }], models[0])).toBeUndefined();
    expect(visionularUpscaleProvider([{ ...pc, vendor: 'Other' }], models[0])).toBeUndefined();
  });
});
