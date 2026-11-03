/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginDevices } from './LoginDevices';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn(), success: vi.fn() }));
vi.mock('../../api/devices', () => ({ listLoginDevices: mocks.list, revokeLoginDevice: mocks.revoke }));
vi.mock('sonner', () => ({ toast: { success: mocks.success } }));

const current = { id: 'current', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', ip_address: '127.0.0.1', created_at: '2026-09-23T08:00:00Z', last_seen_at: '2026-09-23T08:00:00Z', expires_at: '2026-09-30T08:00:00Z', current: true };
const other = { ...current, id: 'other', user_agent: 'Mozilla/5.0 (iPhone) Safari/17.0', current: false };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ devices: [current, other], password_available: true });
  mocks.revoke.mockResolvedValue({ ok: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('lists the current device and requires a password before removing another', async () => {
  await act(async () => { root.render(<LoginDevices zh />); await Promise.resolve(); });
  expect(host.textContent).toContain('Windows · Chrome');
  expect(host.textContent).toContain('iPhone / iPad · Safari');
  expect(host.querySelectorAll('.account-device-action')).toHaveLength(1);
  await act(async () => host.querySelector<HTMLButtonElement>('.account-device-action')!.click());
  const input = host.querySelector<HTMLInputElement>('input[type=password]')!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'correct-password');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });
  expect(mocks.revoke).toHaveBeenCalledWith('other', 'correct-password');
  expect(mocks.success).toHaveBeenCalled();
});

it('disables kick-out when the account has no local password', async () => {
  mocks.list.mockResolvedValue({ devices: [current, other], password_available: false });
  await act(async () => { root.render(<LoginDevices zh />); await Promise.resolve(); });
  expect(host.querySelector<HTMLButtonElement>('.account-device-action')?.disabled).toBe(true);
  expect(host.textContent).toContain('此账户没有本地密码');
});
