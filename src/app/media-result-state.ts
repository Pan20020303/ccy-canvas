import type { NodeVersion } from './store';

// Staging and OSS/COS promotion preserve the generated file's UUID and month.
// Never deduplicate arbitrary provider URLs just because their basenames match.
function generatedAssetKey(raw: string): string | undefined {
  try {
    const url = new URL(raw, 'https://canvas.invalid');
    const local = /\/uploads\/(?:staging\/)?generated\//.test(url.pathname);
    const objectStore = /\.(?:aliyuncs\.com|myqcloud\.com)$/.test(url.hostname);
    if (!local && !objectStore) return undefined;
    return url.pathname.match(/\/generated\/(\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+)$/i)?.[1];
  } catch { return undefined; }
}

export function sameGeneratedMedia(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const key = generatedAssetKey(left);
  return Boolean(key && key === generatedAssetKey(right));
}

export function uniqueMediaVersions(activeUrl: string, versions: NodeVersion[]): NodeVersion[] {
  const seen = activeUrl ? [activeUrl] : [];
  return versions.filter((version) => {
    if (!version.url || seen.some((url) => sameGeneratedMedia(url, version.url))) return false;
    seen.push(version.url);
    return true;
  });
}

/** One generation is one version, even if its storage URL changes. Snapshot
 * the previous generation when the FIRST preview arrives, not on promotion. */
export function taskMediaPatch(data: Record<string, unknown>, url: string, taskId: string, now = Date.now()): Record<string, unknown> {
  const previousUrl = typeof data.url === 'string' ? data.url : '';
  const sameResult = data.mediaTaskId === taskId || sameGeneratedMedia(previousUrl, url);
  const existing = Array.isArray(data.versions) ? data.versions as NodeVersion[] : [];
  const history = previousUrl && !sameResult
    ? [{
        id: typeof data.activeVersionId === 'string' ? data.activeVersionId : `v-before-${taskId}`,
        url: previousUrl,
        prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
        timestamp: typeof data.activeVersionTimestamp === 'number' ? data.activeVersionTimestamp : now - 1,
      }, ...existing]
    : existing;
  return {
    url,
    output: url,
    mediaTaskId: taskId,
    versions: uniqueMediaVersions(url, history),
    activeVersionId: sameResult && typeof data.activeVersionId === 'string' ? data.activeVersionId : `v-task-${taskId}`,
    activeVersionTimestamp: sameResult && typeof data.activeVersionTimestamp === 'number' ? data.activeVersionTimestamp : now,
    // Dimensions belong to the previous file, not to the node. A new result
    // must fall back to its requested ratio until the new media is measured.
    // Keep them during staging → object-storage promotion of the same result.
    ...(sameResult ? {} : { poster: undefined, mediaWidth: undefined, mediaHeight: undefined }),
  };
}

export function hasTaskPreview(data: Record<string, unknown>): boolean {
  return typeof data.url === 'string' && data.url.length > 0
    && (data.assetSyncing === true || data.taskPhase === 'persisting');
}
