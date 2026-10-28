// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import type { EdgeProps, Node } from '@xyflow/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlowEdge } from './FlowEdge';
import { DEFAULT_CANVAS_PREFERENCES, useCanvasPreferences } from '../canvas-preferences';

const harness = vi.hoisted(() => ({ store: null as any, render: vi.fn() }));
vi.mock('../store', async () => {
  const { useStore } = await import('zustand');
  const hook = (selector: any) => useStore(harness.store, selector);
  return { useStore: Object.assign(hook, { getState: () => harness.store.getState() }) };
});
vi.mock('@xyflow/react', () => ({
  getBezierPath: (...args: unknown[]) => { harness.render(...args); return ['M0 0 L100 0', 50, 0]; },
  BaseEdge: ({ id, path, style }: any) => <path id={id} d={path} style={style} />,
  EdgeLabelRenderer: ({ children }: any) => <foreignObject>{children}</foreignObject>,
}));

let root: Root;
const node = (id: string): Node => ({ id, position: { x: 0, y: 0 }, data: { status: 'idle' } });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useCanvasPreferences.setState({ values: { ...DEFAULT_CANVAS_PREFERENCES } });
  harness.store = createStore(() => ({ nodes: [node('s'), node('t'), node('other')], theme: 'dark',
    pushUndoSnapshot: vi.fn(), onEdgesChange: vi.fn() }));
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  harness.render.mockClear();
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

const props = { id: 'e', source: 's', target: 't', sourceX: 0, sourceY: 0, targetX: 100, targetY: 0,
  sourcePosition: 'right', targetPosition: 'left', selected: false } as EdgeProps;
const mount = (selected = false) => act(() => root.render(<svg><FlowEdge {...props} selected={selected} /></svg>));
const patch = (id: string, value: Partial<Node>) => act(() => harness.store.setState((s: { nodes: Node[] }) =>
  ({ nodes: s.nodes.map(n => n.id === id ? { ...n, ...value } : n) })));

it('does not rerender for unrelated node changes while preserving live endpoint appearance', () => {
  mount();
  const before = harness.render.mock.calls.length;
  patch('other', { position: { x: 30, y: 20 }, data: { status: 'running' } });
  expect(harness.render).toHaveBeenCalledTimes(before);
  expect(document.querySelector('.canvas-flow-edge-motion')).toBeNull();
  patch('s', { data: { status: 'running' } });
  expect(document.querySelector('.canvas-flow-edge-motion')).not.toBeNull();
  patch('s', { data: { status: 'done' }, selected: true });
  expect(document.querySelector('.canvas-flow-edge-motion')).not.toBeNull();
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgb(56, 189, 248)');
  act(() => harness.store.setState({ theme: 'light' }));
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgb(2, 132, 199)');
  patch('s', { selected: false });
  patch('t', { selected: true });
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgb(2, 132, 199)');
});

it('highlights incoming and outgoing wires without lighting unrelated connections', () => {
  act(() => root.render(<svg>
    <FlowEdge {...props} id="incoming" source="other" target="s" />
    <FlowEdge {...props} id="outgoing" source="s" target="t" />
    <FlowEdge {...props} id="unrelated" source="t" target="other" />
  </svg>));
  patch('s', { selected: true });
  expect(document.getElementById('incoming-base')?.style.stroke).toBe('rgb(56, 189, 248)');
  expect(document.getElementById('outgoing-base')?.style.stroke).toBe('rgb(56, 189, 248)');
  expect(document.getElementById('unrelated-base')?.style.stroke).toBe('rgba(255, 255, 255, 0.38)');
  expect(document.querySelectorAll('.canvas-flow-edge-motion')).toHaveLength(2);
  patch('s', { selected: false });
  expect(document.querySelectorAll('.canvas-flow-edge-motion')).toHaveLength(0);
  expect(document.querySelectorAll('.canvas-flow-edge-glow')).toHaveLength(0);
});

it('can disable selection effects and animation independently without changing the graph', () => {
  mount(); patch('s', { selected: true });
  const nodes = harness.store.getState().nodes;
  act(() => useCanvasPreferences.getState().setPreference('edgeAnimation', false));
  expect(document.querySelector('.canvas-flow-edge-motion')).toBeNull();
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgb(56, 189, 248)');
  act(() => useCanvasPreferences.getState().setPreference('edgeSelectionHighlight', false));
  expect(document.querySelector('.canvas-flow-edge-glow')).toBeNull();
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgba(255, 255, 255, 0.38)');
  expect(harness.store.getState().nodes).toBe(nodes);
  act(() => useCanvasPreferences.getState().setPreference('edgeAnimation', true));
  expect(document.querySelector('.canvas-flow-edge-motion')).toBeNull();
  patch('t', { data: { status: 'running' } });
  expect(document.querySelector('.canvas-flow-edge-motion')).not.toBeNull();
});

it('keeps stripe motion left-to-right even when the edge source is on the right', () => {
  patch('s', { selected: true }); mount();
  expect(document.querySelector<SVGElement>('.canvas-flow-edge-motion')?.style.getPropertyValue('--edge-flow-offset')).toBe('-48px');
  act(() => root.render(<svg><FlowEdge {...props} sourceX={100} targetX={0} /></svg>));
  expect(document.querySelector<SVGElement>('.canvas-flow-edge-motion')?.style.getPropertyValue('--edge-flow-offset')).toBe('48px');
});

it('preserves a custom edge color when selection emphasis is enabled', () => {
  act(() => {
    useCanvasPreferences.getState().setPreference('edgeColorId', 'custom');
    useCanvasPreferences.getState().setPreference('customEdgeColor', '#ff8800');
  });
  mount(); patch('s', { selected: true });
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgb(255, 136, 0)');
});

it('keeps the selected-edge delete action and undo capture', () => {
  mount(true);
  act(() => (document.querySelector('button[title="删除连线"]') as HTMLButtonElement).click());
  expect(harness.store.getState().pushUndoSnapshot).toHaveBeenCalledTimes(1);
  expect(harness.store.getState().onEdgesChange).toHaveBeenCalledWith([{ type: 'remove', id: 'e' }]);
});
