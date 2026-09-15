// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider, type Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MediaPreview from './MediaPreview';
import { MediaPreviewModal } from './nodes/media-preview/MediaPreviewModal';
import { nodeTypes } from './nodes/CustomNodes';
import { useStore } from '../store';
import { bindCanvasPreferences } from '../canvas-preferences';

vi.mock('../reference-media', async () => ({ ...await vi.importActual('../reference-media'), toRenderableMediaUrl: (src: string) => src }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalState = useStore.getState();
const types = ['imageNode', 'videoNode', 'referenceImageNode', 'referenceVideoNode'] as const;
const fixtures: Node[] = types.map((type, i) => ({ id: type, type, position: { x: i * 360, y: 0 }, data: { url: `/test/${type}.${type.toLowerCase().includes('video') ? 'webm' : 'webp'}`, customTitle: type, sourceName: type, mediaWidth: 640, mediaHeight: 480, status: 'done' }, selected: false }));
let root: Root, host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let saves: string[];
const close = vi.fn();
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label)!;
const click = async (label: string) => { const target = button(label); expect(target, label).toBeTruthy(); await act(async () => target.click()); };
beforeEach(() => {
  bindCanvasPreferences('preview-entry-test');
  vi.clearAllMocks(); saves = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { saves.push(this.download); });
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL() { return 'blob:test-download'; } static revokeObjectURL() {} });
  fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['media']) });
  vi.stubGlobal('fetch', fetchMock);
  useStore.setState({ ...originalState, nodes: fixtures, language: 'zh' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useStore.setState(originalState); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function openNode(type: typeof types[number]) {
  const node = fixtures.find(item => item.type === type)!;
  const Component = nodeTypes[type] as ComponentType<any>;
  await act(async () => root.render(<ReactFlowProvider>{createElement(Component, { id: node.id, data: node.data, selected: false })}</ReactFlowProvider>));
  // Videos intentionally mount only a poster before entering the viewport.
  // Double-click the actual node preview surface, just like the user does.
  const surface = host.querySelector('.cursor-zoom-in');
  expect(surface, `actual ${type} preview surface`).toBeTruthy();
  await act(async () => surface!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(document.querySelector('.media-preview-dialog')).toBeTruthy());
}
describe('production canvas preview wiring', () => {
  it('exports the new viewer through the public entry used by the node lazy import', () => {
    expect(MediaPreview).toBe(MediaPreviewModal);
  });
  it.each(types)('double-clicking registered %s opens the new viewer and its current node', async type => {
    await openNode(type);
    expect(document.querySelector('.media-preview-navigation')?.textContent).toContain('相邻节点');
    expect(document.querySelectorAll('.media-preview-thumbnail')).toHaveLength(4);
    expect(document.querySelector('.media-preview-thumbnail[aria-current="true"]')?.getAttribute('aria-label')).toBe(type);
    expect(document.querySelector(type.toLowerCase().includes('video') ? '.media-preview-video' : '.media-preview-original')).toBeTruthy();
    expect(document.querySelector('.yarl__root')).toBeNull();
    await click('关闭预览'); expect(document.querySelector('.media-preview-dialog')).toBeNull();
  });
  it('downloads the actual switched file through the production callback, preserving extension', async () => {
    await openNode('referenceImageNode'); await click('referenceVideoNode');
    await click('下载原文件');
    expect(fetchMock).toHaveBeenCalledWith('/test/referenceVideoNode.webm', { credentials: 'include' });
    expect(saves).toEqual(['referenceVideoNode.webm']);
  });
  it('surfaces production download failures in the new viewer without saving an error page', async () => {
    await openNode('referenceImageNode'); fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await click('下载原文件');
    expect(document.querySelector('.media-preview-download-error')?.textContent).toContain('下载失败');
    expect(saves).toHaveLength(0);
  });
  it('routes actions to the previewed selected node and hides actions for other/read-only nodes', async () => {
    const action = vi.fn();
    useStore.setState({ nodes: fixtures.map(node => ({ ...node, selected: node.id === 'imageNode' })) });
    await act(async () => root.render(<MediaPreview kind="image" src="/test/imageNode.webp" nodeId="imageNode" onClose={close} onDownload={async () => {}} onNodeAction={action} />));
    await click('编辑图片'); expect(action).toHaveBeenCalledWith('imageNode', 'edit');
    await click('videoNode'); expect(button('裁剪视频')).toBeUndefined();
    await act(async () => useStore.setState({ nodes: fixtures.map(node => ({ ...node, selected: node.id === 'videoNode' })) }));
    await click('裁剪视频'); expect(action).toHaveBeenLastCalledWith('videoNode', 'edit');
    await click('超分'); expect(action).toHaveBeenLastCalledWith('videoNode', 'upscale');
    await act(async () => useStore.setState({ activeBackendProjectId: 'read-only', backendProjects: [{ id: 'read-only', my_role: 'visitor' }] as never }));
    expect(button('裁剪视频')).toBeUndefined(); expect(button('超分')).toBeUndefined();
  });
});
