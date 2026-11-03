import { useEffect, useState } from "react";
import { useStoreApi } from "@xyflow/react";

import ccyLogo from "../../imports/logo.png";
import { rememberMediaDims } from "../media-dims";
import { collectImagePreloadTargets, runImagePreloadQueue } from "../canvas-media-preload";
import { useStore } from "../store";

// The overlay reflects snapshot hydration only. Media warming never holds it
// open, and never blocks pointer input. Keep the existing visual treatment.
const MAX_SYNC_WAIT_MS = 8000;
const FADE_MS = 500;
const projectKeyOf = (state: ReturnType<typeof useStore.getState>) =>
  state.activeBackendProjectId ?? `${state.activeSpaceId}:${state.activeProjectId}`;

/** Mounted inside ReactFlowProvider so the one-shot prefetch reads actual
 * viewport geometry without subscribing every thumbnail to pan/zoom. */
export function CanvasLoader() {
  const projectKey = useStore(projectKeyOf);
  const syncing = useStore(state => state.backendSyncing);
  const flowStore = useStoreApi();
  const [visible, setVisible] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let frame = 0;
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeViewport: (() => void) | undefined;
    const reveal = () => {
      setProgress(100);
      setVisible(false);
      fadeTimer = setTimeout(() => setMounted(false), FADE_MS);
    };
    if (syncing) {
      setMounted(true); setVisible(true); setProgress(0);
      syncTimer = setTimeout(reveal, MAX_SYNC_WAIT_MS);
    } else {
      reveal();
      // Let ReactFlow apply the restored graph/fitView before sampling the
      // viewport. The canvas is already usable while these frames elapse.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (controller.signal.aborted) return;
          const state = useStore.getState();
          if (projectKeyOf(state) !== projectKey || state.backendSyncing) return;
          const flow = flowStore.getState();
          // Moving/resizing the viewport makes the remaining entry candidates
          // stale. Stop this optional queue; visible nodes load themselves.
          unsubscribeViewport = flowStore.subscribe((next, previous) => {
            if (next.width !== previous.width || next.height !== previous.height ||
              next.transform.some((value, index) => value !== previous.transform[index])) controller.abort();
          });
          const targets = collectImagePreloadTargets(state.nodes.map(node => {
            const internal = flow.nodeLookup.get(node.id);
            return { ...node, measured: internal?.measured ?? node.measured };
          }), { x: flow.transform[0], y: flow.transform[1], zoom: flow.transform[2], width: flow.width, height: flow.height });
          for (const node of state.nodes) {
            const data = node.data;
            if (Number(data.mediaWidth) > 0 && Number(data.mediaHeight) > 0) {
              rememberMediaDims(data.url, Number(data.mediaWidth), Number(data.mediaHeight));
            }
          }
          void runImagePreloadQueue(targets, {
            signal: controller.signal,
            onLoaded: (target, dimensions) => {
              if (!target.measureOriginal || controller.signal.aborted) return;
              const current = useStore.getState();
              if (projectKeyOf(current) !== projectKey || current.backendSyncing) return;
              rememberMediaDims(target.sourceUrl, dimensions.width, dimensions.height);
              for (const owner of target.owners) {
                rememberMediaDims(owner.url, dimensions.width, dimensions.height);
                if (!owner.measureOriginal) continue;
                const data = useStore.getState().nodes.find(node => node.id === owner.nodeId)?.data;
                if (data?.url === owner.url && !(Number(data.mediaWidth) > 0 && Number(data.mediaHeight) > 0)) {
                  useStore.getState().updateNodeData(owner.nodeId, { mediaWidth: dimensions.width, mediaHeight: dimensions.height });
                }
              }
            },
          }).finally(() => unsubscribeViewport?.());
        });
      });
    }
    return () => {
      controller.abort();
      unsubscribeViewport?.();
      cancelAnimationFrame(frame);
      if (fadeTimer) clearTimeout(fadeTimer);
      if (syncTimer) clearTimeout(syncTimer);
    };
  }, [projectKey, syncing, flowStore]);

  if (!mounted) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[160] flex items-center justify-center bg-[#16181c]"
      style={{
        opacity: visible ? 1 : 0,
        transition: `opacity ${FADE_MS}ms ease-out`,
        pointerEvents: "none",
      }}
      aria-hidden={!visible}
      aria-label="加载画布"
      aria-live="polite"
      role="status"
    >
      <div className="ccy-canvas-loader flex flex-col items-center">
        <div className="ccy-canvas-loader-logo-shell" aria-hidden="true">
          <img className="ccy-canvas-loader-logo" src={ccyLogo} alt="" />
        </div>
        <div
          className="ccy-canvas-loader-track"
          role="progressbar"
          aria-label="画布加载进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="ccy-canvas-loader-progress"
            style={{ width: `${Math.max(6, progress)}%` }}
          />
        </div>
        <span className="sr-only">加载画布…</span>
      </div>
    </div>
  );
}
