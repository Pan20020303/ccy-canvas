import { useEffect, useRef } from "react";
import type { Node, Edge } from "@xyflow/react";

import { resolveApiUrl } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { useStore, useActiveProjectReadOnly, stripHeavyFromNodeData, type Group } from "../store";

/**
 * Real-time canvas sync (Tier: collaborative editing). Broadcasts the local
 * user's node/edge/group edits to everyone else in the project room over SSE and
 * applies incoming ones, so collaborators see edits LIVE and their states
 * CONVERGE — which also stops the full-snapshot autosave from silently
 * clobbering a peer's concurrent edits (both sides already hold everyone's work
 * before they save). Best-effort: a missed frame resyncs on the next save/load.
 *
 * Correctness hinges on a BASELINE (per-entity signature map):
 *  - Local publish = diff(current, baseline) → broadcast the delta, rebaseline.
 *  - Remote apply  = apply the delta, then rebaseline from it, so the publish
 *    diff never treats a remote change as our own edit and echoes it back.
 * Local-only fields (selection/drag/measured size) are stripped so one user's
 * selection never lands on another's canvas.
 */

export type CanvasDelta = {
  nodesUpsert?: Node[];
  nodesRemove?: string[];
  edgesUpsert?: Edge[];
  edgesRemove?: string[];
  groupsUpsert?: Group[];
  groupsRemove?: string[];
};

// WHITELIST the fields that cross the wire / drive the change signature. A
// blacklist is unsafe here: ReactFlow keeps writing back COMPUTED fields
// (measured, positionAbsolute, width/height, selected, dragging, …) that aren't
// in our broadcast, so after applying a peer's edit our local RF re-adds them,
// the signature changes, and we re-broadcast — an infinite A↔B ping-pong that
// makes both canvases flicker. Only user-meaningful fields belong here; heavy
// media in data is stripped so a 5 MB base64 node can't blow the POST cap.
function sanitizeNode(n: Node): Node {
  const out: Record<string, unknown> = {
    id: n.id,
    type: n.type,
    position: n.position,
    data: stripHeavyFromNodeData(n.data),
  };
  const extra = n as unknown as Record<string, unknown>;
  if (extra.parentId != null) out.parentId = extra.parentId;
  if (extra.zIndex != null) out.zIndex = extra.zIndex;
  if (extra.style != null) out.style = extra.style;
  return out as unknown as Node;
}
function sanitizeEdge(e: Edge): Edge {
  const out: Record<string, unknown> = {
    id: e.id,
    source: e.source,
    target: e.target,
  };
  const extra = e as unknown as Record<string, unknown>;
  if (extra.type != null) out.type = extra.type;
  if (extra.sourceHandle != null) out.sourceHandle = extra.sourceHandle;
  if (extra.targetHandle != null) out.targetHandle = extra.targetHandle;
  if (extra.data != null) out.data = extra.data;
  if (extra.style != null) out.style = extra.style;
  return out as unknown as Edge;
}

// djb2 — a tiny content hash so two DIFFERENT long strings never collide (a
// length-only fingerprint could, silently dropping a real edit's broadcast).
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return "h" + (h >>> 0).toString(36);
}

// Cheap change-detecting signature. Long strings hash by CONTENT (not length),
// and heavy media is already stripped by sanitizeNode, so this stays light.
function sig(v: unknown): string {
  return (
    JSON.stringify(v, (_k, val) => (typeof val === "string" && val.length > 256 ? hashString(val) : val)) ?? ""
  );
}

export type Baseline = {
  nodes: Map<string, string>;
  edges: Map<string, string>;
  groups: Map<string, string>;
};
export function emptyBaseline(): Baseline {
  return { nodes: new Map(), edges: new Map(), groups: new Map() };
}

/**
 * Diff current store state vs baseline → the delta THIS client changed. Mutates
 * baseline to the new state. Returns null when nothing changed.
 */
export function diffAgainstBaseline(nodes: Node[], edges: Edge[], groups: Group[], base: Baseline): CanvasDelta | null {
  const delta: CanvasDelta = {};

  const nodesUpsert: Node[] = [];
  const seenN = new Set<string>();
  for (const raw of nodes) {
    const n = sanitizeNode(raw);
    seenN.add(n.id);
    const s = sig(n);
    if (base.nodes.get(n.id) !== s) { nodesUpsert.push(n); base.nodes.set(n.id, s); }
  }
  const nodesRemove: string[] = [];
  for (const id of [...base.nodes.keys()]) if (!seenN.has(id)) { nodesRemove.push(id); base.nodes.delete(id); }

  const edgesUpsert: Edge[] = [];
  const seenE = new Set<string>();
  for (const raw of edges) {
    const e = sanitizeEdge(raw);
    seenE.add(e.id);
    const s = sig(e);
    if (base.edges.get(e.id) !== s) { edgesUpsert.push(e); base.edges.set(e.id, s); }
  }
  const edgesRemove: string[] = [];
  for (const id of [...base.edges.keys()]) if (!seenE.has(id)) { edgesRemove.push(id); base.edges.delete(id); }

  const groupsUpsert: Group[] = [];
  const seenG = new Set<string>();
  for (const g of groups) {
    seenG.add(g.id);
    const s = sig(g);
    if (base.groups.get(g.id) !== s) { groupsUpsert.push(g); base.groups.set(g.id, s); }
  }
  const groupsRemove: string[] = [];
  for (const id of [...base.groups.keys()]) if (!seenG.has(id)) { groupsRemove.push(id); base.groups.delete(id); }

  if (nodesUpsert.length) delta.nodesUpsert = nodesUpsert;
  if (nodesRemove.length) delta.nodesRemove = nodesRemove;
  if (edgesUpsert.length) delta.edgesUpsert = edgesUpsert;
  if (edgesRemove.length) delta.edgesRemove = edgesRemove;
  if (groupsUpsert.length) delta.groupsUpsert = groupsUpsert;
  if (groupsRemove.length) delta.groupsRemove = groupsRemove;

  return Object.keys(delta).length ? delta : null;
}

/** After applying a REMOTE delta, fold it into the baseline (from the NEW store
 *  state) so the local publish diff won't echo the remote change back. */
export function rebaselineFromDelta(delta: CanvasDelta, nodes: Node[], edges: Edge[], groups: Group[], base: Baseline): void {
  const nById = new Map(nodes.map((n) => [n.id, n]));
  const eById = new Map(edges.map((e) => [e.id, e]));
  const gById = new Map(groups.map((g) => [g.id, g]));
  for (const n of delta.nodesUpsert ?? []) { const cur = nById.get(n.id); if (cur) base.nodes.set(n.id, sig(sanitizeNode(cur))); }
  for (const id of delta.nodesRemove ?? []) base.nodes.delete(id);
  for (const e of delta.edgesUpsert ?? []) { const cur = eById.get(e.id); if (cur) base.edges.set(e.id, sig(sanitizeEdge(cur))); }
  for (const id of delta.edgesRemove ?? []) base.edges.delete(id);
  for (const g of delta.groupsUpsert ?? []) { const cur = gById.get(g.id); if (cur) base.groups.set(g.id, sig(cur)); }
  for (const id of delta.groupsRemove ?? []) base.groups.delete(id);
}

// ── SSE downstream + POST upstream ─────────────────────────────────────────

function startCanvasStream(projectId: string, onEvent: (uid: string, delta: CanvasDelta) => void): () => void {
  const url = resolveApiUrl(`/api/app/projects/${projectId}/canvas/stream`);
  let source: EventSource | null = null;
  try {
    source = new EventSource(url, { withCredentials: true });
  } catch {
    return () => {};
  }
  source.onmessage = (e) => {
    try {
      const frame = JSON.parse(e.data) as { uid?: string; ops?: CanvasDelta };
      if (frame?.uid && frame.ops) onEvent(frame.uid, frame.ops);
    } catch { /* ignore malformed frame */ }
  };
  return () => { try { source?.close(); } catch { /* ignore */ } };
}

async function broadcastCanvasDelta(projectId: string, delta: CanvasDelta): Promise<boolean> {
  try {
    const resp = await fetch(resolveApiUrl(`/api/app/projects/${projectId}/canvas/ops`), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops: delta }),
    });
    return resp.ok; // 204 No Content is ok
  } catch {
    return false; // best-effort; caller re-dirties so the delta retries next cycle
  }
}

/**
 * Mount inside the Canvas. Opens the room, applies remote deltas, and publishes
 * local edits (debounced). Visitors (read-only) still SUBSCRIBE to watch live
 * but never broadcast. Gated on canvasHydrated so we never sync a half-loaded
 * canvas.
 */
export function useCanvasSync(): void {
  const { user } = useAuth();
  const activeId = useStore((s) => s.activeBackendProjectId);
  const readOnly = useActiveProjectReadOnly();
  const canvasHydrated = useStore((s) => s.canvasHydrated);
  const applyRemoteCanvasDelta = useStore((s) => s.applyRemoteCanvasDelta);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const groups = useStore((s) => s.groups);

  const uid = user?.id ?? "";
  const baselineRef = useRef<Baseline>(emptyBaseline());

  // Open the room + apply remote deltas. Re-seed baseline on (re)subscribe from
  // the current state so the first local diff doesn't rebroadcast everything.
  useEffect(() => {
    if (!activeId || !uid || !canvasHydrated) return;
    const base = emptyBaseline();
    const s0 = useStore.getState();
    diffAgainstBaseline(s0.nodes, s0.edges, s0.groups, base); // seed (discard result)
    baselineRef.current = base;

    const stop = startCanvasStream(activeId, (fromUid, delta) => {
      if (fromUid === uid) return; // echo suppression
      applyRemoteCanvasDelta(delta);
      // Rebaseline from the post-apply store state so the publish diff below
      // does NOT re-broadcast what we just applied (prevents ping-pong).
      const s = useStore.getState();
      rebaselineFromDelta(delta, s.nodes, s.edges, s.groups, baselineRef.current);
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, uid, canvasHydrated]);

  // Publish local edits (debounced diff vs baseline). Visitors never broadcast.
  useEffect(() => {
    if (!activeId || !uid || readOnly || !canvasHydrated) return;
    const t = setTimeout(() => {
      const base = baselineRef.current;
      const s = useStore.getState();
      // diffAgainstBaseline OPTIMISTICALLY advances the baseline. If the POST
      // fails (network, 4 MB cap), re-dirty the delta's ids so the next diff
      // recomputes + retries them — otherwise the advanced baseline would hide
      // the change forever (silent divergence).
      const delta = diffAgainstBaseline(s.nodes, s.edges, s.groups, base);
      if (!delta) return;
      void broadcastCanvasDelta(activeId, delta).then((ok) => {
        if (ok) return;
        for (const n of delta.nodesUpsert ?? []) base.nodes.delete(n.id);
        for (const e of delta.edgesUpsert ?? []) base.edges.delete(e.id);
        for (const g of delta.groupsUpsert ?? []) base.groups.delete(g.id);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [nodes, edges, groups, activeId, uid, readOnly, canvasHydrated]);
}
