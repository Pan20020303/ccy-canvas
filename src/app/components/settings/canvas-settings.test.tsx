/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Position, type EdgeProps, type Node } from '@xyflow/react';
import { useStore, bindStorageToUser, flushPendingPersist } from '../../store';
import { bindCanvasPreferences, canvasThemeVariables, DEFAULT_CANVAS_PREFERENCES, normalizeCanvasPreferences, selectedEdgeColor, useCanvasPreferences } from '../../canvas-preferences';
import { shouldNotifyGeneration, requestCanvasNotificationPermission } from '../../canvas-notifications';
import { waitForCanvasSubmit } from '../../canvas-submit-delay';
import { CanvasSettingsPanel } from './CanvasSettingsPanel';
import { CanvasBackground, CanvasGenerationNotifications } from './CanvasPreferencesRuntime';
import { FlowEdge } from '../FlowEdge';

const mocks = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }), generate: vi.fn() }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('../../api/providerConfigs', async () => ({ ...await vi.importActual('../../api/providerConfigs'), generate: mocks.generate }));
vi.mock('../../reference-media', async () => ({ ...await vi.importActual('../../reference-media'), toRenderableMediaUrl: (url: string) => url }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const original = useStore.getState();
const node = (id: string, data: Record<string, unknown> = {}, type = 'imageNode'): Node => ({ id, type, position: { x: 0, y: 0 }, width: 300, height: 200, data });
let host: HTMLDivElement;
let root: Root;
const set = <K extends keyof typeof DEFAULT_CANVAS_PREFERENCES>(key: K, value: typeof DEFAULT_CANVAS_PREFERENCES[K]) => useCanvasPreferences.getState().setPreference(key, value);
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(e => e.getAttribute('aria-label') === label || e.textContent?.trim() === label)!;
async function click(label: string) { expect(button(label), label).toBeTruthy(); await act(async () => button(label).click()); }
async function render(children: React.ReactNode) { await act(async () => root.render(children)); }
async function change(label: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  bindCanvasPreferences('settings-test');
  useStore.setState({ ...original, nodes: [], edges: [], groups: [], backendProjects: [], activeProjectId: 'settings-test-project', activeBackendProjectId: 'settings-test-project', canvasHydrated: true, confirmBeforeGenerate: false, isSettingsOpen: true });
  // No live server/model calls: all tests use isolated in-memory canvas data.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No network in settings tests')));
  mocks.generate.mockResolvedValue({ type: 'text', content: '测试结果' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  flushPendingPersist(); useStore.setState(original); bindCanvasPreferences('');
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('validated, account-scoped settings', () => {
  it('clamps numeric values and rejects invalid booleans, palettes and color injection', () => {
    const values = normalizeCanvasPreferences({ edgeWidth: 999, panSensitivity: -20, gridGap: Infinity, themeId: 'unknown', customEdgeColor: 'red;url(x)', showGrid: 'false', backgroundNodeId: 'x'.repeat(201) });
    expect(values.edgeWidth).toBe(6); expect(values.panSensitivity).toBe(.25);
    expect(values.gridGap).toBe(24); expect(values.showGrid).toBe(true); expect(values.themeId).toBe('graphite');
    expect(values.customEdgeColor).toBe(DEFAULT_CANVAS_PREFERENCES.customEdgeColor); expect(values.backgroundNodeId).toBe('');
    expect(normalizeCanvasPreferences(null)).toEqual(DEFAULT_CANVAS_PREFERENCES);
  });
  it('round-trips each account independently without leaking the previous theme', () => {
    bindCanvasPreferences('alice'); set('edgeWidth', 4); set('themeId', 'wine');
    bindCanvasPreferences('bob'); expect(useCanvasPreferences.getState().values.edgeWidth).toBe(2);
    set('showGrid', false); bindCanvasPreferences('alice'); expect(useCanvasPreferences.getState().values).toMatchObject({ edgeWidth: 4, showGrid: true, themeId: 'wine' });
    bindCanvasPreferences('bob'); expect(useCanvasPreferences.getState().values.showGrid).toBe(false);
  });
  it('migrates existing grid/minimap flags through real user binding', () => {
    localStorage.setItem('cineflow-store-migrate', JSON.stringify({ state: { snapToGrid: true, showMiniMap: true }, version: 1 }));
    bindStorageToUser('migrate');
    expect(useCanvasPreferences.getState().values).toMatchObject({ snapToGrid: true, showMiniMap: true });
    bindStorageToUser('new-account'); expect(useCanvasPreferences.getState().values).toMatchObject({ snapToGrid: false, showMiniMap: false });
  });
  it('keeps current settings live and exposes storage failures for retry', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    set('edgeWidth', 5); expect(useCanvasPreferences.getState()).toMatchObject({ persistenceError: true, values: { edgeWidth: 5 } });
    spy.mockRestore(); useCanvasPreferences.getState().retrySave(); expect(useCanvasPreferences.getState().persistenceError).toBe(false);
  });
  it('uses defaults for corrupt storage, with bidirectional legacy toolbar synchronization', () => {
    localStorage.setItem('ccy-canvas-preferences@bad', '{broken'); bindCanvasPreferences('bad');
    expect(useCanvasPreferences.getState().values).toEqual(DEFAULT_CANVAS_PREFERENCES);
    useStore.getState().setShowMiniMap(true); expect(useCanvasPreferences.getState().values.showMiniMap).toBe(true);
    set('snapToGrid', true); expect(useStore.getState().snapToGrid).toBe(true);
    useCanvasPreferences.getState().restoreDefaults(); expect(useStore.getState().showMiniMap).toBe(false);
  });
  it('derives actual theme variables and custom wire color', () => {
    const values = normalizeCanvasPreferences({ themeId: 'wine', edgeColorId: 'custom', customEdgeColor: '#ff8800' });
    expect(canvasThemeVariables(values)['--canvas-bg']).not.toBe('#111111');
    expect(selectedEdgeColor(values)).toBe('#ff8800');
    expect(canvasThemeVariables(values)['--canvas-simple-text']).not.toBe(canvasThemeVariables(DEFAULT_CANVAS_PREFERENCES)['--canvas-simple-text']);
  });
  it('tints translucent nodes, UI and portaled menus together without changing light defaults', () => {
    const dark = canvasThemeVariables(DEFAULT_CANVAS_PREFERENCES);
    const blue = canvasThemeVariables(normalizeCanvasPreferences({ themeId: 'frost' }));
    const wine = canvasThemeVariables(normalizeCanvasPreferences({ themeId: 'wine' }));
    for (const key of ['--canvas-node-surface', '--canvas-ui-surface', '--canvas-menu-surface'] as const) {
      expect(dark[key]).not.toBe(blue[key]); expect(blue[key]).not.toBe(wine[key]);
      expect(blue[key]).toMatch(/^#[a-f0-9]{8}$/);
    }
    expect(canvasThemeVariables(DEFAULT_CANVAS_PREFERENCES, 'light')['--canvas-bg']).toBe('#e8eaed');
    expect(canvasThemeVariables(normalizeCanvasPreferences({ themeId: 'wine' }), 'light')).toEqual(wine);
  });
});

describe('reference panel controls', () => {
  it('has nine sections, real switches and sliders without changing canvas content', async () => {
    const nodes = [node('real')]; useStore.setState({ nodes });
    await render(<CanvasSettingsPanel onAdvanced={() => {}} />);
    expect(document.querySelectorAll('.canvas-settings-nav button')).toHaveLength(9);
    await click('显示导航小地图'); expect(useStore.getState().showMiniMap).toBe(true);
    await change('网格线间距', '40'); expect(useCanvasPreferences.getState().values.gridGap).toBe(40);
    await click('缩放'); expect(useCanvasPreferences.getState().values.wheelAction).toBe('zoom');
    expect(useStore.getState().nodes).toBe(nodes);
    await click('恢复默认'); expect(useCanvasPreferences.getState().values).toEqual(DEFAULT_CANVAS_PREFERENCES);
  });
  it('expands, opens advanced settings, and closes via the real settings action', async () => {
    const advanced = vi.fn(); await render(<CanvasSettingsPanel onAdvanced={advanced} />);
    await click('展开设置面板'); expect(document.querySelector('.canvas-settings-panel.is-expanded')).toBeTruthy();
    await click('高级设置'); expect(advanced).toHaveBeenCalledOnce();
    await click('关闭画布设置'); expect(useStore.getState().isSettingsOpen).toBe(false);
  });
  it('offers only actual available canvas images, not videos or uploads', async () => {
    useStore.setState({ nodes: [node('背景', { url: '/actual.png', customTitle: '真实背景' }), node('视频', { url: '/v.mp4' }, 'videoNode'), node('上传', { url: '/partial.png', status: 'uploading' }), node('空白')] });
    await render(<CanvasSettingsPanel onAdvanced={() => {}} />);
    await click('从画布选择'); expect(document.querySelectorAll('.canvas-background-picker button')).toHaveLength(1);
    await click('真实背景'); expect(useCanvasPreferences.getState().values).toMatchObject({ backgroundNodeId: '背景', backgroundEnabled: true });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('disables background parameters without a selected image and reports the empty state', async () => {
    await render(<CanvasSettingsPanel onAdvanced={() => {}} />); await click('从画布选择');
    expect(document.querySelector('.canvas-background-picker')?.textContent).toContain('没有可用图片');
    expect(document.querySelector<HTMLInputElement>('[aria-label="不透明度"]')?.disabled).toBe(true);
  });
  it('never claims system permission was granted when the browser denied it', async () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn().mockResolvedValue('denied') });
    await render(<CanvasSettingsPanel onAdvanced={() => {}} />); await click('系统通知（浏览器）');
    expect(useCanvasPreferences.getState().values.systemNotifications).toBe(false);
    expect(document.querySelector('.canvas-settings-note[role="status"]')?.textContent).toContain('未授权');
  });
  it('renders and removes the actual selected background as the source changes', async () => {
    useStore.setState({ nodes: [node('bg', { url: '/real-background.png' })] }); set('backgroundNodeId', 'bg'); set('backgroundEnabled', true); set('backgroundOpacity', 42);
    await render(<CanvasBackground />);
    const background = document.querySelector<HTMLElement>('.canvas-custom-background')!;
    expect(background.style.backgroundImage).toContain('/real-background.png'); expect(background.style.opacity).toBe('0.42');
    await act(async () => useStore.setState({ nodes: [] })); expect(document.querySelector('.canvas-custom-background')).toBeNull();
  });
  it('reports actual background loading failures', async () => {
    useStore.setState({ nodes: [node('bg', { url: '/missing.png' })] }); set('backgroundNodeId', 'bg'); set('backgroundEnabled', true);
    await render(<CanvasBackground />); await act(async () => document.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(host.textContent).toContain('背景图片加载失败'); expect(document.querySelector('.canvas-custom-background')).toBeNull();
  });
});

describe('real layout and edge consumers', () => {
  it('applies horizontal/vertical gaps to measured nodes only when arranged, with undo', () => {
    const nodes = [{ ...node('a'), selected: true, measured: { width: 600, height: 350 } }, { ...node('b'), selected: true, position: { x: 10, y: 0 } }];
    useStore.setState({ nodes }); set('horizontalGap', 200); set('verticalGap', 100);
    expect(useStore.getState().nodes).toBe(nodes);
    useStore.getState().arrangeSelectedNodes('horizontal'); expect(useStore.getState().nodes[1].position.x).toBe(800);
    useStore.getState().arrangeSelectedNodes('vertical'); expect(useStore.getState().nodes[1].position.y).toBe(450);
    useStore.getState().undoCanvas(); expect(useStore.getState().nodes[1].position.x).toBe(800);
  });
  it('uses real widths for connected columns and configurable group padding', () => {
    useStore.setState({ nodes: [{ ...node('wide'), measured: { width: 900, height: 300 } }, node('next')], edges: [{ id: 'e', source: 'wide', target: 'next' }] });
    set('horizontalGap', 240); set('groupPadding', 60); useStore.getState().tidyCanvas();
    expect(useStore.getState().nodes[1].position.x).toBe(1140);
    useStore.getState().createGroup(['wide','next']); expect(useStore.getState().groups.at(-1)?.position?.x).toBe(-60);
  });
  const edge = { id: 'e', source: 'a', target: 'b', sourceX: 0, sourceY: 0, targetX: 500, targetY: 200, sourcePosition: Position.Right, targetPosition: Position.Left } as EdgeProps;
  it('applies stroke, hit width, real running animation and focus filtering', async () => {
    useStore.setState({ nodes: [node('a', { status: 'running' }), node('b')] }); set('edgeWidth', 4); set('edgeHitWidth', 24); set('edgeColorId', 'custom'); set('customEdgeColor', '#ff8800');
    await render(<svg><FlowEdge {...edge} /></svg>);
    expect(document.querySelector<SVGPathElement>('.react-flow__edge-path')?.style.strokeWidth).toBe('4');
    expect(document.querySelector<SVGPathElement>('.react-flow__edge-path')?.style.stroke).toBe('rgb(255, 136, 0)');
    expect(document.querySelector('.react-flow__edge-interaction')?.getAttribute('stroke-width')).toBe('24');
    expect(document.querySelector('animate')).toBeTruthy();
    await act(async () => set('edgeAnimation', false)); expect(document.querySelector('animate')).toBeNull();
    await act(async () => set('onlyFocusedEdges', true)); expect(document.querySelector('path')).toBeNull();
    await act(async () => useStore.setState({ nodes: [{ ...node('a'), selected: true }, node('b')] })); expect(document.querySelector('path')).toBeTruthy();
  });
  it('masks only wires passing behind unrelated groups', async () => {
    useStore.setState({ groups: [{ id: 'g', name: '组', nodeIds: ['c'], position: { x: 100, y: 100 }, width: 200, height: 100 }] });
    await render(<svg><FlowEdge {...edge} /></svg>); expect(document.querySelector('mask rect[fill="black"]')).toBeTruthy();
    await act(async () => set('groupOccludesEdges', false)); expect(document.querySelector('mask')).toBeNull();
  });
});

describe('notifications follow actual run transitions', () => {
  it('combines own-task, away, success and failure switches independently', () => {
    const prefs = { ...DEFAULT_CANVAS_PREFERENCES };
    expect(shouldNotifyGeneration(prefs, { failed: false, own: true, away: true })).toBe(true);
    expect(shouldNotifyGeneration(prefs, { failed: false, own: false, away: true })).toBe(false);
    expect(shouldNotifyGeneration(prefs, { failed: false, own: true, away: false })).toBe(false);
    expect(shouldNotifyGeneration({ ...prefs, notifyCompleted: false }, { failed: true, own: true, away: true })).toBe(true);
  });
  it('does not request browser permissions until explicitly asked', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted'); vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    await render(<CanvasGenerationNotifications />); expect(requestPermission).not.toHaveBeenCalled();
    expect(await requestCanvasNotificationPermission()).toBe(true); expect(requestPermission).toHaveBeenCalledOnce();
  });
  it('does not replay historical results, but emits and deduplicates a real own completion', async () => {
    set('notifyWhen', 'always'); useStore.setState({ nodes: [node('old', { status: 'done' })] });
    await render(<CanvasGenerationNotifications />); expect(mocks.toast.success).not.toHaveBeenCalled();
    const running = node('new', { status: 'running', taskId: 'task-1', generationOwnerId: 'settings-test' });
    await act(async () => useStore.setState({ nodes: [running] }));
    await act(async () => useStore.setState({ nodes: [{ ...running, data: { ...running.data, status: 'done', url: '/done.png' } }] }));
    expect(mocks.toast.success).toHaveBeenCalledOnce();
    await act(async () => useStore.setState({ nodes: [running] }));
    await act(async () => useStore.setState({ nodes: [{ ...running, data: { ...running.data, status: 'done' } }] }));
    expect(mocks.toast.success).toHaveBeenCalledOnce();
  });
  it('ignores optimistic/no-task failures and other people’s runs', async () => {
    set('notifyWhen', 'always'); await render(<CanvasGenerationNotifications />);
    for (const data of [{ status: 'running' }, { status: 'running', taskId: 'other', generationOwnerId: 'someone-else' }]) {
      await act(async () => useStore.setState({ nodes: [node('n', data)] }));
      await act(async () => useStore.setState({ nodes: [node('n', { ...data, status: 'error' })] }));
    }
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
  it('notifies a failed rerun even when the old output remains visible', async () => {
    set('notifyWhen', 'always'); await render(<CanvasGenerationNotifications />);
    const data = { status: 'running', taskId: 'retry', generationOwnerId: 'settings-test', url: '/old.png' };
    await act(async () => useStore.setState({ nodes: [node('n', data)] }));
    await act(async () => useStore.setState({ nodes: [node('n', { ...data, status: 'done', lastGenerationError: '真实上游错误' })] }));
    expect(mocks.toast.error).toHaveBeenCalledOnce(); expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});

describe('cancellable real submission delay', () => {
  it('cancels a grace period without submitting and replaces duplicate pending requests', async () => {
    vi.useFakeTimers(); const first = waitForCanvasSubmit('duplicate', 3); const next = waitForCanvasSubmit('duplicate', 2);
    expect(await first).toBe(false);
    const options = mocks.toast.mock.calls.at(-1)?.[1]; options.action.onClick(); expect(await next).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('does not call the model before confirmation or the configured delay, then stamps the real owner', async () => {
    vi.useFakeTimers(); set('submitDelay', 2);
    useStore.setState({ nodes: [node('submit', { generationParams: {} })], confirmBeforeGenerate: true });
    await useStore.getState().runNode('submit', { prompt: 'test', model: 'test-model' });
    await vi.advanceTimersByTimeAsync(3000); expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
    const result = useStore.getState().runNode('submit', { prompt: 'test', model: 'test-model', skipConfirm: true });
    await vi.advanceTimersByTimeAsync(1000); expect(mocks.generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await result; expect(mocks.generate).toHaveBeenCalledOnce();
    expect(useStore.getState().nodes[0].data).toHaveProperty('generationOwnerId');
  });
  it('abandons delayed submission after switching projects', async () => {
    vi.useFakeTimers(); set('submitDelay', 3); useStore.setState({ nodes: [node('submit')] });
    const result = useStore.getState().runNode('submit', { prompt: 'test', model: 'test-model' });
    useStore.setState({ activeBackendProjectId: 'another-project' });
    await vi.advanceTimersByTimeAsync(3000); await result; expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('abandons delayed submission if the generation parameters were edited', async () => {
    vi.useFakeTimers(); set('submitDelay', 2); useStore.setState({ nodes: [node('submit')] });
    const result = useStore.getState().runNode('submit', { prompt: 'test', model: 'test-model' });
    useStore.getState().updateNodeData('submit', { generationParams: { aspectRatio: '16:9' } });
    await vi.advanceTimersByTimeAsync(2000); await result; expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.toast.info).toHaveBeenCalledOnce();
  });
});
