import { expect, it, vi } from 'vitest';
import { isDynamicImportError, requestChunkReload } from './chunk-recovery';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

it('recognizes Vite dynamic import failures', () => {
  expect(isDynamicImportError(new TypeError('Failed to fetch dynamically imported module: /assets/MediaPreview-old.js'))).toBe(true);
  expect(isDynamicImportError(new Error('ordinary media decode error'))).toBe(false);
});

it('reloads once and guards against a reload loop', () => {
  const storage = memoryStorage();
  const reload = vi.fn();
  expect(requestChunkReload('preview', { storage, reload, now: 100_000 })).toBe(true);
  expect(requestChunkReload('preview', { storage, reload, now: 100_100 })).toBe(false);
  expect(reload).toHaveBeenCalledOnce();
  expect(requestChunkReload('preview', { storage, reload, now: 131_000 })).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});
