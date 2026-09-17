/* @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LogoutConfirmDialog } from './LogoutConfirmDialog';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function Fixture({ confirm }: { confirm: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  return <LogoutConfirmDialog open={open} onOpenChange={setOpen} onConfirm={confirm} zh />;
}
it('keeps real logout failures visible and allows retry', async () => {
  const confirm = vi.fn().mockRejectedValueOnce(new Error('网络断开，退出未完成')).mockResolvedValueOnce(undefined);
  await act(async () => root.render(<Fixture confirm={confirm} />));
  await act(async () => document.querySelector<HTMLButtonElement>('.logout-confirm-submit')!.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('网络断开');
  expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
  await act(async () => document.querySelector<HTMLButtonElement>('.logout-confirm-submit')!.click());
  expect(confirm).toHaveBeenCalledTimes(2); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});
it('prevents duplicate logout and dismissal until the request finishes', async () => {
  let resolve!: () => void;
  const confirm = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  await act(async () => root.render(<Fixture confirm={confirm} />));
  await act(async () => { const button = document.querySelector<HTMLButtonElement>('.logout-confirm-submit')!; button.click(); button.click(); });
  expect(confirm).toHaveBeenCalledOnce();
  expect(Array.from(document.querySelectorAll<HTMLButtonElement>('.logout-confirm button')).every(b => b.disabled)).toBe(true);
  await act(async () => document.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
  await act(async () => resolve()); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});
