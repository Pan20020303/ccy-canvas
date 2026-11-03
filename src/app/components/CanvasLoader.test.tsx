// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ state: {} as any, flow: {} as any, queue: vi.fn(), updateNodeData: vi.fn(), listener: undefined as any }));
vi.mock('../store', () => ({ useStore: Object.assign((selector: any) => selector(mocks.state), { getState: () => mocks.state }) }));
vi.mock('@xyflow/react', () => {
  const api = { getState: () => mocks.flow, subscribe: (callback: any) => { mocks.listener = callback; return () => { mocks.listener = undefined; }; } };
  return { useStoreApi: () => api };
});
vi.mock('../canvas-media-preload', async importOriginal => ({ ...(await importOriginal<object>()), runImagePreloadQueue: mocks.queue }));
import { CanvasLoader } from './CanvasLoader';
import { mediaDimCache } from '../media-dims';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  mocks.updateNodeData.mockReset(); mocks.queue.mockReset(); mocks.listener = undefined;
  mocks.queue.mockImplementation(() => new Promise(() => {}));
  mocks.state = {
    activeBackendProjectId: 'project-a', activeProjectId: 'project-a', activeSpaceId: 'personal', backendSyncing: false,
    nodes: [{ id: 'image', type: 'imageNode', position: { x: 10, y: 10 }, data: { url: 'https://example.com/full.png' } }],
    updateNodeData: mocks.updateNodeData,
  };
  mocks.flow = { transform: [0, 0, 1], width: 1000, height: 600, nodeLookup: new Map() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  if (root) act(() => root!.unmount()); root = undefined;
  document.body.replaceChildren(); mediaDimCache.clear(); vi.useRealTimers();
});
async function render() { await act(async () => { root!.render(<CanvasLoader />); }); }
async function frames() { await act(async () => { await vi.advanceTimersByTimeAsync(32); }); }

it('reveals the hydrated canvas without waiting for optional media requests', async () => {
  await render(); await frames();
  expect(mocks.queue).toHaveBeenCalledOnce();
  expect((host.querySelector('[role="status"]') as HTMLElement).style.pointerEvents).toBe('none');
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('waits for snapshot hydration before choosing media, without freezing input', async () => {
  mocks.state.backendSyncing = true; await render(); await frames();
  expect(mocks.queue).not.toHaveBeenCalled();
  expect((host.querySelector('[role="status"]') as HTMLElement).style.pointerEvents).toBe('none');
  mocks.state.backendSyncing = false; await render(); await frames();
  expect(mocks.queue).toHaveBeenCalledOnce();
});

it('aborts the old project and never applies its delayed dimensions to a new project with the same node id', async () => {
  await render(); await frames();
  const [targets, options] = mocks.queue.mock.calls[0];
  mocks.state = { ...mocks.state, activeBackendProjectId: 'project-b' };
  await render();
  expect(options.signal.aborted).toBe(true);
  options.onLoaded(targets[0], { width: 4000, height: 2000 });
  expect(mocks.updateNodeData).not.toHaveBeenCalled();
});

it('persists measured original image dimensions but refuses a changed source or an existing size', async () => {
  await render(); await frames();
  const [targets, options] = mocks.queue.mock.calls[0];
  expect(targets[0].requestUrl).not.toContain('&w=');
  options.onLoaded(targets[0], { width: 4000, height: 2000 });
  expect(mocks.updateNodeData).toHaveBeenCalledWith('image', { mediaWidth: 4000, mediaHeight: 2000 });
  mocks.updateNodeData.mockClear();
  mocks.state.nodes[0].data = { url: '/replacement.png' };
  options.onLoaded(targets[0], { width: 4000, height: 2000 });
  expect(mocks.updateNodeData).not.toHaveBeenCalled();
  mocks.state.nodes[0].data = { url: targets[0].sourceUrl, mediaWidth: 1920, mediaHeight: 1080 };
  options.onLoaded(targets[0], { width: 4000, height: 2000 });
  expect(mocks.updateNodeData).not.toHaveBeenCalled();
});

it('never overwrites original dimensions with a preview or video poster size', async () => {
  mocks.state.nodes[0].data = { url: '/clip.mp4', poster: '/poster.png' };
  mocks.state.nodes[0].type = 'videoNode';
  await render(); await frames();
  const [targets, options] = mocks.queue.mock.calls[0];
  options.onLoaded(targets[0], { width: 720, height: 405 });
  expect(mocks.updateNodeData).not.toHaveBeenCalled();
  expect(mediaDimCache.has('/clip.mp4')).toBe(false);
});

it('cancels stale warming when the viewport moves or the component unmounts', async () => {
  await render(); await frames();
  const [, options] = mocks.queue.mock.calls[0];
  mocks.listener({ ...mocks.flow, transform: [500, 0, 1] }, mocks.flow);
  expect(options.signal.aborted).toBe(true);
  act(() => root!.unmount()); root = undefined;
  expect(mocks.listener).toBeUndefined();
});
