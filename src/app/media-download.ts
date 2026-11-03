import { toRenderableMediaUrl } from './reference-media';

export type MediaDownloadProgress = { loaded: number; total: number | null; attempt: number };

const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;
const mediaExtensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a',
};

export async function downloadMediaFile(
  src: string,
  filename: string,
  onProgress?: (progress: MediaDownloadProgress) => void,
): Promise<void> {
  const url = toRenderableMediaUrl(src);
  if (!url) throw new Error('素材还没有可下载的文件');

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      onProgress?.({ loaded: 0, total: null, attempt });
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        if (retryableStatus(response.status)) {
          throw new Error(`服务器暂时不可用（HTTP ${response.status}）`);
        }
        if (response.status === 401 || response.status === 403) throw new Error('登录已过期或没有下载权限，请刷新页面后重试');
        if (response.status === 404) throw new Error('原文件已不存在');
        throw new Error(`下载失败（HTTP ${response.status}）`);
      }
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (mime && mime !== 'application/octet-stream' && !/^(image|video|audio)\//.test(mime)) {
        await response.body?.cancel();
        throw new Error('服务器返回的不是媒体文件');
      }
      const length = Number(response.headers.get('content-length'));
      const total = Number.isFinite(length) && length > 0 ? length : null;
      let loaded = 0;
      let blob: Blob;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            onProgress?.({ loaded, total, attempt });
          }
        } finally {
          reader.releaseLock();
        }
        if (total !== null && loaded !== total) throw new Error('文件传输不完整');
        blob = new Blob(chunks as BlobPart[], { type: mime || undefined });
      } else {
        blob = await response.blob();
        loaded = blob.size;
        onProgress?.({ loaded, total, attempt });
      }
      if (!loaded) throw new Error('下载内容为空');
      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = objectUrl;
        const extension = mediaExtensions[mime];
        link.download = extension ? `${filename.replace(/\.[^.]+$/, '')}.${extension}` : filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        // Large video saves may not start immediately after the click returns.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      }
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : '';
      const permanent = /权限|登录|不存在|不是媒体文件|HTTP 4(?!08|29)/.test(message);
      if (permanent || attempt === 3) break;
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('下载失败，请稍后重试');
}
