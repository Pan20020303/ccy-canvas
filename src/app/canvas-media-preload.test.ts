import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectImagePreloadTargets, loadPreloadImage, runImagePreloadQueue, type ImagePreloadTarget, type PreloadNode } from './canvas-media-preload';

const viewport = { x: 0, y: 0, zoom: 1, width: 1000, height: 600 };
const node = (id: string, data: Record<string, unknown> = {}, extra: Partial<PreloadNode> = {}): PreloadNode => ({
  id, type: 'imageNode', position: { x: 50, y: 50 }, data: { url: `/${id}.png`, ...data }, ...extra,
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('viewport media prefetch selection', () => {
  it('prioritizes selected nodes, limits unique resources, and leaves offscreen nodes alone', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => node(`visible-${i}`));
    nodes.push(node('hidden', {}, { position: { x: 90000, y: 90000 } }));
    nodes.push(node('selected', {}, { selected: true, position: { x: 90000, y: 90000 } }));
    const targets = collectImagePreloadTargets(nodes, viewport);
    expect(targets).toHaveLength(24);
    expect(targets[0].sourceUrl).toBe('/selected.png');
    expect(targets.some(target => target.sourceUrl === '/hidden.png')).toBe(false);
  });

  it('deduplicates proxy/original aliases across nodes while retaining all metadata owners', () => {
    const url = 'https://example.com/photo.png';
    const targets = collectImagePreloadTargets([
      node('known', { url, mediaWidth: 3840, mediaHeight: 2160 }),
      node('missing', { url: `/api/app/proxy-media?url=${encodeURIComponent(url)}&w=720` }),
    ], viewport);
    expect(targets).toHaveLength(1);
    expect(targets[0].owners).toHaveLength(2);
    expect(targets[0].measureOriginal).toBe(true);
    expect(targets[0].requestUrl).not.toContain('&w=');
  });

  it('uses the preview hint only when original dimensions are already known', () => {
    const [target] = collectImagePreloadTargets([node('known', { url: 'https://example.com/photo.png', mediaWidth: 3840, mediaHeight: 2160 })], viewport);
    expect(target.requestUrl).toContain('&w=720');
    expect(target.measureOriginal).toBe(false);
  });

  it('never feeds raw audio/video/PDF into Image, but permits a video image poster', () => {
    const targets = collectImagePreloadTargets([
      node('video', { url: '/clip.mp4', poster: '/poster.png' }, { type: 'videoNode' }),
      node('opaque-video', { url: '/download/123' }, { type: 'referenceVideoNode' }),
      node('audio', { url: '/voice.wav' }, { type: 'audioNode' }),
      node('mistyped', { url: '/clip.webm' }),
      node('mime-video', { url: '/download/456', mimeType: 'video/mp4' }),
      node('data-audio', { url: 'data:audio/wav;base64,AA' }),
      node('pdf', { url: '/doc.pdf' }),
      node('bad-poster', { url: '/video.mp4', poster: '/video.mp4' }, { type: 'videoNode' }),
    ], viewport);
    expect(targets.map(target => target.sourceUrl)).toEqual(['/poster.png']);
    expect(targets[0].measureOriginal).toBe(false);
  });

  it('resolves nested-node position and viewport transform before choosing candidates', () => {
    const targets = collectImagePreloadTargets([
      node('group', {}, { type: 'group', position: { x: 5000, y: 0 } }),
      node('child', {}, { parentId: 'group', position: { x: 20, y: 20 } }),
      node('origin'),
    ], { ...viewport, x: -5000 });
    expect(targets.map(target => target.sourceUrl)).toEqual(['/child.png']);
  });

  it('does not launch a global queue before viewport geometry is initialized', () => {
    expect(collectImagePreloadTargets([node('one'), node('two')], { ...viewport, width: 0, height: 0 })).toEqual([]);
  });
});

const targets = (count: number): ImagePreloadTarget[] => Array.from({ length: count }, (_, i) => ({ sourceUrl: `/${i}.png`, requestUrl: `/${i}.png`, measureOriginal: true, owners: [] }));

describe('bounded cancellable image queue', () => {
  it('starts at most three requests and advances only when one settles', async () => {
    const releases: (() => void)[] = [];
    let inflight = 0, peak = 0;
    const load = vi.fn(() => new Promise<{ width: number; height: number }>(resolve => {
      inflight++; peak = Math.max(peak, inflight);
      releases.push(() => { inflight--; resolve({ width: 1920, height: 1080 }); });
    }));
    const onLoaded = vi.fn();
    const work = runImagePreloadQueue(targets(8), { signal: new AbortController().signal, load, onLoaded });
    expect(load).toHaveBeenCalledTimes(3);
    while (releases.length) { releases.shift()!(); await Promise.resolve(); }
    await work;
    expect(peak).toBe(3); expect(load).toHaveBeenCalledTimes(8); expect(onLoaded).toHaveBeenCalledTimes(8);
  });

  it('does not start queued resources or report dimensions after cancellation', async () => {
    const controller = new AbortController();
    const releases: ((value: { width: number; height: number }) => void)[] = [];
    const load = vi.fn(() => new Promise<{ width: number; height: number }>(resolve => releases.push(resolve)));
    const onLoaded = vi.fn();
    const work = runImagePreloadQueue(targets(20), { signal: controller.signal, load, onLoaded });
    controller.abort(); releases.forEach(release => release({ width: 100, height: 100 }));
    await work;
    expect(load).toHaveBeenCalledTimes(3); expect(onLoaded).not.toHaveBeenCalled();
  });

  it('continues past a failed request without dropping later resources', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ width: 300, height: 200 });
    const onLoaded = vi.fn();
    await runImagePreloadQueue(targets(4), { signal: new AbortController().signal, load, onLoaded, concurrency: 1 });
    expect(load).toHaveBeenCalledTimes(4); expect(onLoaded).toHaveBeenCalledTimes(3);
  });

  it('aborts actual image handlers and times out stalled image requests', async () => {
    vi.useFakeTimers();
    const created: { onload: (() => void) | null; onerror: (() => void) | null; removeAttribute: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('Image', class {
      onload = null; onerror = null; src = ''; decoding = '';
      naturalWidth = 200; naturalHeight = 100;
      removeAttribute = vi.fn();
      constructor() { created.push(this); }
    });
    const controller = new AbortController();
    const aborted = loadPreloadImage('/abort.png', controller.signal);
    controller.abort();
    expect(await aborted).toBeNull();
    expect(created[0].onload).toBeNull(); expect(created[0].removeAttribute).toHaveBeenCalledWith('src');
    const timed = loadPreloadImage('/stall.png', new AbortController().signal, 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await timed).toBeNull(); expect(created[1].onerror).toBeNull();
  });
});
