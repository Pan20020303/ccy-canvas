import { useEffect, useRef, useState } from "react";

import { rememberMediaDims } from "../media-dims";
import { toRenderableMediaUrl } from "../reference-media";
import { useStore } from "../store";

/**
 * Canvas entry gate. When entering a project, we show a brief fade-in overlay
 * that ACTUALLY does work: it waits for the canvas snapshot to load, then
 * preloads every node's media (warming the browser cache AND measuring each
 * image into the shared mediaDimCache). By the time it fades out, the canvas
 * reveals with correct node sizes and images that pop in instantly — no
 * measure-then-jump, no blank-then-load.
 *
 * The gate is bounded (never blocks longer than MAX_PRELOAD_MS) and honors a
 * short minimum so the fade reads as intentional rather than a flash.
 */
const MAX_PRELOAD_MS = 6000;
const MIN_VISIBLE_MS = 550;
const FADE_MS = 500;

function collectMediaUrls(nodes: any[]): string[] {
  const urls = new Set<string>();
  for (const n of nodes) {
    const d = n?.data ?? {};
    for (const candidate of [d.url, d.poster, d.thumbnail]) {
      if (typeof candidate === "string" && /^(https?:|\/)/.test(candidate)) {
        urls.add(candidate);
      }
    }
  }
  return [...urls];
}

function preloadImage(rawUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        rememberMediaDims(rawUrl, img.naturalWidth, img.naturalHeight);
      }
      done();
    };
    img.onerror = done;
    img.src = toRenderableMediaUrl(rawUrl); // same request the node will make
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function CanvasLoader() {
  const activeId = useStore((s) => s.activeBackendProjectId);
  const [visible, setVisible] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [progress, setProgress] = useState(0);
  const runRef = useRef(0);

  useEffect(() => {
    const runId = ++runRef.current;
    let cancelled = false;
    setMounted(true);
    setVisible(true);
    setProgress(0);
    const start = Date.now();

    const stale = () => cancelled || runId !== runRef.current;

    const run = async () => {
      // 1) Wait for the snapshot fetch to finish (backendSyncing flips false).
      while (!stale() && useStore.getState().backendSyncing) {
        await wait(60);
      }
      if (stale()) return;

      // 2) Preload media — warm the browser cache and the dimension cache.
      const urls = collectMediaUrls(useStore.getState().nodes as any[]);
      if (urls.length > 0) {
        let loaded = 0;
        await Promise.race([
          Promise.all(
            urls.map((u) =>
              preloadImage(u).then(() => {
                loaded += 1;
                if (!stale()) setProgress(Math.round((loaded / urls.length) * 100));
              }),
            ),
          ),
          wait(MAX_PRELOAD_MS),
        ]);
      }
      if (stale()) return;

      // 3) Honor the minimum so the fade is a graceful reveal, not a flash.
      const elapsed = Date.now() - start;
      if (elapsed < MIN_VISIBLE_MS) await wait(MIN_VISIBLE_MS - elapsed);
      if (stale()) return;

      setVisible(false);
      await wait(FADE_MS);
      if (!stale()) setMounted(false);
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  if (!mounted) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[160] flex items-center justify-center bg-[#16181c]"
      style={{
        opacity: visible ? 1 : 0,
        transition: `opacity ${FADE_MS}ms ease-out`,
        pointerEvents: visible ? "auto" : "none",
      }}
      aria-hidden={!visible}
    >
      <div className="flex flex-col items-center gap-4">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/12 border-t-white/70" />
        <div className="text-[12.5px] tracking-[0.3em] text-white/55">加载画布…</div>
        <div className="h-[3px] w-40 overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full rounded-full bg-white/55 transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(6, progress)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
