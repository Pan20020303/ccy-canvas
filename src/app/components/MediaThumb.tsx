import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import clsx from 'clsx';

import { extractOriginalMediaUrl, toRenderableMediaUrl } from '../reference-media';

type ThumbProps = {
  src: string;
  alt?: string;
  className?: string;
  /** @deprecated Preview errors never delete records; this callback is ignored. */
  onDead?: () => void;
  /** Thumbnail size hint; local images use fixed cached tiers. */
  thumbWidth?: number;
};

/** Failed previews retain the tile and allow an explicit retry. The keyed
 * child also clears a previous failure when hydration replaces the source. */
export function MediaThumb({ src, alt, className, thumbWidth = 640 }: ThumbProps) {
  const primary = toRenderableMediaUrl(src, { thumbWidth });
  return <RetryableThumb key={primary} primary={primary} original={extractOriginalMediaUrl(src)} alt={alt} className={className} />;
}

export function MediaVideoThumb({ src, alt, className }: Omit<ThumbProps, 'thumbWidth'>) {
  const primary = toRenderableMediaUrl(src);
  return <RetryableThumb key={primary} video primary={primary} original={extractOriginalMediaUrl(src)} alt={alt} className={className} />;
}

function RetryableThumb({ primary, original, alt, className, video = false }: {
  primary: string; original: string; alt?: string; className?: string; video?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const retryLoad = () => { setAttempt(0); setFailed(false); setRetry(value => value + 1); };
  if (failed || !primary) {
    return (
      <div
        className={clsx('flex items-center justify-center bg-black/40 text-neutral-600', className)}
        role={failed ? 'button' : undefined}
        tabIndex={failed ? 0 : undefined}
        aria-label={failed ? `${alt || '素材'}加载失败，点击重试` : (alt || '暂无预览')}
        title={failed ? '素材加载失败，点击重试；原记录已保留' : undefined}
        onClick={failed ? event => { event.stopPropagation(); retryLoad(); } : undefined}
        onKeyDown={failed ? event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault(); event.stopPropagation(); retryLoad();
          }
        } : undefined}
      >
        <ImageOff className="h-6 w-6" />
      </div>
    );
  }
  // Never append a cache-busting query: it can invalidate signatures or corrupt
  // data:/blob: sources. Remount the exact resource for same-URL retries.
  const source = attempt === 0 ? primary : (original || primary);
  const onError = () => { if (attempt === 0) setAttempt(1); else setFailed(true); };
  return video ? (
    <video key={`${retry}:${attempt}`} src={source} aria-label={alt} className={className} muted playsInline preload="metadata" onError={onError} />
  ) : (
    <img key={`${retry}:${attempt}`} src={source} alt={alt} className={className} loading="lazy" decoding="async" onError={onError} />
  );
}
