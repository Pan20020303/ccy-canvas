import type { Node } from '@xyflow/react';
import { resolveMediaDims } from '../../../media-dims';
import { extractOriginalMediaUrl } from '../../../reference-media';

export type MediaKind = 'image' | 'video';
export type PreviewItem = {
  id: string;
  nodeId?: string;
  kind: MediaKind;
  src: string;
  title: string;
  poster?: string;
  width?: number;
  height?: number;
  bytes?: number;
  prompt?: string;
};
export type MediaDimensions = { width: number; height: number };

const kinds: Record<string, MediaKind> = {
  imageNode: 'image', referenceImageNode: 'image',
  videoNode: 'video', referenceVideoNode: 'video',
};
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function nodePreviewItem(node: Node, zh = true): PreviewItem | null {
  const kind = kinds[node.type ?? ''];
  const data = node.data;
  const src = text(data.url);
  if (!kind || !src || node.hidden || data.status === 'uploading') return null;
  const dims = resolveMediaDims(data);
  return {
    id: node.id, nodeId: node.id, kind, src,
    title: text(data.customTitle) || text(data.sourceName) || (kind === 'image' ? (zh ? '图片生成' : 'Image') : (zh ? '视频生成' : 'Video')),
    poster: text(data.poster) || undefined,
    width: positive(dims?.w), height: positive(dims?.h),
    bytes: positive(data.fileSize) ?? positive(data.mediaSize),
    prompt: text(data.prompt) || undefined,
  };
}

/** Freeze the neighborhood at open time; refresh media data separately. No canvas writes. */
export function neighboringMediaIds(nodes: Node[], nodeId?: string): string[] {
  const anchor = nodes.find(node => node.id === nodeId);
  const candidates = nodes.filter(node => nodePreviewItem(node));
  if (!anchor) return [];
  return candidates
    .map((node, order) => ({ node, order, distance: Math.hypot(node.position.x - anchor.position.x, node.position.y - anchor.position.y) }))
    .sort((a, b) => Number(b.node.id === nodeId) - Number(a.node.id === nodeId) || a.distance - b.distance || a.order - b.order)
    .slice(0, 9)
    .sort((a, b) => a.node.position.y - b.node.position.y || a.node.position.x - b.node.position.x || a.order - b.order)
    .map(({ node }) => node.id);
}

export function fitImageZoom(dimensions: MediaDimensions, viewport: MediaDimensions, rotation = 0): number {
  const swap = Math.abs(rotation % 180) === 90;
  const w = swap ? dimensions.height : dimensions.width;
  const h = swap ? dimensions.width : dimensions.height;
  return w > 0 && h > 0 ? Math.min(viewport.width / w, viewport.height / h, 1) : 1;
}

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function formatMediaTime(seconds: number, precise = false): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const wholeSeconds = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${wholeSeconds}${precise ? `.${Math.floor((safe % 1) * 100).toString().padStart(2, '0')}` : ''}`;
}

export function formatMediaBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function previewDownloadName(item: PreviewItem): string {
  const url = extractOriginalMediaUrl(item.src).split(/[?#]/)[0];
  const extension = url.match(/\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v)$/i)?.[1]?.toLowerCase();
  const title = item.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v)$/i, '').slice(0, 100) || item.kind;
  return `${title}.${extension || (item.kind === 'image' ? 'png' : 'mp4')}`;
}

export function videoErrorMessage(code?: number, zh = true): string {
  if (zh) {
    if (code === 1) return '视频加载已中止，请重新加载。';
    if (code === 2) return '视频网络加载失败，请检查网络后重新加载。';
    if (code === 3) return '视频解码失败，文件可能损坏或编码不受支持。';
    if (code === 4) return '视频地址不可用，或浏览器不支持此视频格式。';
    return '视频加载失败，请重新加载或下载原文件查看。';
  }
  return ({ 1: 'Video loading was aborted.', 2: 'A network error interrupted the video.', 3: 'The video could not be decoded.', 4: 'The video source or format is not supported.' } as Record<number, string>)[code ?? 0] || 'Video loading failed. Reload or download the original file.';
}
