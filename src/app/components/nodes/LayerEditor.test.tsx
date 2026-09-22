/* @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeProps } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerEditorNode, type LayerEditorData } from './LayerEditorNode';
import { LayerEditorOverlay } from './LayerEditorOverlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ state: {} as any, upload: vi.fn(), update: vi.fn(), close: vi.fn(), open: vi.fn() }));
vi.mock('../../store', () => ({ useStore: (selector: (s: any) => unknown) => selector(mocks.state) }));
vi.mock('../../api/projects', () => ({ uploadFile: mocks.upload }));
vi.mock('../../reference-media', () => ({ toRenderableMediaUrl: (url: string) => url }));
vi.mock('@xyflow/react', () => ({ Handle: ({ children }: { children?: ReactNode }) => <div>{children}</div>, Position: { Left: 'left', Right: 'right' } }));
vi.mock('../Magnet', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const layer = { id: 'layer', image: '/source.png', xPct: 0.5, yPct: 0.5, wPct: 0.5, aspect: 2 };
const nodeProps: NodeProps = { id: 'editor', data: {}, type: 'layerEditorNode', selected: false, dragging: false, draggable: true, selectable: true, deletable: true, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 };
type CanvasRecord = { canvas: HTMLCanvasElement; options?: CanvasRenderingContext2DSettings; clearRect: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn>; fillStyle: string };

describe('layer editor transparent PNG and borderless preview', () => {
  let host: HTMLDivElement, root: Root, canvases: CanvasRecord[], downloads: HTMLAnchorElement[];
  const render = async (data: LayerEditorData = {}) => {
    mocks.state.nodes[0].data = { layers: [layer], ratio: '16:9', boardSize: { width: 800, height: 450 }, transparent: true, ...data };
    await act(async () => root.render(<LayerEditorOverlay />));
  };
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(b => b.title === label || b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
  };
  const chooseGridImage = async () => {
    await click('宫格拼接');
    await click('选择这一格的图片');
    const imageButton = [...document.querySelectorAll('button')].find(b => !b.hasAttribute('data-layer-row') && b.querySelector('img')?.getAttribute('src') === '/source.png');
    expect(imageButton).toBeTruthy();
    await act(async () => imageButton!.click());
  };
  const pointer = async (target: EventTarget, type: string, x: number, y: number, options: { buttons?: number; pointerId?: number; altKey?: boolean } = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...options });
    Object.defineProperty(event, 'pointerId', { value: options.pointerId ?? 1 });
    await act(async () => { target.dispatchEvent(event); });
  };
  const layerElement = () => document.querySelector<HTMLElement>('[data-layer-id="layer"]')!;
  const selectLayer = async () => {
    vi.spyOn(document.querySelector<HTMLElement>('[data-layer-canvas]')!, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 450, top: 0, left: 0, right: 800, bottom: 450, toJSON: () => ({}) });
    await pointer(layerElement(), 'pointerdown', 400, 225);
    await pointer(window, 'pointerup', 400, 225);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    canvases = []; downloads = [];
    mocks.state = { language: 'zh', layerEditorNodeId: 'editor', closeLayerEditor: mocks.close, updateNodeData: mocks.update, openLayerEditor: mocks.open, nodes: [{ id: 'editor', type: 'layerEditorNode', data: {} }, { id: 'image', type: 'imageNode', data: { url: '/source.png' } }], history: [] };
    mocks.upload.mockResolvedValue({ url: '/uploads/composition.png' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: async () => new Blob(['png'], { type: 'image/png' }) }));
    vi.stubGlobal('Image', class {
      naturalWidth = 200; naturalHeight = 100;
      onload?: () => void; onerror?: () => void;
      private source = '';
      get src() { return this.source; }
      set src(url: string) { this.source = url; queueMicrotask(() => url === '/broken.png' ? this.onerror?.() : this.onload?.()); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, _kind: string, options?: any) {
      const record = { canvas: this, options, clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
      canvases.push(record);
      return record as unknown as CanvasRenderingContext2D;
    } as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(type => {
      expect(type).toBe('image/png');
      return PNG;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this); });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each([false, true])('renders saved PNG without borders, corner clipping, background or fixed ratio (selected=%s)', selected => {
    const html = renderToStaticMarkup(<LayerEditorNode {...nodeProps} data={{ url: '/saved.png' }} selected={selected} />);
    host.innerHTML = html;
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/saved.png');
    expect(img.className).toBe('block h-auto w-full');
    for (let parent = img.parentElement; parent && parent !== host; parent = parent.parentElement) {
      expect(parent.className).not.toMatch(/bg-|rounded-|shadow-|aspect-|overflow-hidden|p[xy]?-/);
    }
  });
  it('supports output-only saved nodes', () => {
    host.innerHTML = renderToStaticMarkup(<LayerEditorNode {...nodeProps} data={{ output: '/output.png' }} />);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/output.png');
  });
  it.each(['16:9', '9:16', '1:1'])('ignores legacy %s export ratio and fits actual image content with alpha', async ratio => {
    const width = 1600, height = 800;
    await render({ ratio }); await click('下载 PNG');
    expect(canvases[0].canvas.width).toBe(width); expect(canvases[0].canvas.height).toBe(height);
    expect(canvases[0].options).toEqual({ alpha: true });
    expect(canvases[0].clearRect).toHaveBeenCalledWith(0, 0, width, height);
    expect(canvases[0].fillRect).not.toHaveBeenCalled();
    expect(canvases[0].drawImage).toHaveBeenCalledTimes(1);
    expect(downloads[0].href).toBe(PNG); expect(downloads[0].download).toMatch(/\.png$/);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('has a full white board without ratio/background controls and never paints the board into export', async () => {
    await render({ bg: '#123456', transparent: false });
    expect(document.querySelector('[data-free-artboard]')).toBeTruthy();
    expect(document.querySelector('[aria-label="图层层级"]')?.className).toContain('bg-white');
    await click('画布图片');
    expect(document.querySelector('[data-asset-panel]')?.className).toContain('bg-white');
    expect(document.querySelector('[aria-label="透明背景"]')).toBeNull(); expect(document.querySelector('input[type="color"]')).toBeNull();
    expect([...document.querySelectorAll('button')].some(b => b.textContent === '16:9')).toBe(false);
    await click('下载 PNG'); expect(canvases[0].fillRect).not.toHaveBeenCalled();
  });
  it('saves the same alpha-enabled PNG and editable background settings back to the node', async () => {
    await render(); await click('保存到节点');
    expect(canvases[0].fillRect).not.toHaveBeenCalled();
    expect(mocks.upload.mock.calls[0][0].type).toBe('image/png');
    expect(mocks.update).toHaveBeenCalledWith('editor', expect.objectContaining({ url: '/uploads/composition.png', output: '/uploads/composition.png', layers: [expect.objectContaining(layer)], editorMode: 'free', boardSize: { width: 800, height: 450 }, transparent: true }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('keeps PNG data locally if upload is unavailable instead of flattening it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.upload.mockRejectedValue(new Error('offline'));
    await render(); await click('保存到节点');
    expect(mocks.update).toHaveBeenCalledWith('editor', expect.objectContaining({ url: PNG, output: PNG, transparent: true }));
  });
  it('leaves grid empty cells and gaps transparent by default, including after final download', async () => {
    await render({ layers: [] }); await chooseGridImage();
    expect(document.querySelector('[aria-label="宫格背景颜色"]')).toBeNull();
    await click('应用到画布'); await click('下载 PNG');
    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) { expect(canvas.options).toEqual({ alpha: true }); expect(canvas.fillRect).not.toHaveBeenCalled(); expect(canvas.drawImage).toHaveBeenCalledTimes(1); }
  });
  it('cannot save an empty board as a misleading blank output', async () => {
    await render({ layers: [] }); await click('保存到节点'); await click('下载 PNG');
    expect(canvases).toHaveLength(0); expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(['下载 PNG', '保存到节点'])('does not silently drop a broken layer during %s', async action => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render({ layers: [layer, { ...layer, id: 'bad', image: '/broken.png' }] }); await click(action);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('失败');
    expect(downloads).toHaveLength(0); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
  });
  it('exposes eight handles and keeps the opposite corner fixed when resizing from the bottom left', async () => {
    await render(); await selectLayer();
    expect(document.querySelectorAll('[data-resize-handle]')).toHaveLength(8);
    await pointer(document.querySelector('[data-resize-handle="sw"]')!, 'pointerdown', 200, 325);
    await pointer(window, 'pointermove', 120, 365);
    await pointer(window, 'pointerup', 120, 365);
    await click('保存到节点');
    const saved = mocks.update.mock.calls[0][1].layers[0];
    expect((saved.xPct + saved.wPct / 2) * 800).toBeCloseTo(600);
    expect((saved.yPct - saved.hPct / 2) * 450).toBeCloseTo(125);
    expect(saved.wPct * 800).toBeCloseTo(480); expect(saved.hPct * 450).toBeCloseTo(240);
  });
  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'resize', 'escape', 'hidden', 'buttons-released'])('stops resizing after %s, even when outside the layer', async end => {
    await render(); await selectLayer();
    await pointer(document.querySelector('[data-resize-handle="e"]')!, 'pointerdown', 600, 225);
    await pointer(window, 'pointermove', 640, 225);
    const before = layerElement().getAttribute('style');
    if (end === 'blur' || end === 'resize') await act(async () => { window.dispatchEvent(new Event(end)); });
    else if (end === 'escape') await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    else if (end === 'hidden') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    }
    else await pointer(window, end === 'buttons-released' ? 'pointermove' : end, 640, 225, { buttons: 0 });
    await pointer(window, 'pointermove', 790, 440);
    expect(layerElement().getAttribute('style')).toBe(before);
    expect(document.querySelector('[data-snap-guide]')).toBeNull();
  });
  it('ignores another pointer while dragging', async () => {
    await render(); await selectLayer();
    await pointer(layerElement(), 'pointerdown', 400, 225);
    const before = layerElement().getAttribute('style');
    await pointer(window, 'pointermove', 600, 350, { pointerId: 2 });
    await pointer(window, 'pointerup', 600, 350, { pointerId: 2 });
    expect(layerElement().getAttribute('style')).toBe(before);
    await pointer(window, 'pointermove', 450, 225);
    expect(layerElement().getAttribute('style')).not.toBe(before);
    await pointer(window, 'pointerup', 450, 225);
  });
  it('shows snap guides and allows temporary Alt bypass', async () => {
    await render({ layers: [layer, { ...layer, id: 'target', xPct: 0.5, yPct: 0.85, wPct: 0.4 }] }); await selectLayer();
    await pointer(layerElement(), 'pointerdown', 400, 225);
    await pointer(window, 'pointermove', 436, 225);
    expect(document.querySelector('[data-snap-guide="x"]')).toBeTruthy();
    const snapped = Number.parseFloat(layerElement().style.left);
    await pointer(window, 'pointermove', 436, 225, { altKey: true });
    expect(Number.parseFloat(layerElement().style.left)).toBeCloseTo(snapped - 4);
    expect(document.querySelector('[data-snap-guide]')).toBeNull();
    await pointer(window, 'pointerup', 205, 225);
  });
  it('saves and exports independently adjusted height without cropping the image', async () => {
    await render(); await selectLayer();
    await pointer(document.querySelector('[data-resize-handle="s"]')!, 'pointerdown', 400, 325);
    await pointer(window, 'pointermove', 400, 375);
    await pointer(window, 'pointerup', 400, 375);
    await click('保存到节点');
    const saved = mocks.update.mock.calls[0][1].layers[0];
    expect(saved.wPct).toBeCloseTo(0.5); expect(saved.hPct).toBeCloseTo(250 / 450);
    expect(canvases[0].drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1600, 1000]);
    expect(layerElement().querySelector('img')?.className).toContain('object-fill');
    const savedData = JSON.parse(JSON.stringify(mocks.update.mock.calls[0][1]));
    await act(async () => root.render(null));
    await render(savedData); await click('下载 PNG');
    expect(canvases[1].drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1600, 1000]);
  });
  it('preserves oversized legacy layers and exports all content beyond the former frame', async () => {
    const large = { ...layer, wPct: 3, xPct: -2 };
    await render({ layers: [large] }); await click('适应内容'); await click('保存到节点');
    expect(mocks.update.mock.calls[0][1].layers[0]).toEqual(large);
    expect(canvases[0].drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1600, 800]);
  });
  it('restores source proportions with Fit canvas and remembers the snapping switch', async () => {
    await render({ layers: [{ ...layer, hPct: 0.9 }] }); await selectLayer();
    await click('还原比例'); await click('磁吸对齐'); await click('保存到节点');
    const saved = mocks.update.mock.calls[0][1];
    expect(saved.snapEnabled).toBe(false);
    expect(saved.layers[0].wPct * 800 / (saved.layers[0].hPct * 450)).toBeCloseTo(2);
    expect(saved.layers[0].wPct).toBe(0.5);
  });

  const overlapLayers = () => ['bottom', 'middle', 'top'].map(id => ({ ...layer, id, image: `/${id}.png` }));
  const previewOrder = () => [...document.querySelectorAll('[data-layer-id]')].map(el => el.getAttribute('data-layer-id'));
  const rowOrder = () => [...document.querySelectorAll('[data-layer-row]')].map(el => el.getAttribute('data-layer-row'));
  const selectRow = async (id: string) => { await act(async () => document.querySelector<HTMLButtonElement>(`[data-layer-row="${id}"]`)!.click()); };
  const actionButton = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

  it('selects completely covered layers from the list without bringing them to the front', async () => {
    await render({ layers: overlapLayers() });
    expect(rowOrder()).toEqual(['top', 'middle', 'bottom']);
    for (const label of ['上移一层', '下移一层', '置顶', '置底']) expect(actionButton(label).disabled).toBe(true);
    await selectRow('bottom');
    expect(document.querySelector('[data-layer-row="bottom"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(previewOrder()).toEqual(['bottom', 'middle', 'top']);
    expect(actionButton('下移一层').disabled).toBe(true);
    expect(actionButton('上移一层').disabled).toBe(false);
    expect(document.querySelectorAll('[data-resize-handle]')).toHaveLength(8);
  });

  it.each([
    ['bottom', '上移一层', ['middle', 'bottom', 'top']],
    ['top', '下移一层', ['bottom', 'top', 'middle']],
    ['bottom', '置顶', ['middle', 'top', 'bottom']],
    ['top', '置底', ['top', 'bottom', 'middle']],
  ] as const)('keeps preview, PNG and saved/reopened order consistent for %s → %s', async (id, action, expected) => {
    await render({ layers: overlapLayers() }); await selectRow(id); await click(action);
    expect(previewOrder()).toEqual(expected);
    expect(rowOrder()).toEqual([...expected].reverse());
    expect(document.querySelector(`[data-layer-row="${id}"]`)?.getAttribute('aria-pressed')).toBe('true');
    await click('保存到节点');
    expect(canvases[0].drawImage.mock.calls.map(call => call[0].src)).toEqual(expected.map(id => `/${id}.png`));
    const savedData = JSON.parse(JSON.stringify(mocks.update.mock.calls[0][1]));
    expect(savedData.layers.map((l: { id: string }) => l.id)).toEqual(expected);
    await act(async () => root.render(null)); await render(savedData);
    expect(previewOrder()).toEqual(expected);
    await click('下载 PNG');
    expect(canvases[1].drawImage.mock.calls.map(call => call[0].src)).toEqual(expected.map(id => `/${id}.png`));
  });

  it('supports keyboard ordering, disables boundary moves and ignores shortcuts in inputs', async () => {
    await render({ layers: overlapLayers() }); await selectRow('bottom');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', key: ']', ctrlKey: true, shiftKey: true, bubbles: true })); });
    expect(previewOrder()).toEqual(['middle', 'top', 'bottom']);
    expect(actionButton('上移一层').disabled).toBe(true); expect(actionButton('置顶').disabled).toBe(true);
    const input = document.createElement('input'); host.append(input);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketLeft', key: '[', ctrlKey: true, bubbles: true })); });
    expect(previewOrder()).toEqual(['middle', 'top', 'bottom']);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketLeft', key: '[', metaKey: true, bubbles: true })); });
    expect(previewOrder()).toEqual(['middle', 'bottom', 'top']);
    await click('置底'); await click('下移一层');
    expect(previewOrder()).toEqual(['bottom', 'middle', 'top']);
    await click('删除选中图层');
    expect(rowOrder()).toEqual(['top', 'middle']);
    expect(actionButton('上移一层').disabled).toBe(true);
  });

  it('ends a drag when selecting a covered layer and does not keep moving either layer', async () => {
    await render({ layers: [layer, ...overlapLayers()] }); await selectLayer();
    await pointer(layerElement(), 'pointerdown', 400, 225); await pointer(window, 'pointermove', 440, 225);
    await selectRow('bottom');
    const before = [...document.querySelectorAll('[data-layer-id]')].map(el => el.getAttribute('style'));
    await pointer(window, 'pointermove', 600, 350);
    expect([...document.querySelectorAll('[data-layer-id]')].map(el => el.getAttribute('style'))).toEqual(before);
  });

  it('locks ordering while saving so the composed image cannot disagree with saved layers', async () => {
    let finishUpload!: (value: { url: string }) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { finishUpload = resolve; }));
    await render({ layers: overlapLayers() }); await selectRow('middle'); await click('保存到节点');
    for (const label of ['上移一层', '下移一层', '置顶', '置底']) expect(actionButton(label).disabled).toBe(true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', key: ']', ctrlKey: true, bubbles: true })); });
    expect(previewOrder()).toEqual(['bottom', 'middle', 'top']);
    await act(async () => { finishUpload({ url: '/saved.png' }); });
    expect(mocks.update.mock.calls[0][1].layers.map((l: { id: string }) => l.id)).toEqual(['bottom', 'middle', 'top']);
  });

  const openCrop = async () => {
    await click('裁切图片');
    const img = document.querySelector<HTMLImageElement>('[data-crop-source] img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 200 }); Object.defineProperty(img, 'naturalHeight', { value: 100 });
    await act(async () => { img.dispatchEvent(new Event('load')); });
  };
  const dragCrop = async (edge: string, dx: number, dy = 0) => {
    await pointer(document.querySelector(`[data-crop-handle="${edge}"]`)!, 'pointerdown', 0, 0);
    await pointer(window, 'pointermove', dx, dy); await pointer(window, 'pointerup', dx, dy);
  };
  const cropSquare = async () => {
    await dragCrop('w', 100); await dragCrop('e', -100);
  };
  it('crops only the selected layer, preserves the original, and exports the same crop after reopening', async () => {
    await render({ layers: [layer, ...overlapLayers()] }); await selectRow('layer'); await openCrop();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-crop-source] img')?.className).toContain('opacity-25');
    expect(document.querySelectorAll('[data-crop-handle]')).toHaveLength(8);
    await cropSquare(); await click('应用裁切');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const preview = layerElement().querySelector('img')!;
    expect(preview.style.width).toBe('200%'); expect(preview.style.left).toBe('-50%');
    await click('保存到节点');
    const saved = JSON.parse(JSON.stringify(mocks.update.mock.calls[0][1]));
    expect(saved.layers[0]).toEqual(expect.objectContaining({ image: '/source.png', aspect: 2, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }));
    expect(saved.layers.slice(1).every((l: any) => l.crop === undefined)).toBe(true);
    expect(canvases[0].drawImage.mock.calls[0].slice(1)).toEqual([50, 0, 100, 100, 400, 0, 800, 800]);
    await act(async () => root.render(null)); await render(saved); await click('下载 PNG');
    expect(canvases[1].drawImage.mock.calls[0].slice(1)).toEqual(canvases[0].drawImage.mock.calls[0].slice(1));
    await selectRow('layer'); await openCrop();
    expect(document.querySelector('[data-crop-source] img')?.getAttribute('src')).toBe('/source.png');
    expect(document.querySelector<HTMLElement>('[data-crop-selection]')?.style.width).toBe('50%');
    await click('恢复完整原图'); await click('应用裁切'); await click('下载 PNG');
    expect(canvases[2].drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 200, 100, 0, 0, 1600, 800]);
  });
  it('cancels crop drafts without changing the layer or leaking Delete/order shortcuts to the editor', async () => {
    await render(); await selectRow('layer'); const before = layerElement().getAttribute('style');
    await openCrop(); await dragCrop('s', 0, -80);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
    expect(layerElement()).toBeTruthy();
    await click('取消裁切');
    expect(layerElement().getAttribute('style')).toBe(before);
    await click('保存到节点'); expect(mocks.update.mock.calls[0][1].layers[0].crop).toBeUndefined();
  });
  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'resize', 'released'])('stops crop dragging after %s', async end => {
    await render(); await selectRow('layer'); await openCrop();
    await pointer(document.querySelector('[data-crop-handle="w"]')!, 'pointerdown', 0, 200);
    await pointer(window, 'pointermove', 80, 200);
    const before = document.querySelector('[data-crop-selection]')!.getAttribute('style');
    if (end === 'blur' || end === 'resize') await act(async () => { window.dispatchEvent(new Event(end)); });
    else await pointer(window, end === 'released' ? 'pointermove' : end, 80, 200, { buttons: 0 });
    await pointer(window, 'pointermove', 600, 200);
    expect(document.querySelector('[data-crop-selection]')!.getAttribute('style')).toBe(before);
    await click('应用裁切'); await click('保存到节点');
    expect(mocks.update.mock.calls[0][1].layers[0].crop.x).toBeCloseTo(0.2);
  });
  it('moves the crop window within the original, ignores other pointers and fits the cropped aspect', async () => {
    await render(); await selectRow('layer'); await openCrop(); await cropSquare();
    await pointer(document.querySelector('[data-crop-selection]')!, 'pointerdown', 400, 200);
    await pointer(window, 'pointermove', 800, 200, { pointerId: 2 });
    expect(document.querySelector<HTMLElement>('[data-crop-selection]')!.style.left).toBe('25%');
    await pointer(window, 'pointermove', 440, 200); await pointer(window, 'pointerup', 440, 200);
    await click('应用裁切'); await click('还原比例'); await click('保存到节点');
    const result = mocks.update.mock.calls[0][1].layers[0];
    expect(result.crop.x).toBeCloseTo(0.35); expect(result.wPct * 800 / (result.hPct * 450)).toBeCloseTo(1);
  });
  it('does not allow applying a crop if the original image fails to load', async () => {
    await render(); await selectRow('layer'); await click('裁切图片');
    const img = document.querySelector('[data-crop-source] img')!;
    await act(async () => { img.dispatchEvent(new Event('error')); });
    const apply = [...document.querySelectorAll('button')].find(b => b.textContent === '应用裁切')!;
    expect(apply.disabled).toBe(true); await click('取消裁切');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(layerElement().querySelector('img')!.getAttribute('src')).toBe('/source.png');
  });

  it('pans and zooms the viewport without changing saved placement, size or exported pixels', async () => {
    await render();
    const board = document.querySelector<HTMLElement>('[data-layer-canvas]')!;
    const original = layerElement().getAttribute('style');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); });
    await pointer(board, 'pointerdown', 20, 20); await pointer(window, 'pointermove', 120, 70); await pointer(window, 'pointerup', 120, 70);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })); });
    expect(layerElement().getAttribute('style')).not.toBe(original);
    const panned = layerElement().getAttribute('style');
    await pointer(window, 'pointermove', 250, 200); expect(layerElement().getAttribute('style')).toBe(panned);
    await act(async () => { board.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, deltaY: -200 })); });
    expect(Number(board.dataset.boardScale)).toBeGreaterThan(1);
    await click('放大画板'); await click('缩小画板');
    await click('保存到节点');
    expect(mocks.update.mock.calls[0][1].layers).toEqual([layer]);
    expect(canvases[0].drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1600, 800]);
  });

  it('only pans while Space is held and treats an ordinary blank drag as a selection marquee', async () => {
    await render();
    const board = document.querySelector<HTMLElement>('[data-layer-canvas]')!;
    const before = layerElement().getAttribute('style');
    await pointer(board, 'pointerdown', 180, 260); await pointer(window, 'pointermove', 650, 410);
    expect(document.querySelector('[data-selection-marquee]')).toBeTruthy();
    await pointer(window, 'pointerup', 650, 410);
    expect(layerElement().getAttribute('style')).toBe(before);
    expect(document.querySelector('[data-layer-row="layer"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); });
    await pointer(layerElement(), 'pointerdown', 400, 225); await pointer(window, 'pointermove', 500, 275);
    expect(layerElement().getAttribute('style')).not.toBe(before);
    await pointer(window, 'pointerup', 500, 275);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })); });
    const after = layerElement().getAttribute('style');
    await pointer(window, 'pointermove', 900, 800); expect(layerElement().getAttribute('style')).toBe(after);
    await click('保存到节点'); expect(mocks.update.mock.calls[0][1].layers).toEqual([layer]);
  });

  it('undoes and redoes layer movement with Ctrl+Z and Ctrl+Shift+Z', async () => {
    await render(); await selectLayer();
    const original = layerElement().getAttribute('style');
    await pointer(layerElement(), 'pointerdown', 400, 225);
    await pointer(window, 'pointermove', 470, 265);
    await pointer(window, 'pointerup', 470, 265);
    const moved = layerElement().getAttribute('style');
    expect(moved).not.toBe(original);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true })); });
    expect(layerElement().getAttribute('style')).toBe(original);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true, bubbles: true })); });
    expect(layerElement().getAttribute('style')).toBe(moved);
  });

  it('drags a canvas asset directly from the white asset panel onto the artboard', async () => {
    await render(); await click('画布图片');
    const asset = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.draggable && button.querySelector('img')?.getAttribute('src') === '/source.png');
    expect(asset).toBeTruthy();
    const values = new Map<string, string>();
    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type) ?? '' };
    const dragStart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer });
    await act(async () => { asset!.dispatchEvent(dragStart); });
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 700, clientY: 500 });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    await act(async () => { document.querySelector('[data-layer-canvas]')!.dispatchEvent(drop); await Promise.resolve(); });
    expect(document.querySelectorAll('[data-layer-id]')).toHaveLength(2);
  });

  it('opens layer ordering from the right-click menu', async () => {
    const top = { ...layer, id: 'top', image: '/top.png', xPct: 0.6 };
    await render({ layers: [layer, top] });
    await act(async () => { layerElement().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 240 })); });
    expect(document.querySelector('[aria-label="图层右键菜单"]')).toBeTruthy();
    await click('置于顶层');
    await click('保存到节点');
    expect(mocks.update.mock.calls[0][1].layers.map((item: { id: string }) => item.id)).toEqual(['top', 'layer']);
  });

  it('keeps crop geometry correct when zoomed and permits Enter and Escape without closing the editor', async () => {
    await render(); await selectRow('layer'); await click('放大画板'); await openCrop();
    await dragCrop('w', 120); await dragCrop('e', -120);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
    expect(document.querySelector('[data-crop-source]')).toBeNull();
    await openCrop(); await dragCrop('s', 0, -80);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(mocks.close).not.toHaveBeenCalled(); await click('保存到节点');
    expect(mocks.update.mock.calls[0][1].layers[0].crop).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(canvases[0].canvas.width).toBe(1600); expect(canvases[0].canvas.height).toBe(1600);
    expect(canvases[0].drawImage.mock.calls[0].slice(1)).toEqual([50, 0, 100, 100, 0, 0, 1600, 1600]);
  });

  it('moves a layer beyond the former canvas boundary without clipping on save', async () => {
    await render(); await selectLayer(); await pointer(layerElement(), 'pointerdown', 400, 225);
    await pointer(window, 'pointermove', -800, 1225); await pointer(window, 'pointerup', -800, 1225);
    await click('保存到节点');
    const saved = mocks.update.mock.calls[0][1].layers[0];
    expect(saved.xPct).toBe(-1); expect(saved.yPct).toBeCloseTo(1225 / 450);
    expect(canvases[0].drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1600, 800]);
  });

  it('does not steal Enter or Space from crop toolbar buttons', async () => {
    await render(); await selectRow('layer'); await openCrop(); await cropSquare();
    const cancel = [...document.querySelectorAll('button')].find(b => b.textContent === '取消裁切')!;
    const key = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { cancel.dispatchEvent(key); });
    expect(key.defaultPrevented).toBe(false); expect(document.querySelector('[data-crop-source]')).toBeTruthy();
    const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    await act(async () => { cancel.dispatchEvent(space); });
    expect(space.defaultPrevented).toBe(false);
    await click('取消裁切'); await click('保存到节点');
    expect(mocks.update.mock.calls[0][1].layers[0].crop).toBeUndefined();
  });
});
