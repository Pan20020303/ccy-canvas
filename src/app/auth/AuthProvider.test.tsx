// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthProvider';

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), bind: vi.fn(),
  state: { setBackendModels: vi.fn(), loadBackendProjects: vi.fn() } }));
vi.mock('../api/client', () => ({ apiClient: { post: mocks.post, get: mocks.get } }));
vi.mock('../api/providerConfigs', () => ({ listAppProviderConfigs: async () => [] }));
vi.mock('../runtimeInvalidation', () => ({ subscribeRuntimeInvalidation: () => () => {} }));
vi.mock('../store', () => ({ useStore: (selector: any) => selector(mocks.state), bindStorageToUser: mocks.bind }));
let auth: ReturnType<typeof useAuth>;
function Probe() { auth = useAuth(); return null; }
let root: Root;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.get.mockResolvedValue({ user: { id: 'test-user', name: 'Test', email: 'test@example.invalid', role: 'member' } });
  mocks.post.mockReset(); mocks.bind.mockClear();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
  mocks.bind.mockClear();
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it('clears the asset operation owner only after logout is acknowledged', async () => {
  let finish!: () => void;
  mocks.post.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  let result!: Promise<void>;
  act(() => { result = auth.logout(); });
  expect(mocks.bind).not.toHaveBeenCalled();
  await act(async () => { finish(); await result; });
  expect(mocks.post).toHaveBeenCalledWith('/api/auth/logout');
  expect(mocks.bind).toHaveBeenCalledExactlyOnceWith('');
  expect(auth.user).toBeNull();
});

it('keeps the current owner when logout fails', async () => {
  mocks.post.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await expect(auth.logout()).rejects.toThrow('offline'); });
  expect(mocks.bind).not.toHaveBeenCalled();
  expect(auth.user?.id).toBe('test-user');
});
