import type { AssetFolder, SavedAsset } from './store';

export type AssetMutation =
  | { entity: 'asset'; action: 'save'; value: SavedAsset }
  | { entity: 'folder'; action: 'save'; value: AssetFolder }
  | { entity: 'asset' | 'folder'; action: 'delete'; id: string; name?: string };
export type AssetSyncOperation = AssetMutation & { operationId: string; error?: string };
export type AssetSyncState = { pending: number; syncing: boolean; error: string | null };
const storageKey = (owner: string) => `ccy-asset-operations-v1:${encodeURIComponent(owner)}`;
const idOf = (op: AssetMutation) => op.action === 'save' ? op.value.id : op.id;

/** A server record must not pretend a browser-session URL is durable. Existing
 * local assets are kept visible; only explicit save/retry attempts are checked. */
export function assertDurableAsset(asset: SavedAsset): void {
  if (asset.kind === 'text') {
    if (!asset.text?.trim()) throw new Error('文本素材为空，尚未保存。');
  } else if (!asset.url?.trim()) throw new Error('素材还没有可保存的原文件，请先完成上传。');
  if ([asset.url, asset.thumbnail].some(url => /^\s*(blob:|data:)/i.test(url ?? ''))) {
    throw new Error('素材仍使用临时地址，请先上传原文件后再保存；原节点仍保留。');
  }
}

/** Small durable FIFO. Asset/folder operations share ordering because folder
 * deletion also moves its members on the server. API upserts/deletes are
 * idempotent by entity id, so an uncertain acknowledgement is safe to retry.
 * Constructing/recovering a journal never sends requests. */
export function createAssetSyncJournal(options: {
  owner: string;
  currentOwner: () => string;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  send: (operation: AssetMutation) => Promise<void>;
  onChange?: (state: AssetSyncState) => void;
}) {
  const { owner, storage } = options;
  let operations: AssetSyncOperation[] = [];
  // Confirmed deletions also suppress old localStorage snapshots. Otherwise a
  // crash between server ACK and the debounced main-store write resurrects the
  // deleted row as a supposedly "legacy local-only" asset on the next open.
  let deleted: Array<{ entity: 'asset' | 'folder'; id: string }> = [];
  let revision = 0;
  let inFlight: Promise<boolean> | null = null;
  let storageError: string | null = null;
  const raw = storage.getItem(storageKey(owner));
  if (raw) {
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Array.isArray(value.operations) || value.operations.some((op: any) =>
      !op || !['asset', 'folder'].includes(op.entity) || !['save', 'delete'].includes(op.action)
      || typeof op.operationId !== 'string' || typeof (op.action === 'save' ? op.value?.id : op.id) !== 'string')) {
      throw new Error('本地素材待同步记录无法读取，已保留原记录；请勿清理浏览器数据。');
    }
    operations = value.operations;
    if (value.deleted !== undefined && (!Array.isArray(value.deleted) || value.deleted.some((item: any) =>
      !item || !['asset', 'folder'].includes(item.entity) || typeof item.id !== 'string'))) {
      throw new Error('本地素材删除记录无法读取，已保留原记录；请勿清理浏览器数据。');
    }
    deleted = value.deleted ?? [];
  }
  const status = (): AssetSyncState => ({ pending: operations.length, syncing: !!inFlight,
    error: storageError || operations.find(op => op.error)?.error || null });
  const publish = () => options.onChange?.(status());
  function persist(next: AssetSyncOperation[], nextDeleted = deleted) {
    try { storage.setItem(storageKey(owner), JSON.stringify({ version: 1, operations: next, deleted: nextDeleted })); }
    catch { storageError = '本地待同步记录写入失败，操作尚未完成；请释放存储空间后重试。'; publish(); throw new Error(storageError); }
    operations = next;
    deleted = nextDeleted;
    storageError = null;
    revision++;
    publish();
  }
  function enqueue(mutation: AssetMutation) {
    if (!owner || options.currentOwner() !== owner) throw new Error('请登录当前账号后再保存素材。');
    if (mutation.entity === 'asset' && mutation.action === 'save') assertDurableAsset(mutation.value);
    const operation: AssetSyncOperation = { ...mutation,
      operationId: `asset-op-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    // Persist first: failure must not hide an asset or claim a successful save.
    persist([...operations, operation]);
  }
  async function drain(): Promise<boolean> {
    while (operations.length) {
      if (options.currentOwner() !== owner) return false;
      const operation = operations[0];
      try {
        if (operation.entity === 'asset' && operation.action === 'save') assertDurableAsset(operation.value);
        await options.send(operation);
        // Keep the captured owner's journal correct after an account switch;
        // never start its next request using the new account's credentials.
        const nextDeleted = deleted.filter(item => item.entity !== operation.entity || item.id !== idOf(operation));
        if (operation.action === 'delete') nextDeleted.push({ entity: operation.entity, id: operation.id });
        persist(operations.filter(op => op.operationId !== operation.operationId), nextDeleted);
      } catch (error) {
        const message = error instanceof Error ? error.message : '素材同步失败，请重试。';
        try { persist(operations.map(op => op.operationId === operation.operationId ? { ...op, error: message } : op)); }
        catch { /* original operation remains durable; retry is idempotent */ }
        return false;
      }
    }
    return true;
  }
  function flush(): Promise<boolean> {
    if (inFlight) return inFlight;
    if (options.currentOwner() !== owner) return Promise.resolve(false);
    // Defer dispatch one microtask so the caller can apply the optimistic UI
    // only after enqueue's durable write has succeeded.
    inFlight = Promise.resolve().then(drain).finally(() => { inFlight = null; publish(); });
    publish();
    return inFlight;
  }
  function overlay(assets: SavedAsset[], folders: AssetFolder[]) {
    const assetMap = new Map(assets.map(asset => [asset.id, asset]));
    const folderMap = new Map(folders.map(folder => [folder.id, folder]));
    for (const item of deleted) {
      if (item.entity === 'asset') assetMap.delete(item.id);
      else {
        folderMap.delete(item.id);
        for (const [id, asset] of assetMap) if (asset.folderId === item.id) assetMap.set(id, { ...asset, folderId: '' });
      }
    }
    for (const operation of operations) {
      if (operation.entity === 'asset') {
        if (operation.action === 'save') assetMap.set(operation.value.id, operation.value);
        else assetMap.delete(operation.id);
      } else if (operation.action === 'save') folderMap.set(operation.value.id, operation.value);
      else {
        folderMap.delete(operation.id);
        for (const [id, asset] of assetMap) if (asset.folderId === operation.id) assetMap.set(id, { ...asset, folderId: '' });
      }
    }
    return { savedAssets: [...assetMap.values()].sort((a, b) => b.createdAt - a.createdAt),
      assetFolders: [...folderMap.values()].sort((a, b) => b.createdAt - a.createdAt) };
  }
  return { enqueue, flush, overlay, status, revision: () => revision,
    hasPending: (entity: 'asset' | 'folder', id: string) => operations.some(op => op.entity === entity && idOf(op) === id) };
}
