import { useEffect, useRef, useState } from "react";

import { rememberMediaDims } from "../media-dims";
import { toRenderableMediaUrl } from "../reference-media";
import { useStore } from "../store";

/**
 * Canvas entry gate. When entering a project, we show a brief fade-in overlay
 * that ACTUALLY does work: it waits for the canvas snapshot to load, then
 * preloads every node's image (warming the browser cache AND measuring each
 * one). For any node that is MISSING its stored dimensions, it writes them back
 * (updateNodeData) so the box is deterministic forever after — for the owner
 * that persists into the snapshot, so even read-only visitors load correct
 * sizes and nothing ever re-measures. It also fills the in-memory
 * mediaDimCache, so with onlyRenderVisibleElements a node that scrolls back into
 * view remounts at the right size instead of jumping.
 *
 * By the time it fades out the canvas reveals with correct node sizes and
 * images that pop in instantly — no measure-then-jump, no blank-then-load.
 * The gate is bounded (never blocks longer than MAX_PRELOAD_MS) but the
 * preloads keep running in the background afterwards, so the cache/persist
 * finish even on a large canvas.
 */
const MAX_PRELOAD_MS = 6000;
// Hard ceiling on step 1 (waiting for the canvas snapshot fetch) so a slow or
// stalled getCanvas can never leave the user stuck on the loading gate forever.
const MAX_SYNC_WAIT_MS = 8000;
const MIN_VISIBLE_MS = 550;
const FADE_MS = 500;

type MediaTarget = { nodeId: string; url: string; hasDims: boolean };

function collectMediaTargets(nodes: any[]): MediaTarget[] {
  const out: MediaTarget[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const d = n?.data ?? {};
    const hasDims = Number(d.mediaWidth) > 0 && Number(d.mediaHeight) > 0;
    for (const url of [d.url, d.poster, d.thumbnail]) {
      if (typeof url === "string" && /^(https?:|\/)/.test(url)) {
        const key = `${n.id}:${url}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ nodeId: n.id, url, hasDims });
        }
      }
    }
  }
  return out;
}

function preload(target: MediaTarget): Promise<void> {
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
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w > 0 && h > 0) {
        rememberMediaDims(target.url, w, h);
        // Persist dims back onto the node when it had none, so the box is
        // deterministic on every future load (owner → saved snapshot; anyone
        // → no re-measure). Guard on hasDims to avoid needless writes.
        if (!target.hasDims) {
          const node = useStore.getState().nodes.find((n) => n.id === target.nodeId);
          const nd = node?.data as Record<string, unknown> | undefined;
          if (nd && nd.url === target.url && !(Number(nd.mediaWidth) > 0 && Number(nd.mediaHeight) > 0)) {
            useStore.getState().updateNodeData(target.nodeId, { mediaWidth: w, mediaHeight: h });
          }
        }
      }
      done();
    };
    img.onerror = done; // videos / broken urls — skip
    img.src = toRenderableMediaUrl(target.url); // same request the node will make
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
      // 1) Wait for the snapshot fetch to finish (backendSyncing flips false) —
      //    BOUNDED so a slow/stalled getCanvas can never hang the gate forever
      //    on «加载画布…». After the deadline we reveal the canvas anyway; it
      //    fills in when the fetch eventually resolves.
      const syncDeadline = Date.now() + MAX_SYNC_WAIT_MS;
      while (!stale() && useStore.getState().backendSyncing && Date.now() < syncDeadline) {
        await wait(60);
      }
      if (stale()) return;

      // 2) Preload media — warm the browser + dimension caches, persist dims.
      //    The promises keep resolving in the background even after the gate
      //    lifts, so a large canvas still finishes prewarming.
      const targets = collectMediaTargets(useStore.getState().nodes as any[]);
      if (targets.length > 0) {
        let loaded = 0;
        await Promise.race([
          Promise.all(
            targets.map((t) =>
              preload(t).then(() => {
                loaded += 1;
                if (!stale()) setProgress(Math.round((loaded / targets.length) * 100));
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
