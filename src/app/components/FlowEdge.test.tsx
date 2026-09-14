// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import type { EdgeProps, Node } from '@xyflow/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlowEdge } from './FlowEdge';

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
  expect(document.querySelector('animate')).toBeNull();
  patch('s', { data: { status: 'running' } });
  expect(document.querySelector('animate')).not.toBeNull();
  patch('s', { data: { status: 'done' }, selected: true });
  expect(document.querySelector('animate')).toBeNull();
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgba(255, 255, 255, 0.38)');
  act(() => harness.store.setState({ theme: 'light' }));
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgba(0, 0, 0, 0.45)');
  patch('s', { selected: false });
  patch('t', { selected: true });
  expect(document.getElementById('e-base')?.style.stroke).toBe('rgba(0, 0, 0, 0.45)');
});

it('keeps the selected-edge delete action and undo capture', () => {
  mount(true);
  act(() => (document.querySelector('button[title="删除连线"]') as HTMLButtonElement).click());
  expect(harness.store.getState().pushUndoSnapshot).toHaveBeenCalledTimes(1);
  expect(harness.store.getState().onEdgesChange).toHaveBeenCalledWith([{ type: 'remove', id: 'e' }]);
});
