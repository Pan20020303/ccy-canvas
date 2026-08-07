// Live-collaboration presence: a SELF-CONTAINED store + SSE connection +
// throttled reporter, deliberately kept OUT of the main Zustand store so that
// high-frequency cursor updates never trigger app-wide re-renders and never
// touch persistence / canvas snapshots. Presence is purely ephemeral UI.
import { create } from "zustand";

import { colorForUid } from "./color";

export type RemotePresence = {
  uid: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
  selection: string[];
  activity?: { kind?: string; nodeIds?: string[] } | null;
  lastSeen: number;
};

type WireEvent = {
  type?: string; // "presence" | "leave"
  uid?: string;
  name?: string;
  color?: string;
  cursor?: { x: number; y: number } | null;
  selection?: string[];
  activity?: { kind?: string; node_ids?: string[] } | null;
};

type PresenceStore = {
  byUid: Record<string, RemotePresence>;
  apply: (ev: WireEvent, selfUid: string) => void;
  clear: () => void;
  reapStale: () => void;
};

const STALE_MS = 12000;

export const usePresenceStore = create<PresenceStore>((set, get) => ({
  byUid: {},
  apply: (ev, selfUid) => {
    if (!ev?.uid || ev.uid === selfUid) return; // never render ourselves
    if (ev.type === "leave") {
      if (!get().byUid[ev.uid]) return;
      set((s) => {
        const next = { ...s.byUid };
        delete next[ev.uid!];
        return { byUid: next };
      });
      return;
    }
    set((s) => ({
      byUid: {
        ...s.byUid,
        [ev.uid!]: {
          uid: ev.uid!,
          name: ev.name ?? "",
          color: ev.color || colorForUid(ev.uid),
          cursor: ev.cursor ?? undefined,
          selection: Array.isArray(ev.selection) ? ev.selection : [],
          activity: ev.activity
            ? { kind: ev.activity.kind, nodeIds: ev.activity.node_ids ?? [] }
            : null,
          lastSeen: Date.now(),
        },
      },
    }));
  },
  clear: () => set({ byUid: {} }),
  reapStale: () => {
    const cutoff = Date.now() - STALE_MS;
    const cur = get().byUid;
    let changed = false;
    const next: Record<string, RemotePresence> = {};
    for (const [uid, p] of Object.entries(cur)) {
      if (p.lastSeen >= cutoff) next[uid] = p;
      else changed = true;
    }
    if (changed) set({ byUid: next });
  },
}));

// ─── Connection + reporting ──────────────────────────────────────────────────

function apiBase(): string {
  return (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
}

let es: EventSource | null = null;
let currentProject: string | null = null;
let selfUid = "";
let reconnectTimer: number | null = null;
let reapTimer: number | null = null;
let heartbeatTimer: number | null = null;

// Latest self state we report; heartbeat re-sends it so our roster entry
// doesn't expire while we sit still.
let liveState: {
  cursor?: { x: number; y: number };
  selection?: string[];
  activity?: { kind: string; nodeIds: string[] } | null;
} = {};
let selfName = "";
let selfColor = "";
let readonly = false;

let sendTimer: number | null = null;
const SEND_INTERVAL = 60; // ms → ~16Hz max upstream

function flushReport() {
  sendTimer = null;
  if (!currentProject || readonly) return;
  const body = {
    name: selfName,
    color: selfColor,
    cursor: liveState.cursor ?? null,
    selection: liveState.selection ?? [],
    activity: liveState.activity
      ? { kind: liveState.activity.kind, node_ids: liveState.activity.nodeIds }
      : null,
  };
  void fetch(`${apiBase()}/api/app/projects/${currentProject}/presence`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

function scheduleReport() {
  if (sendTimer != null) return;
  sendTimer = window.setTimeout(flushReport, SEND_INTERVAL);
}

/** Merge a presence patch and schedule a throttled upstream report. No-op for
 *  read-only visitors (they watch but never broadcast). */
export function updatePresence(patch: Partial<typeof liveState>) {
  if (readonly || !currentProject) return;
  liveState = { ...liveState, ...patch };
  scheduleReport();
}

/** Start (or switch to) the presence stream for a project. `isReadonly` = a
 *  visitor: they still subscribe to see others, but never report. */
export function startPresence(projectId: string, uid: string, name: string, color: string, isReadonly: boolean) {
  if (currentProject === projectId && es) {
    selfName = name;
    selfColor = color;
    readonly = isReadonly;
    return;
  }
  stopPresence();
  currentProject = projectId;
  selfUid = uid;
  selfName = name;
  selfColor = color;
  readonly = isReadonly;
  liveState = {};

  const connect = () => {
    if (currentProject !== projectId) return;
    es = new EventSource(`${apiBase()}/api/app/projects/${projectId}/presence/stream`, {
      withCredentials: true,
    });
    es.onmessage = (msg) => {
      try {
        usePresenceStore.getState().apply(JSON.parse(msg.data) as WireEvent, selfUid);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (currentProject === projectId && reconnectTimer == null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 3000);
      }
    };
  };
  connect();

  // Heartbeat so our roster entry stays alive while idle.
  heartbeatTimer = window.setInterval(() => {
    if (!readonly && currentProject === projectId) flushReport();
  }, 5000);
  // Locally reap ghosts whose leave frame was missed.
  reapTimer = window.setInterval(() => usePresenceStore.getState().reapStale(), 4000);
}

export function stopPresence() {
  es?.close();
  es = null;
  currentProject = null;
  if (reconnectTimer != null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatTimer != null) { window.clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (reapTimer != null) { window.clearInterval(reapTimer); reapTimer = null; }
  if (sendTimer != null) { window.clearTimeout(sendTimer); sendTimer = null; }
  liveState = {};
  usePresenceStore.getState().clear();
}
