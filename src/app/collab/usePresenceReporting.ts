import { useEffect, useMemo } from "react";
import { useReactFlow } from "@xyflow/react";

import { useAuth } from "../auth/AuthProvider";
import { useStore, useActiveProjectReadOnly } from "../store";
import { colorForUid } from "./color";
import { startPresence, stopPresence, updatePresence } from "./presence-store";

/**
 * Wires the LOCAL user's presence to the active project: opens the SSE room,
 * reports cursor (throttled inside presence-store) + selection, and stops on
 * project change / unmount. Visitors (read-only) get the stream to WATCH others
 * but never report — enforced here and again on the server. Call inside the
 * Canvas (needs ReactFlowProvider for screenToFlowPosition).
 *
 * Drag activity (Tier 3) is reported from Canvas's own drag handlers.
 */
export function usePresenceReporting() {
  const { user } = useAuth();
  const activeId = useStore((s) => s.activeBackendProjectId);
  const readOnly = useActiveProjectReadOnly();
  const { screenToFlowPosition } = useReactFlow();
  const nodes = useStore((s) => s.nodes);

  const uid = user?.id ?? "";
  const name = user?.name || user?.email || "协作者";

  // Open / switch / close the project presence room.
  useEffect(() => {
    if (!activeId || !uid) {
      stopPresence();
      return;
    }
    startPresence(activeId, uid, name, colorForUid(uid), readOnly);
    return () => stopPresence();
  }, [activeId, uid, name, readOnly]);

  // Cursor — flow coords (zoom/pan independent); throttled to ~16Hz downstream.
  useEffect(() => {
    if (!activeId || readOnly || !uid) return;
    const onMove = (e: PointerEvent) => {
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      updatePresence({ cursor: { x: p.x, y: p.y } });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [activeId, readOnly, uid, screenToFlowPosition]);

  // Selection — event-driven (only when the selected set actually changes).
  const selectionKey = useMemo(
    () =>
      nodes
        .filter((n) => (n as { selected?: boolean }).selected)
        .map((n) => n.id)
        .sort()
        .join(","),
    [nodes],
  );
  useEffect(() => {
    if (!activeId || readOnly || !uid) return;
    updatePresence({ selection: selectionKey ? selectionKey.split(",") : [] });
  }, [selectionKey, activeId, readOnly, uid]);
}
