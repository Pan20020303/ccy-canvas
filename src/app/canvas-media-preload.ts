import { extractOriginalMediaUrl, toRenderableMediaUrl } from './reference-media';

export type PreloadNode = {
  id: string;
  type?: string;
  selected?: boolean;
  hidden?: boolean;
  parentId?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  data: Record<string, unknown>;
};
export type PreloadViewport = { x: number; y: number; zoom: number; width: number; height: number };
export type ImagePreloadTarget = {
  sourceUrl: string;
  requestUrl: string;
  measureOriginal: boolean;
  owners: { nodeId: string; url: string; measureOriginal: boolean }[];
};

const IMAGE_NODE_TYPES = new Set(['imageNode', 'referenceImageNode', 'layerEditorNode', 'panoramaNode']);
const NON_IMAGE_EXTENSION = /\.(?:mp4|webm|mov|m4v|avi|mkv|mp3|wav|ogg|oga|m4a|aac|flac|pdf)(?:$|[?#])/i;

function isImageCandidate(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false;
  const source = extractOriginalMediaUrl(url);
  if (source.startsWith('data:')) return /^data:image\//i.test(source);
  return /^(?:https?:|blob:|\/)/i.test(source) && !NON_IMAGE_EXTENSION.test(source);
}

/** Warm at most one preview per selected/visible node, deduplicated by source.
 * Do not scan offscreen media into a background download queue. Video/audio
 * sources are never passed to Image; their explicit image posters are allowed.
 */
export function collectImagePreloadTargets(nodes: PreloadNode[], viewport: PreloadViewport, limit = 24): ImagePreloadTarget[] {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  const overscan = 120 / zoom;
  const left = -viewport.x / zoom - overscan;
  const top = -viewport.y / zoom - overscan;
  const right = left + viewport.width / zoom + 2 * overscan;
  const bottom = top + viewport.height / zoom + 2 * overscan;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const positioned = nodes.filter(node => !node.hidden).map(node => {
    let x = node.position.x, y = node.position.y;
    let parent = node.parentId;
    const seen = new Set([node.id]);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) break;
      x += ancestor.position.x; y += ancestor.position.y; parent = ancestor.parentId;
    }
    const width = node.measured?.width || node.width || 300;
    const height = node.measured?.height || node.height || 240;
    return { node, x, y, width, height };
  }).filter(({ node, x, y, width, height }) => node.selected || (
    viewport.width > 0 && viewport.height > 0 && x + width >= left && x <= right && y + height >= top && y <= bottom
  )).sort((a, b) => {
    const selection = Number(Boolean(b.node.selected)) - Number(Boolean(a.node.selected));
    if (selection) return selection;
    const distance = (p: typeof a) => (p.x + p.width / 2 - (left + right) / 2) ** 2 + (p.y + p.height / 2 - (top + bottom) / 2) ** 2;
    return distance(a) - distance(b);
  });

  const targets = new Map<string, ImagePreloadTarget>();
  for (const { node } of positioned) {
    const data = node.data;
    const mime = String(data.mimeType ?? data.mime_type ?? '').toLowerCase();
    const imageSource = IMAGE_NODE_TYPES.has(node.type ?? '') && !/^(?:audio|video)\//.test(mime);
    const original = imageSource && isImageCandidate(data.url) ? data.url : null;
    const source = original ?? [data.poster, data.thumbnail].find(url => isImageCandidate(url) && url !== data.url);
    if (!isImageCandidate(source)) continue;
    const sourceUrl = extractOriginalMediaUrl(source);
    const hasDimensions = Number(data.mediaWidth) > 0 && Number(data.mediaHeight) > 0;
    const measureOriginal = original !== null && !hasDimensions;
    let target = targets.get(sourceUrl);
    if (!target) {
      if (targets.size >= Math.max(0, limit)) continue;
      target = { sourceUrl, requestUrl: '', measureOriginal: false, owners: [] };
      targets.set(sourceUrl, target);
    }
    target.measureOriginal ||= measureOriginal;
    target.owners.push({ nodeId: node.id, url: source, measureOriginal });
  }
  for (const target of targets.values()) {
    // Never persist a resized proxy thumbnail's dimensions as original media
    // dimensions. Only missing image metadata justifies an original-size load.
    target.requestUrl = toRenderableMediaUrl(target.sourceUrl, target.measureOriginal ? undefined : { thumbWidth: 720 });
  }
  return [...targets.values()];
}

export type ImageDimensions = { width: number; height: number };
export type ImageLoad = (url: string, signal: AbortSignal) => Promise<ImageDimensions | null>;

/** Per-image deadline plus cancellation removes handlers and abandons stale
 * browser requests. It never updates the graph itself. */
export function loadPreloadImage(url: string, signal: AbortSignal, timeoutMs = 5000): Promise<ImageDimensions | null> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(null); return; }
    const image = new Image();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ImageDimensions | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      image.onload = null; image.onerror = null;
      if (!result) image.removeAttribute('src');
      resolve(result);
    };
    const abort = () => finish(null);
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight } : null);
    image.onerror = () => finish(null);
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => finish(null), timeoutMs);
    image.decoding = 'async';
    image.src = url;
  });
}

export async function runImagePreloadQueue(targets: ImagePreloadTarget[], {
  signal, concurrency = 3, load = loadPreloadImage, onLoaded,
}: {
  signal: AbortSignal;
  concurrency?: number;
  load?: ImageLoad;
  onLoaded?: (target: ImagePreloadTarget, dimensions: ImageDimensions) => void;
}): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!signal.aborted && next < targets.length) {
      const target = targets[next++];
      try {
        const dimensions = await load(target.requestUrl, signal);
        if (!signal.aborted && dimensions) onLoaded?.(target, dimensions);
      } catch {
        // A failed preview is local to this request; keep all owning records.
      }
    }
  };
  const count = Math.min(targets.length, Math.max(1, Math.floor(concurrency) || 1));
  await Promise.all(Array.from({ length: count }, worker));
}
