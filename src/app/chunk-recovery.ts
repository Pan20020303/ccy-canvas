import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const RELOAD_PREFIX = 'ccy:chunk-reload:';
const RELOAD_GUARD_MS = 30_000;
let reloadSafety: (() => Promise<boolean>) | undefined;

export function setChunkReloadSafety(prepare: () => Promise<boolean>): void { reloadSafety = prepare; }

export async function canSafelyReloadChunks(): Promise<boolean> {
  return reloadSafety ? reloadSafety() : true;
}

export function isDynamicImportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk .+ failed/i.test(message);
}

export function requestChunkReload(
  key: string,
  options: { storage?: Storage; now?: number; reload?: () => void } = {},
): boolean {
  if (typeof window === 'undefined' && (!options.storage || !options.reload)) return false;
  const storage = options.storage ?? window.sessionStorage;
  const now = options.now ?? Date.now();
  const marker = `${RELOAD_PREFIX}${key}`;
  const previous = Number(storage.getItem(marker));
  if (Number.isFinite(previous) && previous > 0 && now - previous < RELOAD_GUARD_MS) return false;
  storage.setItem(marker, String(now));
  (options.reload ?? (() => window.location.reload()))();
  return true;
}

type LazyModule<T extends ComponentType<any>> = { default: T };

/**
 * React.lazy with one guarded page refresh when a deploy removed the chunk an
 * already-open tab still references. A second failure within 30 seconds is
 * surfaced normally instead of creating a reload loop.
 */
export function lazyWithChunkRecovery<T extends ComponentType<any>>(
  key: string,
  loader: () => Promise<LazyModule<T>>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const loaded = await loader();
      if (typeof window !== 'undefined') window.sessionStorage.removeItem(`${RELOAD_PREFIX}${key}`);
      return loaded;
    } catch (error) {
      if (isDynamicImportError(error) && await canSafelyReloadChunks() && requestChunkReload(key)) {
        // Navigation is imminent. Keep Suspense pending so React Router never
        // replaces the canvas with its full-page default error boundary.
        return await new Promise<never>(() => {});
      }
      throw error;
    }
  });
}
