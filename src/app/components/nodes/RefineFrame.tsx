import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, Loading03Icon, RefreshIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import './RefineFrame.css';

export type RefineFrameStatus = 'queued' | 'generating' | 'refining' | 'complete' | 'error';

type Stage = {
  blur: number;
  sat: number;
  scale: number;
  opacity: number;
};

type RefineFrameProps = {
  status?: RefineFrameStatus;
  children?: ReactNode;
  aspectRatio?: string;
  width?: number;
  radius?: number;
  background?: string;
  color?: string;
  stageDuration?: number;
  sweep?: boolean;
  showStatus?: boolean;
  hideAfter?: number;
  labels?: Partial<Record<RefineFrameStatus, string>>;
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
  /** Stable source identity used by the node overlay to avoid rebuilding the
   *  mosaic when unrelated timer/store updates re-render its parent. */
  mediaKey?: string;
};

type Simulation = {
  p: number;
  raf: number;
  last: number;
  key: string;
  w: number;
  h: number;
  levels: HTMLCanvasElement[];
  glint: CanvasGradient | null;
  sent: boolean;
};

const STAGES: Record<RefineFrameStatus, Stage> = {
  queued: { blur: 4, sat: 0.6, scale: 1.04, opacity: 0.55 },
  generating: { blur: 1.5, sat: 0.8, scale: 1.02, opacity: 0.85 },
  refining: { blur: 0.5, sat: 0.95, scale: 1.005, opacity: 1 },
  complete: { blur: 0, sat: 1, scale: 1, opacity: 1 },
  error: { blur: 2, sat: 0.5, scale: 1, opacity: 0.28 },
};
const TARGET: Partial<Record<RefineFrameStatus, number>> = {
  queued: 0,
  generating: 0.5,
  refining: 0.875,
  complete: 1,
};
const LEVELS = [48, 32, 20, 12, 8, 5, 3, 2, 1];
const EDGE = 28;
const STRIPS = 14;
const DEFAULT_LABELS: Record<RefineFrameStatus, string> = {
  queued: 'Queued',
  generating: 'Generating',
  refining: 'Refining',
  complete: 'Ready',
  error: 'Failed',
};
const ACTIVE = new Set<RefineFrameStatus>(['queued', 'generating', 'refining']);

const buildMosaic = (simulation: Simulation, canvas: HTMLCanvasElement, image: HTMLImageElement, dpr: number) => {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  const key = `${image.currentSrc || image.src}|${width}x${height}`;
  if (simulation.key === key) return;

  simulation.key = key;
  simulation.w = width;
  simulation.h = height;
  canvas.width = width;
  canvas.height = height;

  const imageWidth = image.naturalWidth;
  const imageHeight = image.naturalHeight;
  if (!imageWidth || !imageHeight) return;
  const cover = Math.max(width / imageWidth, height / imageHeight);
  const sourceWidth = width / cover;
  const sourceHeight = height / cover;
  const sourceX = (imageWidth - sourceWidth) / 2;
  const sourceY = (imageHeight - sourceHeight) / 2;
  const context = canvas.getContext('2d');
  const glint = context?.createLinearGradient(0, 0, width, 0) ?? null;
  if (glint) {
    for (const [position, alpha] of [
      [0, 0],
      [0.08, 0.1],
      [0.2, 0.7],
      [0.32, 1],
      [0.68, 1],
      [0.8, 0.7],
      [0.92, 0.1],
      [1, 0],
    ] as Array<[number, number]>) {
      glint.addColorStop(position, `rgba(255, 255, 255, ${alpha})`);
    }
  }
  simulation.glint = glint;
  simulation.levels = LEVELS.map((block) => {
    const blockSize = block === 1 ? 1 : Math.max(2, Math.round(block * dpr));
    const full = document.createElement('canvas');
    full.width = width;
    full.height = height;
    const fullContext = full.getContext('2d');
    if (!fullContext) return full;
    if (blockSize === 1) {
      fullContext.imageSmoothingEnabled = true;
      fullContext.imageSmoothingQuality = 'high';
      fullContext.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
      return full;
    }

    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(width / blockSize));
    small.height = Math.max(1, Math.round(height / blockSize));
    const smallContext = small.getContext('2d');
    if (smallContext) {
      smallContext.imageSmoothingEnabled = true;
      smallContext.imageSmoothingQuality = 'high';
      smallContext.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        small.width,
        small.height,
      );
    }
    fullContext.imageSmoothingEnabled = false;
    fullContext.drawImage(small, 0, 0, width, height);
    return full;
  });
};

export default function RefineFrame({
  status = 'generating',
  children,
  aspectRatio = '4 / 3',
  width = 320,
  radius = 16,
  background = '#27272a',
  color = '#f5f5f5',
  stageDuration = 400,
  sweep = true,
  showStatus = true,
  hideAfter = 1200,
  labels = DEFAULT_LABELS,
  retryLabel = 'Retry',
  onRetry,
  className = '',
  mediaKey,
}: RefineFrameProps) {
  const stage = STAGES[status] ?? STAGES.generating;
  const active = ACTIVE.has(status);
  const text = { ...DEFAULT_LABELS, ...labels };
  const printRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simulation = useRef<Simulation>({
    p: 0,
    raf: 0,
    last: 0,
    key: '',
    w: 0,
    h: 0,
    levels: [],
    glint: null,
    sent: false,
  });
  const live = useRef({ status, stageDuration, sweep, reduce: false });
  live.current = { ...live.current, status, stageDuration, sweep };
  const [mosaic, setMosaic] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [chip, setChip] = useState(showStatus);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!showStatus) {
      setChip(false);
      return undefined;
    }
    setChip(true);
    if (status === 'complete' && hideAfter > 0) {
      timer.current = setTimeout(() => setChip(false), hideAfter);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [status, showStatus, hideAfter]);

  const tick = (now: number) => {
    const current = simulation.current;
    const config = live.current;
    const canvas = canvasRef.current;
    const image = printRef.current?.querySelector('img');
    if (!canvas || !image || !image.naturalWidth) {
      current.raf = 0;
      return;
    }

    const delta = Math.min(0.05, current.last ? (now - current.last) / 1000 : 0.016);
    current.last = now;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    buildMosaic(current, canvas, image, dpr);
    const maxLevel = current.levels.length - 1;
    if (maxLevel < 0) {
      current.raf = 0;
      return;
    }
    const target = TARGET[config.status] ?? current.p;
    const rate = config.reduce ? 1e9 : 1 / (Math.max(1, maxLevel) * (config.stageDuration / 1000));
    const step = rate * delta;
    if (target < current.p) current.p = target;
    else if (target - current.p <= step) current.p = target;
    else current.p += step;

    const context = canvas.getContext('2d');
    if (context) {
      const level = current.p * maxLevel;
      const index = Math.min(maxLevel, Math.floor(level + 1e-6));
      const fraction = level - index;
      context.globalAlpha = 1;
      context.drawImage(current.levels[index], 0, 0);
      if (index < maxLevel && fraction > 0) {
        const edge = EDGE * dpr;
        const front = fraction * (current.h + edge) - edge / 2;
        const top = Math.max(0, Math.floor(front - edge / 2));
        if (top > 0) {
          context.drawImage(current.levels[index + 1], 0, 0, current.w, top, 0, 0, current.w, top);
        }
        const stripHeight = edge / STRIPS;
        for (let strip = 0; strip < STRIPS; strip += 1) {
          const y = front - edge / 2 + strip * stripHeight;
          if (y + stripHeight <= 0 || y >= current.h) continue;
          const progress = 1 - (strip + 0.5) / STRIPS;
          context.globalAlpha = progress * progress * (3 - 2 * progress);
          const sourceY = Math.max(0, y);
          const height = Math.min(current.h, y + stripHeight) - sourceY;
          if (height > 0) {
            context.drawImage(
              current.levels[index + 1],
              0,
              sourceY,
              current.w,
              height,
              0,
              sourceY,
              current.w,
              height,
            );
          }
        }
        context.globalAlpha = 1;
        if (config.sweep && !config.reduce && current.glint && front > 0 && front < current.h) {
          context.fillStyle = current.glint;
          context.globalAlpha = 0.12;
          context.fillRect(0, front - 2 * dpr, current.w, 4 * dpr);
          context.globalAlpha = 0.3;
          context.fillRect(0, front - dpr, current.w, 2 * dpr);
          context.globalAlpha = 1;
        }
      }
    }

    const done = current.p >= 1;
    if (done !== current.sent) {
      current.sent = done;
      setResolved(done);
    }
    const keepRunning = Math.abs(target - current.p) > 0.0005;
    current.raf = keepRunning ? requestAnimationFrame(tick) : 0;
    if (!keepRunning) current.last = 0;
  };

  const wake = () => {
    const current = simulation.current;
    if (!current.raf) current.raf = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      live.current.reduce = mediaQuery.matches;
    };
    sync();
    mediaQuery.addEventListener?.('change', sync);
    return () => mediaQuery.removeEventListener?.('change', sync);
  }, []);

  useEffect(() => {
    const image = printRef.current?.querySelector('img');
    if (!image) {
      setMosaic(false);
      setResolved(false);
      return undefined;
    }
    let disposed = false;
    const start = () => {
      if (disposed) return;
      setMosaic(true);
      simulation.current.key = '';
      wake();
    };
    if (image.complete && image.naturalWidth) start();
    else image.addEventListener('load', start, { once: true });
    return () => {
      disposed = true;
      image.removeEventListener('load', start);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey, status]);

  useEffect(() => {
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, width, aspectRatio]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      simulation.current.key = '';
      wake();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = simulation.current;
    return () => cancelAnimationFrame(current.raf);
  }, []);

  const style = {
    '--rf-w': `${width}px`,
    '--rf-aspect': aspectRatio,
    '--rf-radius': `${radius}px`,
    '--rf-bg': background,
    '--rf-ink': color,
    '--rf-stage': `${stageDuration}ms`,
    '--rf-blur': `${mosaic ? 0 : stage.blur}px`,
    '--rf-sat': stage.sat,
    '--rf-scale': mosaic ? 1 : stage.scale,
    '--rf-opacity': stage.opacity,
  } as CSSProperties;

  return (
    <div
      className={`refine-frame${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={text[status] ?? status}
      aria-busy={active || undefined}
      data-status={status}
      data-active={active ? '' : undefined}
      data-sweep={sweep && active ? '' : undefined}
      data-mosaic={mosaic ? '' : undefined}
      data-resolved={mosaic && resolved ? '' : undefined}
      style={style}
    >
      <div className="refine-frame__media" aria-hidden="true">
        <div ref={printRef} className="refine-frame__print">
          {children}
        </div>
        <canvas ref={canvasRef} className="refine-frame__mosaic" />
      </div>
      <div className="refine-frame__lightfield" aria-hidden="true" />
      <div className="refine-frame__edge-light" aria-hidden="true" />
      <div className="refine-frame__sweep" aria-hidden="true" />
      {chip ? (
        <div className="refine-frame__chip" aria-hidden="true">
          <span className="refine-frame__mark" data-kind={active ? 'spin' : status}>
            {status === 'complete' ? (
              <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.5} />
            ) : status === 'error' ? (
              <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={2.2} />
            ) : (
              <HugeiconsIcon icon={Loading03Icon} size={13} strokeWidth={2.2} />
            )}
          </span>
          <span key={status} className="refine-frame__label">
            {text[status] ?? status}
          </span>
        </div>
      ) : null}
      {status === 'error' && onRetry ? (
        <button type="button" className="refine-frame__retry" onClick={onRetry}>
          <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={2.2} />
          <span>{retryLabel}</span>
        </button>
      ) : null}
      <span className="refine-frame__sr" role="status">
        {text[status] ?? status}
      </span>
    </div>
  );
}
