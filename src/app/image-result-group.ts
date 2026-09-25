import type { Node } from '@xyflow/react';
import { mediaVersionSnapshot, sameGeneratedMedia, taskMediaPatch, uniqueMediaVersions } from './media-result-state';
import type { NodeVersion } from './store';

export function imageResultUrls(value: unknown, fallback = ''): string[] {
  const urls = Array.isArray(value)
    ? value.filter((url): url is string => typeof url === 'string' && Boolean(url.trim())).map(url => url.trim())
    : [];
  return urls.length ? urls : fallback ? [fallback] : [];
}

function galleryGroups(data: Record<string, unknown>): NodeVersion[] {
  const versions = Array.isArray(data.versions) ? data.versions as NodeVersion[] : [];
  const latest = versions.reduce((time, version) => Math.max(time, version.timestamp || 0), 0);
  return [mediaVersionSnapshot(data, 'current', latest + 1), ...versions]
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}

function groupUrls(group: NodeVersion): string[] {
  const urls = imageResultUrls(group.imageResults, group.url);
  if (group.url && !urls.some(url => sameGeneratedMedia(url, group.url))) urls.unshift(group.url);
  return urls;
}

/** All models share one ordered gallery, including legacy single-image versions. */
export function imageGalleryEntries(data: Record<string, unknown>) {
  const seen: string[] = [];
  return galleryGroups(data).flatMap(group => groupUrls(group).flatMap((url, index) => {
    if (seen.some(previous => sameGeneratedMedia(previous, url))) return [];
    seen.push(url);
    const batchId = group.imageResultTaskId || group.mediaTaskId || group.id;
    return [{ url, index, batchId, prompt: group.prompt, model: group.model }];
  }));
}

export function imageGallerySelectionPatch(data: Record<string, unknown>, url: string): Record<string, unknown> | undefined {
  if (!imageGalleryEntries(data).some(entry => entry.url === url)) return undefined;
  const base = { url, output: url, originalUrl: url, referenceValue: url,
    poster: undefined, thumbnail: undefined, mediaWidth: undefined, mediaHeight: undefined,
    ...(['running', 'generating', 'queued'].includes(String(data.status)) ? {} : {
      status: 'done', error: undefined, lastGenerationError: undefined,
      lastGenerationFailedAt: undefined, queuedAfterTimeout: false, taskPhase: undefined,
    }),
  };
  if (imageResultUrls(data.imageResults, String(data.url || '')).some(value => sameGeneratedMedia(value, url))) return base;
  const versions = Array.isArray(data.versions) ? data.versions as NodeVersion[] : [];
  const target = versions.find(version => groupUrls(version).some(value => sameGeneratedMedia(value, url)));
  if (!target) return undefined;
  const latest = versions.reduce((time, version) => Math.max(time, version.timestamp || 0), 0);
  const snapshot = mediaVersionSnapshot(data, 'current', latest + 1);
  return {
    ...base,
    prompt: target.prompt ?? data.prompt, model: target.model ?? data.model,
    imageResults: target.imageResults, imageResultTaskId: target.imageResultTaskId,
    mediaTaskId: target.mediaTaskId,
    activeVersionId: target.id, activeVersionTimestamp: target.timestamp,
    versions: uniqueMediaVersions(url, [snapshot, ...versions.filter(version => version !== target)]),
  };
}

function preferredResultUrl(previous: string | undefined, incoming: string): string {
  if (!previous || previous === incoming) return incoming;
  // A late task response must not undo local rehosting or a completed object
  // store promotion. The order of a task's images stays constant throughout.
  if (sameGeneratedMedia(previous, incoming)) {
    if (incoming.includes('/staging/generated/') && !previous.includes('/staging/generated/')) return previous;
    return incoming;
  }
  if (previous.startsWith('/uploads/') && /^https?:\/\//i.test(incoming)) return previous;
  return incoming;
}

/** One task produces one node. Later responses for that task can fill in the
 * group or promote its URLs, while the user's selected image stays selected. */
export function imageResultGroupPatch(
  data: Record<string, unknown>,
  primary: string,
  values: unknown,
  taskId: string,
  now = Date.now(),
): Record<string, unknown> {
  // A completion replay may refer to a version the user has just moved into
  // history. Refresh that batch without stealing the selected historical image.
  const versions = Array.isArray(data.versions) ? data.versions as NodeVersion[] : [];
  const historical = versions.find(version => version.mediaTaskId === taskId || version.imageResultTaskId === taskId);
  if (historical && data.mediaTaskId !== taskId && data.imageResultTaskId !== taskId) {
    const patch = imageResultGroupPatch({ ...historical, versions: [], mediaTaskId: taskId }, primary, values, taskId, now);
    return { versions: versions.map(version => version === historical ? {
      ...version, url: String(patch.url), imageResults: patch.imageResults as string[] | undefined,
      imageResultTaskId: patch.imageResultTaskId as string | undefined,
    } : version) };
  }
  const incoming = imageResultUrls(values, primary);
  const sameBatch = data.imageResultTaskId === taskId;
  const previous = sameBatch ? imageResultUrls(data.imageResults) : [];
  const urls = [...incoming];
  // A root result_url-only notification is not evidence that the rest of the
  // completed group disappeared. Keep its previous ordered entries.
  if (sameBatch && previous.length > urls.length) urls.push(...previous.slice(urls.length));
  if (sameBatch) {
    for (let index = 0; index < urls.length; index += 1) {
      urls[index] = preferredResultUrl(previous[index], urls[index]);
    }
  }
  const previousPrimary = typeof data.url === 'string' ? data.url : '';
  const selectedIndex = sameBatch ? previous.findIndex(url => sameGeneratedMedia(url, previousPrimary)) : -1;
  const selected = urls[selectedIndex >= 0 ? selectedIndex : 0] || primary;
  return {
    ...taskMediaPatch(data, selected, taskId, now),
    originalUrl: selected,
    referenceValue: selected,
    imageResults: urls.length > 1 ? urls : undefined,
    imageResultTaskId: urls.length > 1 ? taskId : undefined,
  };
}

export function imageResultUrlUpgrade(data: Record<string, unknown>, original: string, stable: string): Record<string, unknown> {
  const urls = imageResultUrls(data.imageResults);
  const changedGroup = urls.includes(original);
  const changedPrimary = data.url === original;
  const versions = Array.isArray(data.versions) ? data.versions as NodeVersion[] : [];
  const changedHistory = versions.some(version => version.url === original || version.imageResults?.includes(original));
  if (!changedGroup && !changedPrimary && !changedHistory) return {};
  return {
    ...(changedHistory ? { versions: versions.map(version => ({ ...version,
      url: version.url === original ? stable : version.url,
      ...(version.imageResults ? { imageResults: version.imageResults.map(url => url === original ? stable : url) } : {}),
    })) } : {}),
    ...(changedGroup ? { imageResults: urls.map(url => url === original ? stable : url) } : {}),
    ...(changedPrimary ? { url: stable, output: stable, originalUrl: stable, referenceValue: stable } : {}),
  };
}

function stableUrlId(url: string): string {
  let hash = 2166136261;
  for (const char of url) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `imported-${(hash >>> 0).toString(36)}`;
}

export function buildImageResultNodes(source: Node, existing: Node[]): Node[] {
  const data = source.data as Record<string, unknown>;
  const entries = imageGalleryEntries(data);
  const prefix = `node-image-result-${encodeURIComponent(source.id)}-`;
  const existingIds = new Set(existing.map(node => node.id));
  const columns = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
  return entries.flatMap((entry, index) => {
    const { url, batchId } = entry;
    const id = `${prefix}${stableUrlId(url)}`;
    if (existingIds.has(id) || existing.some(node => node.data.imageResultSourceNodeId === source.id
      && sameGeneratedMedia(String(node.data.url || ''), url))) return [];
    return [{
      id,
      type: 'imageNode',
      position: {
        x: source.position.x + Math.max(source.width || 320, 320) + 60 + (index % columns) * 340,
        y: source.position.y + Math.floor(index / columns) * 320,
      },
      data: {
        url,
        output: url,
        originalUrl: url,
        status: 'done',
        sourceKind: 'generated',
        sourceName: `组图 ${index + 1}/${entries.length}`,
        prompt: entry.prompt,
        model: entry.model,
        imageResultSourceNodeId: source.id,
        imageResultSourceTaskId: batchId,
      },
    } as Node];
  });
}
