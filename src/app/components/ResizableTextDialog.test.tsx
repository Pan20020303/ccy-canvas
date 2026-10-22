// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ResizableTextDialog } from './ResizableTextDialog';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
let root: Root;
let host: HTMLDivElement;
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 1600); vi.stubGlobal('innerHeight', 1000);
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  const close = vi.fn();
  act(() => root.render(<ResizableTextDialog title="Script" language="zh" onClose={close}><textarea defaultValue="Draft" /></ResizableTextDialog>));
  return close;
}
function rect() {
  const style = (host.querySelector('[role="dialog"]') as HTMLElement).style;
  return { left: parseFloat(style.left), top: parseFloat(style.top), width: parseFloat(style.width), height: parseFloat(style.height) };
}
function pointer(el: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => el.dispatchEvent(event));
}
function drag(edge: string, dx: number, dy: number) {
  const el = host.querySelector(`[data-resize-edge="${edge}"]`) as HTMLElement;
  el.setPointerCapture = vi.fn(); el.hasPointerCapture = () => true; el.releasePointerCapture = vi.fn();
  pointer(el, 'pointerdown', 500, 500); pointer(el, 'pointermove', 500+dx, 500+dy); pointer(el, 'pointerup', 500+dx, 500+dy);
  return el;
}
afterEach(() => { if (root) act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it.each(['n','s','e','w','ne','nw','se','sw'])('resizes %s while preserving the opposite edge and editor', edge => {
  const close = mount(), before = rect();
  const editor = host.querySelector('textarea')!;
  const el = drag(edge, edge.includes('w') ? -40 : 40, edge.includes('n') ? -35 : 35);
  const after = rect();
  expect(after.width).toBeCloseTo(before.width + (/[ew]/.test(edge) ? 40 : 0));
  expect(after.height).toBeCloseTo(before.height + (/[ns]/.test(edge) ? 35 : 0));
  if (edge.includes('w')) expect(after.left + after.width).toBe(before.left + before.width);
  else expect(after.left).toBe(before.left);
  if (edge.includes('n')) expect(after.top + after.height).toBe(before.top + before.height);
  else expect(after.top).toBe(before.top);
  act(() => el.click()); expect(close).not.toHaveBeenCalled();
  expect(host.querySelector('textarea')).toBe(editor); expect(editor.value).toBe('Draft');
});

it('clamps minimum size and keeps the dialog inside a smaller viewport', () => {
  mount(); drag('se', -2000, -2000);
  expect(rect().width).toBe(560); expect(rect().height).toBe(300);
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 280);
  act(() => window.dispatchEvent(new Event('resize')));
  expect(rect()).toEqual({ left: 12, top: 12, width: 366, height: 256 });
  drag('nw', -4000, -4000);
  expect(rect()).toEqual({ left: 12, top: 12, width: 366, height: 256 });
});

it('stops resizing after pointer cancellation', () => {
  mount(); const el = drag('e', 20, 0);
  pointer(el, 'pointerdown', 500, 500); pointer(el, 'pointercancel', 500, 500);
  const before = rect(); pointer(el, 'pointermove', 800, 800); expect(rect()).toEqual(before);
});
