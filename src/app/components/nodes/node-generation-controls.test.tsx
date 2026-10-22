/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dropdown, durationTicks, MediaParamsPopover } from './NodeGenerationControls';
import { getModelTemplate, type ModelTemplate } from '../../model-templates';
import { useStore } from '../../store';
import { DEFAULT_CANVAS_PREFERENCES, useCanvasPreferences, canvasThemeVariables } from '../../canvas-preferences';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const original = useStore.getState();
const prefs = useCanvasPreferences.getState();
const callbacks = { onResolution: vi.fn(), onQuality: vi.fn(), onAspectRatio: vi.fn(), onDuration: vi.fn(), onOutputFormat: vi.fn(), onAudioSetting: vi.fn() };
const button = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)!;
async function click(name: string) { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()); }
async function renderParams(template = getModelTemplate('doubao-seedance-2-5-260628')!) {
  await act(async () => root.render(<MediaParamsPopover template={template} resolution="720p" quality="" duration={5} aspectRatio="16:9" outputFormat="mp4" audioSetting="on" {...callbacks} />));
  await click('生成参数');
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useStore.setState({ language: 'zh', theme: 'dark' });
  useCanvasPreferences.setState({ values: { ...DEFAULT_CANVAS_PREFERENCES } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useStore.setState(original); useCanvasPreferences.setState(prefs); vi.unstubAllGlobals(); });
describe('node generation controls', () => {
  it('uses official resolutions, formats, ratios and real callbacks', async () => {
    await renderParams();
    await click('1080p'); expect(callbacks.onResolution).toHaveBeenCalledWith('1080p');
    await click('9:16'); expect(callbacks.onAspectRatio).toHaveBeenCalledWith('9:16');
    await click('MOV'); expect(callbacks.onOutputFormat).toHaveBeenCalledWith('mov');
    await click('生成音效'); expect(callbacks.onAudioSetting).toHaveBeenCalledWith('off');
    const slider = document.querySelector<HTMLInputElement>('[aria-label="时长"]')!;
    expect([slider.min, slider.max, slider.step]).toEqual(['4','30','1']);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '15'); slider.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(callbacks.onDuration).toHaveBeenCalledWith(15);
    expect(button('720p').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.node-params-menu')?.textContent).not.toContain('码率');
  });
  it('does not fabricate parameters absent from the model schema', async () => {
    const template = { ...getModelTemplate('doubao-seedance-2-5-260628')!, supportsDuration: false, supportsResolution: false, supportsOutputFormat: false, supportsAspectRatio: false, audioSettingOptions: [] } satisfies ModelTemplate;
    await renderParams(template);
    expect(document.querySelector('[aria-label="时长"]')).toBeNull();
    expect(button('1080p')).toBeUndefined(); expect(button('MOV')).toBeUndefined(); expect(button('9:16')).toBeUndefined();
  });
  it('propagates live canvas colours across the portal and closes with Escape', async () => {
    await renderParams();
    expect(host.querySelector('.node-params-menu')).toBeNull();
    await act(async () => useCanvasPreferences.setState({ values: { ...DEFAULT_CANVAS_PREFERENCES, themeId: 'wine' } }));
    const panel = document.querySelector<HTMLElement>('.node-params-menu')!;
    expect(panel.style.getPropertyValue('--canvas-menu-surface')).toBe(canvasThemeVariables(useCanvasPreferences.getState().values)['--canvas-menu-surface']);
    await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('.node-params-menu')).toBeNull();
  });
  it('supports a keyboard-driven model menu', async () => {
    const change = vi.fn();
    await act(async () => root.render(<Dropdown value="Model A" options={['Model A', 'Model B']} onChange={change} />));
    await act(async () => button('Model A').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(items).toHaveLength(2);
    await act(async () => items[1].click());
    expect(change).toHaveBeenCalledWith('Model B'); expect(document.querySelector('.node-model-menu')).toBeNull();
  });
  it('keeps range labels bounded for different model ranges', () => {
    expect(durationTicks(4,30,1)).toEqual([4,8,12,16,20,24,28,30]);
    expect(durationTicks(5,10,5)).toEqual([5,10]);
    expect(durationTicks(5,5,1)).toEqual([5]);
    expect(durationTicks(.5,2,.5)).toEqual([.5,1,1.5,2]);
  });
});
