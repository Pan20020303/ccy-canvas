/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RefineFrame from './RefineFrame';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('RefineFrame staged node animation', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('uses real task stages and keeps video media inside the same frame', async () => {
    await act(async () => {
      root.render(
        <RefineFrame status="queued" labels={{ queued: '排队中' }} mediaKey="movie.mp4">
          <video src="movie.mp4" />
        </RefineFrame>,
      );
    });

    const frame = host.querySelector<HTMLElement>('.refine-frame')!;
    expect(frame.dataset.status).toBe('queued');
    expect(frame.getAttribute('aria-busy')).toBe('true');
    expect(frame.getAttribute('aria-label')).toBe('排队中');
    expect(frame.querySelector('video')?.getAttribute('src')).toBe('movie.mp4');
    expect(frame.querySelector('.refine-frame__lightfield')).toBeTruthy();
    expect(frame.querySelector('.refine-frame__edge-light')).toBeTruthy();

    await act(async () => {
      root.render(
        <RefineFrame status="refining" labels={{ refining: '精修并保存' }} mediaKey="movie.mp4">
          <video src="movie.mp4" />
        </RefineFrame>,
      );
    });
    expect(frame.dataset.status).toBe('refining');
    expect(frame.getAttribute('aria-label')).toBe('精修并保存');
  });

  it('shows the completed state and exposes retry only for failures', async () => {
    const retry = vi.fn();
    await act(async () => {
      root.render(
        <RefineFrame status="error" labels={{ error: '生成失败' }} retryLabel="重试" onRetry={retry}>
          <div />
        </RefineFrame>,
      );
    });
    const retryButton = host.querySelector<HTMLButtonElement>('.refine-frame__retry')!;
    expect(retryButton.textContent).toContain('重试');
    await act(async () => retryButton.click());
    expect(retry).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <RefineFrame status="complete" labels={{ complete: '生成完成' }} hideAfter={0}>
          <div />
        </RefineFrame>,
      );
    });
    const frame = host.querySelector<HTMLElement>('.refine-frame')!;
    expect(frame.dataset.status).toBe('complete');
    expect(frame.hasAttribute('aria-busy')).toBe(false);
    expect(frame.getAttribute('aria-label')).toBe('生成完成');
    expect(host.querySelector('.refine-frame__retry')).toBeNull();
  });
});
