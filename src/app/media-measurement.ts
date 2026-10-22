import { extractOriginalMediaUrl, isLocalMediaThumbnailUrl, isProxyMediaUrl } from './reference-media';

/** Only a matching full-size response can establish original dimensions.
 * Thumbnail naturalWidth/naturalHeight remain useful for preview aspect. */
export function isOriginalImageResponse(source: string, loaded: string): boolean {
  if (!source || !loaded) return false;
  const base = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const normalize = (raw: string) => {
    const url = new URL(raw, base);
    url.searchParams.delete('_r'); // ResilientImage's retry cache buster
    return url.href;
  };
  try {
    for (const raw of [source, loaded]) {
      let current = raw;
      for (let depth = 0; depth < 6; depth++) {
        const url = new URL(current, base);
        if (isLocalMediaThumbnailUrl(current) || url.searchParams.has('w')) return false;
        if (!isProxyMediaUrl(current)) break;
        current = url.searchParams.get('url') || '';
        if (!current) return false;
      }
    }
    return normalize(extractOriginalMediaUrl(source)) === normalize(extractOriginalMediaUrl(loaded));
  } catch { return false; }
}
