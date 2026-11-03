import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SavedAsset } from './store';

const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), folders: vi.fn(), saveFolder: vi.fn(), removeFolder: vi.fn() }));
vi.mock('./api/assets', async load => ({ ...await load<object>(), listAssetsFromServer: api.list, saveAssetToServer: api.save,
  deleteAssetsFromServer: api.remove, listAssetFoldersFromServer: api.folders, saveAssetFolderToServer: api.saveFolder,
  deleteAssetFolderFromServer: api.removeFolder }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

const asset = (id: string, folderId = ''): SavedAsset => ({ id, folderId, name: id, kind: 'image', category: 'other',
  url: `/uploads/${id}.png`, thumbnail: '', createdAt: 1 });
async function editor() {
  vi.resetModules();
  const disk = new Map<string, string>();
  const storage = { get length() { return disk.size; }, key: (index: number) => [...disk.keys()][index] ?? null,
    getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); },
    removeItem: (key: string) => { disk.delete(key); } };
  vi.stubGlobal('localStorage', storage);
  const mod = await import('./store');
  mod.bindStorageToUser('asset-test-alice');
  mod.useStore.setState({ savedAssets: [asset('a')], assetFolders: [], assetSync: { pending: 0, syncing: false, error: null } });
  return { store: mod.useStore, bind: mod.bindStorageToUser, disk, storage };
}
beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset());
  api.list.mockResolvedValue([]); api.folders.mockResolvedValue([]);
  api.save.mockResolvedValue(undefined); api.remove.mockResolvedValue(undefined);
  api.saveFolder.mockResolvedValue(undefined); api.removeFolder.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it('exposes save failure, keeps its durable operation and local row, and retries the same id', async () => {
  const { store, disk } = await editor();
  api.save.mockRejectedValueOnce(new Error('offline'));
  const created = store.getState().saveAsset({ ...asset('new'), id: undefined } as never);
  expect(await store.getState().retryAssetSync()).toBe(false);
  expect(store.getState().savedAssets.some(a => a.id === created.id)).toBe(true);
  expect(store.getState().assetSync).toMatchObject({ pending: 1, syncing: false, error: 'offline' });
  expect(disk.get('ccy-asset-operations-v1:asset-test-alice')).toContain(created.id);
  api.list.mockResolvedValue([created, asset('a')]);
  expect(await store.getState().retryAssetSync()).toBe(true);
  expect(api.save.mock.calls.map(([a]) => a.id)).toEqual([created.id, created.id]);
});

it('does not resurrect an offline delete from hydrate, even when an old GET completes after successful retry', async () => {
  const { store } = await editor();
  api.remove.mockRejectedValueOnce(new Error('offline'));
  store.getState().removeAsset('a');
  expect(await store.getState().retryAssetSync()).toBe(false);
  api.list.mockResolvedValueOnce([asset('a')]);
  await store.getState().hydrateAssets();
  expect(store.getState().savedAssets).toEqual([]);
  let finishGet!: (rows: SavedAsset[]) => void;
  api.list.mockImplementationOnce(() => new Promise(resolve => { finishGet = resolve; }));
  const staleGet = store.getState().hydrateAssets();
  expect(await store.getState().retryAssetSync()).toBe(true);
  finishGet([asset('a')]);
  await staleGet;
  expect(store.getState().savedAssets).toEqual([]);
  expect(store.getState().assetSync.pending).toBe(0);
});

it('applies rapid moves immediately while serializing requests and rejecting stale reads', async () => {
  const { store } = await editor();
  store.setState({ assetFolders: [{ id: 'one', name: 'one', createdAt: 1 }, { id: 'two', name: 'two', createdAt: 2 }] });
  let complete!: () => void;
  api.save.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  store.getState().moveAssetToFolder('a', 'one');
  await Promise.resolve();
  store.getState().moveAssetToFolder('a', 'two');
  expect(store.getState().savedAssets[0].folderId).toBe('two');
  expect(api.save).toHaveBeenCalledTimes(1);
  api.list.mockResolvedValue([asset('a', 'one')]);
  await store.getState().hydrateAssets();
  expect(store.getState().savedAssets[0].folderId).toBe('two');
  const synced = store.getState().retryAssetSync();
  complete();
  // Subsequent server reads in this test reflect the completed second move.
  api.list.mockResolvedValue([asset('a', 'two')]);
  api.folders.mockResolvedValue(store.getState().assetFolders);
  await synced;
  expect(api.save.mock.calls.map(([a]) => a.folderId)).toEqual(['one', 'two']);
  expect(store.getState().savedAssets[0].folderId).toBe('two');
});

it('protects existing local-only records without automatic replay and refuses transient new records', async () => {
  const { store } = await editor();
  const transient = { ...asset('old'), url: 'blob:still-in-this-tab' };
  store.setState({ savedAssets: [asset('a'), transient] });
  await store.getState().hydrateAssets();
  expect(store.getState().savedAssets).toHaveLength(2);
  expect(api.save).not.toHaveBeenCalled();
  expect(store.getState().assetSync.pending).toBe(2);
  expect(() => store.getState().saveAsset({ ...asset('new'), url: 'data:image/png;base64,aaa' })).toThrow('临时地址');
  expect(store.getState().savedAssets).toHaveLength(2);
});

it('syncs valid legacy assets even when another preserved local asset still has a transient URL', async () => {
  const { store } = await editor();
  const transient = { ...asset('old'), url: 'blob:still-in-this-tab' };
  store.setState({ savedAssets: [transient, asset('a')] });
  await store.getState().hydrateAssets();
  api.list.mockResolvedValue([asset('a')]);
  expect(await store.getState().retryAssetSync()).toBe(false);
  expect(api.save).toHaveBeenCalledExactlyOnceWith(asset('a'));
  expect(store.getState().savedAssets).toHaveLength(2);
  expect(store.getState().assetSync).toMatchObject({ pending: 1 });
  expect(store.getState().assetSync.error).toContain('临时地址');
});

it('keeps a failed asset read visible when the concurrent folder read succeeds', async () => {
  const { store } = await editor();
  api.list.mockRejectedValue(new Error('asset read offline'));
  await Promise.all([store.getState().hydrateAssets(), store.getState().hydrateAssetFolders()]);
  expect(store.getState().assetSync.error).toBe('asset read offline');
  expect(store.getState().savedAssets).toEqual([asset('a')]);
});

it('keeps assets visible when tombstone storage fails and shows a retryable error', async () => {
  const { store, storage } = await editor();
  const write = storage.setItem;
  storage.setItem = (key, value) => { if (key.startsWith('ccy-asset-operations')) throw new Error('quota'); write(key, value); };
  store.getState().removeAsset('a');
  expect(store.getState().savedAssets).toEqual([asset('a')]);
  expect(store.getState().assetSync.error).toContain('尚未完成');
  expect(api.remove).not.toHaveBeenCalled();
});

it('does not leak the old library or process its next operation after an account switch', async () => {
  const { store, bind, disk } = await editor();
  let complete!: () => void;
  api.save.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  store.getState().saveAsset({ ...asset('first') });
  store.getState().saveAsset({ ...asset('second') });
  const running = store.getState().retryAssetSync();
  await Promise.resolve();
  bind('asset-test-bob');
  expect(store.getState().savedAssets).toEqual([]);
  complete();
  expect(await running).toBe(false);
  expect(api.save).toHaveBeenCalledTimes(1);
  expect(store.getState().assetSync).toEqual({ pending: 0, syncing: false, error: null });
  expect(JSON.parse(disk.get('ccy-asset-operations-v1:asset-test-alice')!).operations).toHaveLength(1);
});

it('restores each existing user library rather than clearing it during account isolation', async () => {
  const { store, bind, disk } = await editor();
  disk.set('cineflow-store-asset-test-bob', JSON.stringify({ version: 5, state: { savedAssets: [asset('bob')], assetFolders: [] } }));
  bind('asset-test-bob');
  expect(store.getState().savedAssets.map(a => a.id)).toEqual(['bob']);
  bind('asset-test-alice');
  expect(store.getState().savedAssets.map(a => a.id)).toEqual(['a']);
});
