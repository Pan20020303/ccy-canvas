// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { AgentSettingsPopover } from './AgentSettingsPopover';
import { useAgentPreferences } from './use-agent-preferences';
import { effectiveThinkingEffort, thinkingRequest } from './thinking-effort';

function Harness({ project = 'p1', user = 'u1', model = 'deepseek-flash', running = false, visionModel }: {
  project?: string; user?: string; model?: string; running?: boolean;
  visionModel?: string | null;
}) {
  const { preferences, setManualConfirmation, setModelEffort } = useAgentPreferences(user, project);
  const selected = preferences.efforts[model] ?? null;
  return <>
    <output>{JSON.stringify({ ...thinkingRequest(model, selected), manual_confirmation: preferences.manualConfirmation })}</output>
    <AgentSettingsPopover zh model={model} effort={effectiveThinkingEffort(model, selected)}
      onEffortChange={value => setModelEffort(model, value)} manualConfirmation={preferences.manualConfirmation}
      onManualChange={setManualConfirmation} running={running} listening={false} speechSupported
      onToggleMic={() => {}} runtimeLabel="deepseek-flash" usage={<div>上下文用量 12k</div>} visionModel={visionModel} />
  </>;
}

describe('assistant settings', () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const open = async () => { await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="智能体设置"]')!.click()); };
  const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.agent-settings-popover button')).find(el => el.textContent === label)!;
  const payload = () => JSON.parse(host.querySelector('output')!.textContent!);

  it('keeps extra controls out of the composer and applies settings to request parameters', async () => {
    await act(async () => root.render(<Harness />));
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(document.querySelector('input[type="range"]')).toBeNull();
    await open();
    expect(document.querySelector('.agent-settings-popover')?.textContent).toContain('上下文用量 12k');
    await act(async () => button('最高').click());
    expect(payload()).toEqual({ thinking: true, reasoning_effort: 'max', manual_confirmation: true });
    await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(payload().manual_confirmation).toBe(false);
    expect(document.querySelector('.agent-settings-popover')?.textContent).toContain('会消耗积分');
    await act(async () => button('关闭').click());
    expect(payload()).toEqual({ thinking: false, manual_confirmation: false });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click());
    expect(document.querySelector('[role="switch"]')).toBeNull();
  });

  it('persists per account/canvas/model and does not overwrite on switching or reload', async () => {
    await act(async () => root.render(<Harness />)); await open();
    await act(async () => button('最高').click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await act(async () => root.render(<Harness project="p2" />));
    expect(payload().manual_confirmation).toBe(true);
    expect(payload().reasoning_effort).toBe('high');
    await act(async () => root.render(<Harness user="u2" />));
    expect(payload().manual_confirmation).toBe(true);
    await act(async () => root.render(<Harness />));
    expect(payload()).toEqual({ thinking: true, reasoning_effort: 'max', manual_confirmation: false });
    await act(async () => root.render(<Harness model="gpt-4.1" />));
    expect(payload()).toEqual({ manual_confirmation: false });
    await act(async () => root.render(<Harness />));
    expect(payload().reasoning_effort).toBe('max');
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => root.render(<Harness />));
    expect(payload()).toEqual({ thinking: true, reasoning_effort: 'max', manual_confirmation: false });
  });

  it('locks execution settings during a run and closes with Escape', async () => {
    await act(async () => root.render(<Harness running />)); await open();
    expect(document.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[type="range"]')!.disabled).toBe(true);
    await act(async () => button('最高').click());
    expect(payload().reasoning_effort).toBe('high');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('input[type="range"]')).toBeNull();
  });

  it('explains current-model media capability and never presents metadata reading as seeing images', async () => {
    await act(async () => root.render(<Harness visionModel="deepseek-flash" />)); await open();
    const dialog = document.querySelector('.agent-settings-popover')!;
    expect(dialog.textContent).toContain('使用当前模型看图、抽帧分析视频');
    expect(dialog.textContent).toContain('不包含音频分析');
    await act(async () => root.render(<Harness model="deepseek-v4-pro" visionModel={null} />));
    expect(dialog.textContent).toContain('当前模型不支持');
    expect(dialog.textContent).toContain('不能据此描述画面');
    expect(dialog.textContent).toContain('不会自动换模型');
  });
});
