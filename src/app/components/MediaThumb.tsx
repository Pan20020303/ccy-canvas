import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import clsx from 'clsx';

import { toRenderableMediaUrl } from '../reference-media';
import { reportDeadMedia, isCertainlyDeadSrc } from '../dead-media';

/**
 * Self-healing + self-cleaning thumbnail for history / asset tiles.
 *
 * - Empty src → treated as immediately dead.
 * - Load error → retries ONCE (re-mount, which also swaps a remote URL to the
 *   media proxy via toRenderableMediaUrl); a second failure marks it dead.
 * - When an entry is dead AND we're online, `onDead()` fires so the caller can
 *   auto-remove the unloadable entry (list + backend). We gate on
 *   `navigator.onLine` so a transient offline blip can't nuke the whole library.
 *
 * This is why the "clean up lost data" requirement needs no separate sweep:
 * anything that can't render self-reports and is pruned on view.
 */
export function MediaThumb({
  src,
  alt,
  className,
  onDead,
}: {
  src: string;
  alt?: string;
  className?: string;
  onDead?: () => void;
}) {
  const rendered = useMemo(() => (src ? toRenderableMediaUrl(src) : ''), [src]);
  const [attempt, setAttempt] = useState(0);
  const [dead, setDead] = useState(!src);
  const firedRef = useRef(false);

  const markDead = () => {
    setDead(true);
    if (firedRef.current) return;
    firedRef.current = true;
    // Empty / blob: src can never load → certain; a remote/relative load error is
    // uncertain (could be a server blip) and is budget-limited by the guard.
    reportDeadMedia(isCertainlyDeadSrc(src), () => onDead?.());
  };

  // An empty src is certainly dead — report it once on mount.
  useEffect(() => {
    if (!src) markDead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (dead || !rendered) {
    return (
      <div className={clsx('flex items-center justify-center bg-black/40 text-neutral-600', className)}>
        <ImageOff className="h-6 w-6" />
      </div>
    );
  }

  return (
    <img
      key={attempt}
      src={rendered}
      alt={alt}
      className={className}
      onError={() => {
        if (attempt === 0) {
          setAttempt(1); // one retry via a fresh load
          return;
        }
        markDead();
      }}
    />
  );
}
