import type { Edge, Node } from '@xyflow/react';
import type { Group } from './store';

/** Full canvas data, kept separately from the deliberately stripped UI cache. */
export type CanvasRecoverySnapshot = {
  format: 'ccy-canvas-recovery-v1';
  id: string;
  projectId: string;
  projectName: string;
  baseVersion: number;
  savedAt: number;
  nodes: Node[];
  edges: Edge[];
  groups: Group[];
};

const PREFIX = 'ccy-canvas-recovery:';
const DB_NAME = 'ccy-canvas-recovery';
const STORE = 'snapshots';
let database: Promise<IDBDatabase> | null = null;
const prefixFor = (owner: string) => `${PREFIX}${encodeURIComponent(owner || 'anonymous')}:`;
const keyFor = (owner: string, id: string) => `${prefixFor(owner)}${id}`;

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Recovery storage is blocked by another window'));
    }).catch(error => { database = null; throw error; });
  }
  return database;
}

async function inDatabase<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error || request.error);
    transaction.onabort = () => reject(transaction.error || request.error || new Error('Recovery write aborted'));
  });
}

/** Try synchronous storage first, including during pagehide. Large canvases
 * fall back to IndexedDB during normal editing; callers must await durability
 * before replacing an unsaved editor. Failure is never treated as a backup. */
export async function writeCanvasRecovery(owner: string, snapshot: CanvasRecoverySnapshot): Promise<void> {
  const key = keyFor(owner, snapshot.id);
  const serialized = JSON.stringify(snapshot);
  try {
    localStorage.setItem(key, serialized);
    return;
  } catch {
    await inDatabase('readwrite', store => store.put(serialized, key));
  }
}

export async function removeCanvasRecovery(owner: string, id: string): Promise<void> {
  const key = keyFor(owner, id);
  try { localStorage.removeItem(key); } catch { /* IndexedDB may be the backing store. */ }
  if (typeof indexedDB !== 'undefined') {
    try { await inDatabase('readwrite', store => store.delete(key)); } catch { /* A stale copy is safer than lost recovery data. */ }
  }
}

export async function readCanvasRecovery(owner: string, projectId: string): Promise<CanvasRecoverySnapshot | null> {
  const prefix = prefixFor(owner);
  const records: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) {
        const raw = localStorage.getItem(key);
        if (raw) records.push(raw);
      }
    }
  } catch { /* Try the large-canvas store as well. */ }
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openDatabase();
      const stored = await new Promise<string[]>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly');
        const found: string[] = [];
        const cursor = transaction.objectStore(STORE).openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (String(item.key).startsWith(prefix) && typeof item.value === 'string') found.push(item.value);
          item.continue();
        };
        transaction.oncomplete = () => resolve(found);
        transaction.onerror = () => reject(transaction.error);
      });
      records.push(...stored);
    } catch { /* A readable synchronous backup is still usable. */ }
  }
  let newest: CanvasRecoverySnapshot | null = null;
  for (const raw of records) {
    try {
      const snapshot = JSON.parse(raw) as CanvasRecoverySnapshot;
      if (snapshot.format !== 'ccy-canvas-recovery-v1' || snapshot.projectId !== projectId
        || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.groups)) continue;
      if (!newest || snapshot.savedAt > newest.savedAt) newest = snapshot;
    } catch { /* Ignore unrelated or incomplete entries. */ }
  }
  return newest;
}

export function downloadRecoverySnapshot(snapshot: CanvasRecoverySnapshot): boolean {
  try {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${snapshot.projectName || 'canvas'}-recovery-${snapshot.savedAt}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch { return false; }
}
