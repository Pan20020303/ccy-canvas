import { expect, it, vi } from 'vitest';
import type { SavedAsset } from './store';
import { assertDurableAsset, createAssetSyncJournal } from './asset-sync';

const asset = (id: string, folderId = ''): SavedAsset => ({ id, folderId, name: id, kind: 'image', category: 'other',
  url: `/uploads/${id}.png`, thumbnail: '', createdAt: 1 });
function storage(data = new Map<string, string>()) {
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

it('recovers failed deletes without resurrecting assets, and only removes tombstones after acknowledgement', async () => {
  const disk = storage();
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const make = () => createAssetSyncJournal({ owner: 'alice', currentOwner: () => 'alice', storage: disk, send });
  const first = make();
  first.enqueue({ entity: 'asset', action: 'delete', id: 'a' });
  expect(await first.flush()).toBe(false);
  expect(first.status()).toMatchObject({ pending: 1, error: 'offline' });
  const recovered = make();
  expect(send).toHaveBeenCalledTimes(1); // recovery itself never submits
  expect(recovered.overlay([asset('a'), asset('b')], []).savedAssets.map(a => a.id)).toEqual(['b']);
  expect(await recovered.flush()).toBe(true);
  expect(make().status().pending).toBe(0);
  expect(make().overlay([asset('a'), asset('b')], []).savedAssets.map(a => a.id)).toEqual(['b']);
});

it('serializes fast moves and deletion in the same order, including a move added during an active request', async () => {
  const disk = storage();
  let complete!: () => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; })).mockResolvedValue(undefined);
  const journal = createAssetSyncJournal({ owner: 'a', currentOwner: () => 'a', storage: disk, send });
  journal.enqueue({ entity: 'asset', action: 'save', value: asset('x', 'first') });
  const running = journal.flush();
  await Promise.resolve();
  journal.enqueue({ entity: 'asset', action: 'save', value: asset('x', 'second') });
  journal.enqueue({ entity: 'asset', action: 'delete', id: 'x' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(journal.overlay([asset('x')], []).savedAssets).toEqual([]);
  complete();
  expect(await running).toBe(true);
  expect(send.mock.calls.map(([op]) => op.action === 'save' ? op.value.folderId : op.action)).toEqual(['first', 'second', 'delete']);
});

it('does not replay one account operations with another account, and keeps existing user journals separate', async () => {
  const disk = storage();
  let current = 'alice';
  let complete!: () => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const alice = createAssetSyncJournal({ owner: 'alice', currentOwner: () => current, storage: disk, send });
  alice.enqueue({ entity: 'asset', action: 'save', value: asset('first') });
  alice.enqueue({ entity: 'asset', action: 'save', value: asset('second') });
  const running = alice.flush();
  await Promise.resolve();
  current = 'bob';
  complete();
  expect(await running).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(alice.status().pending).toBe(1);
  const bob = createAssetSyncJournal({ owner: 'bob', currentOwner: () => current, storage: disk, send });
  expect(bob.status().pending).toBe(0);
  expect(() => alice.enqueue({ entity: 'asset', action: 'delete', id: 'second' })).toThrow('当前账号');
});

it('never hides local records if the deletion journal cannot be persisted', () => {
  const disk = storage();
  disk.setItem = () => { throw new Error('quota'); };
  const journal = createAssetSyncJournal({ owner: 'a', currentOwner: () => 'a', storage: disk, send: vi.fn() });
  expect(() => journal.enqueue({ entity: 'asset', action: 'delete', id: 'x' })).toThrow('尚未完成');
  expect(journal.overlay([asset('x')], []).savedAssets).toEqual([asset('x')]);
  expect(journal.status().pending).toBe(0);
});

it('keeps a confirmed operation retryable if writing its acknowledgement fails', async () => {
  const disk = storage();
  const send = vi.fn(async () => { disk.setItem = () => { throw new Error('quota'); }; });
  const journal = createAssetSyncJournal({ owner: 'a', currentOwner: () => 'a', storage: disk, send });
  journal.enqueue({ entity: 'asset', action: 'delete', id: 'x' });
  expect(await journal.flush()).toBe(false);
  expect(journal.status()).toMatchObject({ pending: 1 });
  const restored = createAssetSyncJournal({ owner: 'a', currentOwner: () => 'a', storage: disk, send });
  expect(restored.overlay([asset('x')], []).savedAssets).toEqual([]);
});

it('preserves folder deletion semantics through offline recovery and serialized retries', async () => {
  const disk = storage();
  const send = vi.fn().mockRejectedValue(new Error('offline'));
  const journal = createAssetSyncJournal({ owner: 'a', currentOwner: () => 'a', storage: disk, send });
  journal.enqueue({ entity: 'folder', action: 'save', value: { id: 'folder', name: 'renamed', createdAt: 1 } });
  journal.enqueue({ entity: 'folder', action: 'delete', id: 'folder' });
  await journal.flush();
  const result = journal.overlay([asset('x', 'folder')], [{ id: 'folder', name: 'old', createdAt: 1 }]);
  expect(result.assetFolders).toEqual([]);
  expect(result.savedAssets[0].folderId).toBe('');
  expect(journal.status().pending).toBe(2);
});

it('refuses transient/empty media, accepts text without a URL, and leaves corrupt journals untouched', () => {
  expect(() => assertDurableAsset({ ...asset('a'), url: 'blob:session' })).toThrow('临时地址');
  expect(() => assertDurableAsset({ ...asset('a'), thumbnail: 'data:image/png;base64,abc' })).toThrow('临时地址');
  expect(() => assertDurableAsset({ ...asset('a'), url: '' })).toThrow('原文件');
  expect(() => assertDurableAsset({ ...asset('a'), kind: 'text', url: '', text: 'script' })).not.toThrow();
  const disk = storage(new Map([['ccy-asset-operations-v1:a', '{broken']]));
  expect(() => createAssetSyncJournal({ owner: 'a', currentOwner: () => 'a', storage: disk, send: vi.fn() })).toThrow();
  expect(disk.getItem('ccy-asset-operations-v1:a')).toBe('{broken');
});
