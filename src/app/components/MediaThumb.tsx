import { useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import clsx from 'clsx';

import { toRenderableMediaUrl } from '../reference-media';
import { reportDeadMedia, isCertainlyDeadSrc } from '../dead-media';

/**
 * Self-healing + self-cleaning thumbnail for history / asset tiles.
 *
 * - Empty src → placeholder only, NEVER reported dead. A blank url usually
 *   means the persist layer stripped a heavy data:/blob: value locally while
 *   the server still holds the real copy (hydrate will restore it) — deleting
 *   on sight destroyed exactly those assets.
 * - Load error → retries ONCE with an ALTERNATE url (raw src if the first
 *   attempt was proxied, else a cache-busted reload); a second failure marks
 *   it dead.
 * - When an entry is dead AND we're online, `onDead()` fires so the caller can
 *   auto-remove the unloadable entry (list + backend). Guarded by
 *   `navigator.onLine` plus a per-session budget so a transient outage can't
 *   nuke the whole library.
 */
export function MediaThumb({
  src,
  alt,
  className,
  onDead,
  thumbWidth = 640,
}: {
  src: string;
  alt?: string;
  className?: string;
  onDead?: () => void;
  /** Request a downsized WebP thumbnail from the proxy (OSS images only; other
   *  sources fall back to the original). Set 0 to always load full-res. */
  thumbWidth?: number;
}) {
  const primary = useMemo(() => (src ? toRenderableMediaUrl(src, { thumbWidth }) : ''), [src, thumbWidth]);
  const fallback = useMemo(() => {
    if (!src) return '';
    if (primary !== src) return src; // proxied first — retry direct
    return `${primary}${primary.includes('?') ? '&' : '?'}mtretry=1`;
  }, [primary, src]);
  const [attempt, setAttempt] = useState(0);
  const [dead, setDead] = useState(false);

  if (dead || !primary) {
    return (
      <div className={clsx('flex items-center justify-center bg-black/40 text-neutral-600', className)}>
        <ImageOff className="h-6 w-6" />
      </div>
    );
  }

  return (
    <img
      key={attempt}
      src={attempt === 0 ? primary : fallback}
      alt={alt}
      className={className}
      onError={() => {
        if (attempt === 0) {
          setAttempt(1);
          return;
        }
        setDead(true);
        reportDeadMedia(isCertainlyDeadSrc(src), () => onDead?.());
      }}
    />
  );
}
