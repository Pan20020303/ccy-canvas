// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageResultGallery, type ImageResultGalleryMode } from './ImageResultGallery';
import { nodeTypes } from './CustomNodes';
import { buildDownloadZip, saveDownloadBlob } from '../../batch-download';
import { useStore } from '../../store';
import { bindCanvasPreferences } from '../../canvas-preferences';
import { mediaDimCache } from '../../media-dims';

vi.mock('../../batch-download', () => ({ buildDownloadZip: vi.fn(), saveDownloadBlob: vi.fn() }));
vi.mock('../../reference-media', async () => ({ ...await vi.importActual('../../reference-media'), toRenderableMediaUrl: (src: string) => src }));

const images = ['/result/one.webp', '/result/two.webp', '/result/three.webp', '/result/four.webp'];
// Use the same registered component as the production canvas, including its
// editable title, history badge and annotation controls.
const CanvasImageNode = nodeTypes.imageNode;
const initialState = useStore.getState();
let host: HTMLDivElement, root: Root;
const close = vi.fn(), addAll = vi.fn(), setPrimary = vi.fn();
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)!;
async function click(label: string) { const target = button(label); expect(target, label).toBeTruthy(); await act(async () => target.click()); }

function Fixture({ readOnly = false, initialMode = 'panel' }: { readOnly?: boolean; initialMode?: ImageResultGalleryMode }) {
  const [primary, setMain] = useState(images[0]);
  const [mode, setMode] = useState<ImageResultGalleryMode>(initialMode);
  return <ImageResultGallery images={images} primaryUrl={primary} zh mode={mode} readOnly={readOnly}
    onClose={close} onExpand={() => setMode('fullscreen')} onAddAll={addAll}
    onSetPrimary={url => { setPrimary(url); setMain(url); }} />;
}

beforeEach(() => {
  mediaDimCache.clear();
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  bindCanvasPreferences('image-result-gallery-test');
  useStore.setState({ ...initialState, language: 'zh', nodes: [], activeBackendProjectId: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useStore.setState(initialState); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('image results gallery', () => {
  it('uses each loaded image aspect ratio in the panel, fullscreen grid and filmstrip', async () => {
    await act(async () => root.render(<Fixture />));
    const dimensions = [[2100, 900], [900, 1600], [1000, 1000], [1600, 900]];
    const loaded = [...document.querySelectorAll<HTMLImageElement>('.image-result-tile img')];
    await act(async () => loaded.forEach((img, index) => {
      Object.defineProperties(img, { naturalWidth: { value: dimensions[index][0] }, naturalHeight: { value: dimensions[index][1] } });
      img.dispatchEvent(new Event('load'));
    }));
    const assertRatios = () => [...document.querySelectorAll<HTMLElement>('.image-result-tile')].forEach((tile, index) => {
      expect(Number.parseFloat(tile.style.aspectRatio)).toBeCloseTo(dimensions[index][0] / dimensions[index][1]);
    });
    assertRatios();
    await click('放大图片组'); assertRatios();
    await click('单图视图');
    expect(button('查看图片 1').style.width).toBe('140px');
    expect(button('查看图片 2').style.width).toBe('33.75px');
  });
  it('opens a two-column group with a primary image, menu actions and real ZIP download inputs', async () => {
    vi.mocked(buildDownloadZip).mockResolvedValueOnce({ blob: new Blob(['zip']), succeeded: 4, failed: [] });
    await act(async () => root.render(<Fixture />));
    expect(host.querySelector('[role="dialog"]')).toBeNull(); // Portalled outside the clipped node.
    expect(document.querySelector('.image-result-header')?.textContent).toContain('历史记录 4');
    expect(document.querySelectorAll('.image-result-tile')).toHaveLength(4);
    expect(document.querySelector('.image-result-tile[aria-current="true"]')?.getAttribute('aria-label')).toBe('图片 1，主图');
    await click('更多图片操作'); await click('全部添加到画布');
    expect(addAll).toHaveBeenCalledOnce(); expect(document.querySelector('[role="menu"]')).toBeNull();
    await click('更多图片操作'); await click('下载全部');
    expect(vi.mocked(buildDownloadZip).mock.calls[0][0].map(item => item.url)).toEqual(images);
    expect(saveDownloadBlob).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-label="批量下载任务"]')?.textContent).toContain('成功 4 项');
  });

  it('updates the main image, expands and navigates a single-image view with the keyboard', async () => {
    await act(async () => root.render(<Fixture />));
    await click('图片 2'); expect(setPrimary).toHaveBeenLastCalledWith(images[1]);
    expect(button('图片 2，主图')).toBeTruthy();
    await click('放大图片组');
    expect(document.querySelector('[aria-label="图片全屏浏览"]')).toBeTruthy();
    await click('单图视图');
    expect(document.querySelector('.image-result-single-image > img')?.getAttribute('src')).toBe(images[1]);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.querySelector('.image-result-single-image > img')?.getAttribute('src')).toBe(images[2]);
    await click('设为主图'); expect(setPrimary).toHaveBeenLastCalledWith(images[2]);
    await click('网格视图'); expect(document.querySelectorAll('.image-result-tile')).toHaveLength(4);
    await click('关闭图片浏览'); expect(close).toHaveBeenCalledOnce();
  });

  it('expands on double-click and dismisses menus before the dialog with Escape', async () => {
    await act(async () => root.render(<Fixture />));
    await click('更多图片操作');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull(); expect(close).not.toHaveBeenCalled();
    await act(async () => button('图片 1，主图').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(document.querySelector('[aria-label="图片全屏浏览"]')).toBeTruthy();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledOnce();
  });

  it('shows load failure and prevents a failed image becoming primary', async () => {
    await act(async () => root.render(<Fixture />));
    const tile = button('图片 2');
    await act(async () => tile.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(tile.textContent).toContain('图片加载失败');
    await click('图片 2'); expect(setPrimary).not.toHaveBeenCalled();
    expect(tile.querySelector('.image-result-set-main')).toBeNull();
  });

  it('keeps shared read-only galleries browsable without canvas mutations', async () => {
    await act(async () => root.render(<Fixture readOnly initialMode="fullscreen" />));
    expect(button('全部添加到画布')).toBeUndefined();
    await click('图片 2'); expect(setPrimary).not.toHaveBeenCalled();
    expect(document.querySelector('.image-result-set-main')).toBeNull();
    expect(button('下载全部')).toBeTruthy();
  });
});

describe('generated image node entry points', () => {
  it('uses the same gallery for ordinary models with only legacy image versions', async () => {
    const node = { id: 'legacy-image', type: 'imageNode', position: { x: 0, y: 0 }, selected: true,
      data: { url: images[0], status: 'done', model: 'gpt-image-2', activeVersionTimestamp: 20,
        versions: [{ id: 'older', url: images[1], model: 'seedream', timestamp: 10 }] } };
    useStore.setState({ nodes: [node] });
    function LiveNode() {
      const current = useStore(state => state.nodes.find(value => value.id === node.id)!);
      return <ReactFlowProvider><CanvasImageNode id={current.id} data={current.data} selected /></ReactFlowProvider>;
    }
    await act(async () => root.render(<LiveNode />));
    expect(document.querySelectorAll('.image-result-count')).toHaveLength(1);
    await click('查看 2 张图片');
    expect(document.querySelector('[aria-label="图片历史记录"]')).toBeTruthy();
    await click('图片 2');
    expect(useStore.getState().nodes[0].data.url).toBe(images[1]);
    expect(document.querySelectorAll('.image-result-tile')).toHaveLength(2);
    expect(button('图片 2，主图')).toBeTruthy();
    await click('放大图片组');
    await click('全部添加到画布');
    expect(useStore.getState().nodes.slice(1).map(copy => copy.data.url)).toEqual(images.slice(0, 2));
    await click('全部添加到画布');
    expect(useStore.getState().nodes).toHaveLength(3);
    await click('关闭图片浏览');
    await act(async () => host.querySelector('[data-image-result-surface]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(document.querySelector('[aria-label="图片全屏浏览"]')).toBeTruthy();
  });
  it('routes count, double-click and toolbar fullscreen to the group gallery', async () => {
    const node = { id: 'group-image', type: 'imageNode', position: { x: 0, y: 0 }, selected: true,
      data: { url: images[0], imageResults: images, imageResultTaskId: 'batch', status: 'done', customTitle: '测试图片' } };
    useStore.setState({ nodes: [node] });
    await act(async () => root.render(<ReactFlowProvider><CanvasImageNode id={node.id} data={node.data} selected /></ReactFlowProvider>));
    expect(button('查看 4 张图片').textContent).toContain('4 张');
    await click('查看 4 张图片');
    expect(document.querySelector('[aria-label="图片历史记录"]')).toBeTruthy();
    await click('放大图片组'); await click('关闭图片浏览');
    await act(async () => host.querySelector('[data-image-result-surface]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(document.querySelector('[aria-label="图片全屏浏览"]')).toBeTruthy();
    await click('关闭图片浏览');
    const fullscreen = host.querySelector<HTMLButtonElement>('button[title="全屏"]');
    expect(fullscreen).toBeTruthy();
    await act(async () => fullscreen!.click());
    expect(document.querySelector('[aria-label="图片全屏浏览"]')).toBeTruthy();
    expect(document.querySelector('.media-preview-dialog')).toBeNull();
  });
});
