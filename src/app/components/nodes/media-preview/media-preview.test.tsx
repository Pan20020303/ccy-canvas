/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import { useStore } from '../../../store';
import { bindCanvasPreferences, useCanvasPreferences } from '../../../canvas-preferences';
import { MediaPreviewModal } from './MediaPreviewModal';
import { fitImageZoom, formatMediaBytes, formatMediaTime, neighboringMediaIds, nodePreviewItem, previewDownloadName, videoErrorMessage } from './media-preview-model';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../../../reference-media', async () => ({ ...await vi.importActual('../../../reference-media'), toRenderableMediaUrl: (src: string) => src }));
const originalState = useStore.getState();
const makeNode = (id: string, type = 'imageNode', data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data: { url: `/media/${id}.${type.includes('Video') || type === 'videoNode' ? 'mp4' : 'png'}`, customTitle: id, ...data } });
let root: Root;
let host: HTMLDivElement;
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
const close = vi.fn();
const download = vi.fn<() => Promise<void>>();
const focus = vi.fn();
const fixtures: Node[] = [makeNode('角色参考', 'referenceImageNode', { mediaWidth: 1000, mediaHeight: 1500, prompt: '角色设定', fileSize: 609280 }), { ...makeNode('镜头视频', 'referenceVideoNode'), position: { x: 340, y: 0 } }, { ...makeNode('场景图片'), position: { x: 680, y: 0 } }];
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label)!;
async function click(label: string) { const target = button(label); expect(target, label).toBeTruthy(); await act(async () => target.click()); }
async function key(value: string, target: HTMLElement = dialog()) { await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))); }
async function render(id = '角色参考') {
  const node = fixtures.find(item => item.id === id)!;
  await act(async () => root.render(<MediaPreviewModal kind={node.type === 'referenceVideoNode' ? 'video' : 'image'} src={String(node.data.url)} nodeId={id} onClose={close} onDownload={download} />));
}
async function change(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  expect(element, label).toBeTruthy();
  const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
}
async function loadImage(width = 1000, height = 1500) {
  const img = document.querySelector<HTMLImageElement>('.media-preview-original')!;
  Object.defineProperties(img, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } });
  await act(async () => img.dispatchEvent(new Event('load')));
  return img;
}
async function loadVideo(width = 864, height = 496) {
  const video = document.querySelector<HTMLVideoElement>('.media-preview-video')!;
  Object.defineProperties(video, { videoWidth: { value: width, configurable: true }, videoHeight: { value: height, configurable: true }, duration: { value: 4, configurable: true } });
  await act(async () => { video.dispatchEvent(new Event('loadedmetadata')); video.dispatchEvent(new Event('canplay')); });
  return video;
}
beforeEach(() => {
  bindCanvasPreferences('preview-test');
  vi.clearAllMocks(); download.mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  play = vi.fn().mockImplementation(function(this: HTMLVideoElement) { Object.defineProperty(this, 'paused', { value: false, configurable: true }); this.dispatchEvent(new Event('play')); return Promise.resolve(); });
  pause = vi.fn().mockImplementation(function(this: HTMLVideoElement) { Object.defineProperty(this, 'paused', { value: true, configurable: true }); this.dispatchEvent(new Event('pause')); });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
  useStore.setState({ ...originalState, nodes: fixtures, language: 'zh', requestCanvasFocus: focus });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useStore.setState(originalState); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('media neighborhood and formatting', () => {
  it('uses only real image and video nodes, excluding uploads, empty and hidden media', () => {
    const nodes = [...fixtures, makeNode('文本', 'textNode'), makeNode('全景', 'panoramaNode'), makeNode('空白', 'imageNode', { url: '' }), makeNode('上传中', 'imageNode', { status: 'uploading' }), { ...makeNode('隐藏'), hidden: true }];
    expect(neighboringMediaIds(nodes, '角色参考')).toEqual(['角色参考', '镜头视频', '场景图片']);
  });
  it('keeps the source even when more than nine nodes share its position', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => makeNode(String(index)));
    const ids = neighboringMediaIds(nodes, '19');
    expect(ids).toHaveLength(9); expect(ids).toContain('19');
    expect(neighboringMediaIds(nodes)).toEqual([]);
  });
  it('fits natural pixels including portrait rotation without inventing resolution', () => {
    expect(fitImageZoom({ width: 1000, height: 2000 }, { width: 800, height: 800 })).toBe(.4);
    expect(fitImageZoom({ width: 1000, height: 2000 }, { width: 1600, height: 800 }, 90)).toBe(.8);
    expect(nodePreviewItem(makeNode('无尺寸'))?.width).toBeUndefined();
  });
  it('formats actual file bytes, time and safe filenames', () => {
    expect(formatMediaBytes(609280)).toBe('595 KB'); expect(formatMediaBytes()).toBe(''); expect(formatMediaBytes(Infinity)).toBe('');
    expect(formatMediaTime(61.25, true)).toBe('01:01.25'); expect(formatMediaTime(Infinity)).toBe('00:00');
    expect(previewDownloadName({ id: '1', title: '角色/参考', kind: 'image', src: 'https://example.test/a.webp?sign=test' })).toBe('角色-参考.webp');
  });
});

describe('image and shared preview controls', () => {
  it('respects disabled linked preview and keeps only the clicked real node', async () => {
    useCanvasPreferences.setState(state => ({ values: { ...state.values, linkedPreview: false } }));
    await render(); expect(document.querySelectorAll('.media-preview-thumbnail')).toHaveLength(1);
    expect(document.querySelector('.media-preview-navigation')?.textContent).toContain('1 / 1');
  });
  it('shows the reference tool layout with actual neighboring thumbnails', async () => {
    await render(); expect(dialog()).toBeTruthy(); expect(document.activeElement).toBe(dialog());
    expect(document.querySelectorAll('.media-preview-thumbnail')).toHaveLength(3);
    expect(document.querySelector('.media-preview-navigation')?.textContent).toContain('相邻节点 1 / 3');
    expect(button('放大')).toBeTruthy(); expect(button('顺时针旋转')).toBeTruthy(); expect(button('素材信息')).toBeTruthy();
  });
  it('fits, zooms, rotates and resets without modifying canvas nodes', async () => {
    const before = useStore.getState().nodes; await render(); const img = await loadImage();
    const fitted = img.style.transform; await click('放大'); expect(img.style.transform).not.toBe(fitted);
    await click('适应窗口'); expect(img.style.transform).toBe(fitted);
    await click('顺时针旋转'); expect(img.style.transform).toContain('rotate(90deg)');
    await click('逆时针旋转'); expect(img.style.transform).toContain('rotate(0deg)');
    await change('图片缩放', '2'); expect(img.style.transform).toContain('scale(2)');
    await key('0'); expect(img.style.transform).toBe(fitted); expect(useStore.getState().nodes).toBe(before);
  });
  it('uses pointer dragging and wheel zoom only inside the viewer', async () => {
    await render(); const img = await loadImage(); const stage = document.querySelector<HTMLElement>('.media-preview-image-stage')!;
    stage.setPointerCapture = vi.fn();
    const pointer = (type: string, x: number, y: number) => { const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }); Object.defineProperty(event, 'pointerId', { value: 1 }); stage.dispatchEvent(event); };
    await act(async () => pointer('pointerdown', 10, 10)); await act(async () => pointer('pointermove', 40, 60)); await act(async () => pointer('pointerup', 40, 60));
    expect(img.style.transform).toContain('translate(30px, 50px)');
    const before = img.style.transform; await act(async () => stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })));
    expect(img.style.transform).not.toBe(before);
  });
  it('switches image/video with thumbnails, arrows and keyboard and locates the current node', async () => {
    await render(); await click('下一个节点'); expect(document.querySelector('.media-preview-video')).toBeTruthy();
    await key('ArrowRight'); expect(dialog().textContent).toContain('场景图片');
    await click('上一个节点'); expect(document.querySelector('.media-preview-video')).toBeTruthy();
    await click('定位到节点'); expect(close).toHaveBeenCalled(); expect(focus).toHaveBeenCalledWith('镜头视频');
  });
  it('downloads the selected original instead of its thumbnail', async () => {
    await render(); await click('场景图片'); await click('下载原文件');
    expect(download).toHaveBeenCalledWith('/media/场景图片.png', '场景图片.png');
  });
  it('shows real image load failures and supports reloading', async () => {
    await render(); const first = document.querySelector('.media-preview-original');
    await act(async () => first?.dispatchEvent(new Event('error')));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('图片加载失败');
    await click('重新加载'); expect(document.querySelector('.media-preview-original')).not.toBe(first); expect(dialog().querySelector('[role="alert"]')).toBeNull();
  });
  it('displays real dimensions and does not fabricate missing file size', async () => {
    await render(); await loadImage(800, 1200); await click('素材信息');
    expect(document.querySelector('.media-preview-info')?.textContent).toContain('800 × 1200'); expect(document.querySelector('.media-preview-info')?.textContent).toContain('595 KB');
    await click('场景图片'); expect(document.querySelector('.media-preview-info')?.textContent).toContain('未提供'); expect(document.querySelector('.media-preview-info')?.textContent).not.toContain('800 × 1200');
  });
  it('prevents canvas shortcuts and closes with Escape', async () => {
    await render(); const leaked = vi.fn(); window.addEventListener('keydown', leaked);
    await key('Delete'); await key('Backspace'); await key('z'); expect(leaked).not.toHaveBeenCalled();
    await key('Escape'); expect(close).toHaveBeenCalled(); window.removeEventListener('keydown', leaked);
  });
  it('removes deleted neighbors and refreshes regenerated URLs without stale focus', async () => {
    await render(); await click('场景图片');
    await act(async () => useStore.setState({ nodes: fixtures.filter(node => node.id !== '场景图片') }));
    expect(document.querySelectorAll('.media-preview-thumbnail')).toHaveLength(2);
    await act(async () => useStore.setState({ nodes: [{ ...fixtures[0], data: { ...fixtures[0].data, url: '/new-result.webp' } }] }));
    expect(document.querySelector('.media-preview-original')?.getAttribute('src')).toBe('/new-result.webp');
    await act(async () => useStore.setState({ nodes: [] })); expect(button('定位到节点')).toBeUndefined(); expect(dialog().textContent).toContain('已移除');
  });
  it('reports download failure instead of pretending the file was saved', async () => {
    download.mockRejectedValueOnce(new Error('offline')); await render(); await click('下载原文件');
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('下载失败'); expect(button('下载原文件').disabled).toBe(false);
  });
});

describe('actual video playback controls', () => {
  it('uses real metadata and supports play, pause, seek, skip and rates', async () => {
    await render('镜头视频'); const video = await loadVideo();
    expect(document.querySelector('.media-preview-file-info')?.textContent).toContain('864 × 496');
    expect(dialog().textContent).toContain('496p'); expect(dialog().textContent).toContain('00:04');
    await click('暂停'); expect(pause).toHaveBeenCalled(); await click('播放'); expect(play).toHaveBeenCalled();
    await change('视频进度', '2.25'); expect(video.currentTime).toBe(2.25);
    await click('前进 1 秒'); expect(video.currentTime).toBe(3.25); await click('后退 1 秒'); expect(video.currentTime).toBe(2.25);
    await change('播放倍速', '1.5'); expect(video.playbackRate).toBe(1.5);
  });
  it('retains the seek control and actual seeking for a 9:16 video', async () => {
    await render('镜头视频'); const video = await loadVideo(720, 1280);
    const frame = document.querySelector<HTMLElement>('.media-preview-video-frame')!;
    expect(frame.style.aspectRatio).toBe('720 / 1280');
    expect(document.querySelector<HTMLInputElement>('[aria-label="视频进度"]')!.disabled).toBe(false);
    await change('视频进度', '2.75'); expect(video.currentTime).toBe(2.75);
    expect(document.querySelector('.media-preview-time')?.textContent).toContain('02.75');
  });
  it('persists volume, rate and loop between video/image switches and stops old playback', async () => {
    await render('镜头视频'); const video = await loadVideo(); await change('音量', '.4'); await click('循环播放');
    expect(video.volume).toBe(.4); expect(video.loop).toBe(true); await click('静音'); expect(video.muted).toBe(true); await click('取消静音'); expect(video.volume).toBe(.4);
    await click('场景图片'); expect(pause).toHaveBeenCalled(); await click('镜头视频'); const next = await loadVideo(); expect(next.volume).toBe(.4); expect(next.loop).toBe(true);
  });
  it('does not switch nodes when arrow keys operate a seek slider', async () => {
    await render('镜头视频'); await loadVideo(); const seek = document.querySelector<HTMLInputElement>('[aria-label="视频进度"]')!;
    await key('ArrowRight', seek); expect(document.querySelector('.media-preview-video')).toBeTruthy();
    await key(' '); expect(pause).toHaveBeenCalled(); await key('m'); expect(button('取消静音')).toBeTruthy();
  });
  it('shows actual media error categories and disables invalid playback', async () => {
    await render('镜头视频'); const video = await loadVideo(); Object.defineProperty(video, 'error', { value: { code: 3 }, configurable: true });
    await act(async () => video.dispatchEvent(new Event('error')));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('视频解码失败'); expect(button('播放').disabled).toBe(true);
    expect(videoErrorMessage(2)).toContain('网络'); expect(videoErrorMessage(4)).toContain('格式');
  });
  it('offers accurate playback help and real browser fullscreen', async () => {
    await render('镜头视频'); await loadVideo(); await click('播放帮助'); expect(dialog().textContent).toContain('前进 1 秒');
    const frame = document.querySelector<HTMLElement>('.media-preview-video-frame')!; const fullscreen = vi.fn().mockResolvedValue(undefined); frame.requestFullscreen = fullscreen;
    await click('全屏播放'); expect(fullscreen).toHaveBeenCalled();
  });
});
