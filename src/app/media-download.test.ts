// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadMediaFile } from './media-download';

describe('downloadMediaFile', () => {
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
    vi.useRealTimers();
  });

  it('reports byte progress and saves the original file', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    }));
    const progress = vi.fn();
    await downloadMediaFile('/uploads/image.png', 'image.png', progress);
    expect(progress).toHaveBeenCalledWith({ loaded: 3, total: 3, attempt: 1 });
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });

  it('retries an interrupted response instead of saving a partial file', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), {
        headers: { 'content-type': 'video/mp4', 'content-length': '3' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'video/mp4', 'content-length': '3' },
      }));
    const saving = downloadMediaFile('/uploads/video.mp4', 'video.mp4');
    await vi.runAllTimersAsync();
    await saving;
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });

  it('does not retry a missing original file', async () => {
    globalThis.fetch = vi.fn(async () => new Response('missing', { status: 404 }));
    await expect(downloadMediaFile('/uploads/missing.mp4', 'missing.mp4')).rejects.toThrow('原文件已不存在');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});
