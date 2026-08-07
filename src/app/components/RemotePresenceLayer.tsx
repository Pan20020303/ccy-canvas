import { memo } from "react";
import { useViewport } from "@xyflow/react";

import { usePresenceStore } from "../collab/presence-store";
import { useStore } from "../store";

/**
 * Renders remote collaborators' live presence over the canvas: colored cursors
 * with name pills (Tier 1), colored outlines on nodes they've selected (Tier 2),
 * and a "…正在编辑" badge on nodes they're dragging (Tier 3).
 *
 * Must render inside ReactFlowProvider (uses useViewport). It is a pointer-
 * events:none overlay so it never intercepts canvas interaction, and it draws in
 * SCREEN space by converting each collaborator's flow-coordinate cursor via the
 * live viewport, so everything tracks pan/zoom.
 */
function CursorArrow({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.4))" }}>
      <path d="M2 2 L2 14 L6 10.5 L8.5 15.5 L11 14.3 L8.5 9.5 L14 9.5 Z" fill={color} stroke="white" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

export const RemotePresenceLayer = memo(function RemotePresenceLayer() {
  const { x, y, zoom } = useViewport();
  const byUid = usePresenceStore((s) => s.byUid);
  const nodes = useStore((s) => s.nodes);

  const people = Object.values(byUid);
  if (people.length === 0) return null;

  const toScreen = (fx: number, fy: number) => ({ left: fx * zoom + x, top: fy * zoom + y });
  const nodeById = new Map(nodes.map((n) => [n.id, n as any]));
  const nodeRect = (id: string) => {
    const n = nodeById.get(id);
    if (!n) return null;
    const w = (n.measured?.width ?? n.width ?? 300) as number;
    const h = (n.measured?.height ?? n.height ?? 200) as number;
    const p = toScreen(n.position.x, n.position.y);
    return { left: p.left, top: p.top, width: w * zoom, height: h * zoom };
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
      {/* Selection + drag outlines */}
      {people.flatMap((p) => {
        const dragIds = new Set(p.activity?.nodeIds ?? []);
        const ids = new Set<string>([...(p.selection ?? []), ...dragIds]);
        return [...ids].map((nid) => {
          const r = nodeRect(nid);
          if (!r) return null;
          const dragging = dragIds.has(nid);
          return (
            <div
              key={`${p.uid}-${nid}`}
              className="absolute rounded-[12px]"
              style={{
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
                border: `2px solid ${p.color}`,
                boxShadow: `0 0 0 1px ${p.color}44`,
              }}
            >
              {dragging ? (
                <div
                  className="absolute -top-[18px] left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
                  style={{ background: p.color }}
                >
                  {(p.name || "协作者") + " 正在编辑"}
                </div>
              ) : null}
            </div>
          );
        });
      })}

      {/* Cursors + name pills */}
      {people.map((p) => {
        if (!p.cursor) return null;
        const s = toScreen(p.cursor.x, p.cursor.y);
        return (
          <div
            key={p.uid}
            className="absolute"
            style={{ left: s.left, top: s.top, transition: "left 80ms linear, top 80ms linear" }}
          >
            <CursorArrow color={p.color} />
            <div
              className="absolute left-[14px] top-[16px] max-w-[160px] truncate whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium text-white shadow-md"
              style={{ background: p.color }}
            >
              {p.name || "协作者"}
            </div>
          </div>
        );
      })}
    </div>
  );
});
