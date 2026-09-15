import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { useStore, useActiveProjectReadOnly } from '../store';
import { selectedEdgeColor, useCanvasPreferences } from '../canvas-preferences';

/** Unified canvas edge.
 *  - Default: a single faint white bezier line, no arrowhead — matches the
 *    "暗夜灰" neowow aesthetic.
 *  - Linked: when either endpoint node is SELECTED, the wire brightens a
 *    touch so a node's connections read at a glance.
 *  - Active: when either endpoint node is running/generating, a white dashed
 *    overlay flows along the curve so you can spot the live wire at a glance.
 *  - Selected: brightest, plus a ✕ button at the midpoint to delete the
 *    connection (edges also die with Backspace/Delete). */
export function FlowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const preferences = useCanvasPreferences(state => state.values);
  const groups = useStore(state => state.groups);
  const readOnly = useActiveProjectReadOnly();
  const [hovered, setHovered] = useState(false);
  const maskId = `edge-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Light up the line while either endpoint is actively producing output.
  const active = useStore((state) => {
    const src = state.nodes.find((n) => n.id === source);
    const tgt = state.nodes.find((n) => n.id === target);
    const isRunning = (n: typeof src) => {
      const s = (n?.data as { status?: string } | undefined)?.status;
      return s === 'running' || s === 'generating';
    };
    return isRunning(src) || isRunning(tgt);
  });

  // Brighten wires attached to the current node selection (boolean selector —
  // the edge only re-renders when the flag actually flips).
  const linkedToSelection = useStore((state) =>
    state.nodes.some((n) => n.selected && (n.id === source || n.id === target)),
  );

  // 白天模式下白色描边隐形 — stroke 是内联样式，CSS 覆盖不到，按主题取色。
  const light = useStore((state) => state.theme) === 'light';
  const baseStroke = light && preferences.edgeColorId === 'default' ? '#555555' : selectedEdgeColor(preferences);
  const emphasized = selected || linkedToSelection || (hovered && preferences.edgeHover);
  // Occlude unrelated wires passing behind a group, preserving the group's
  // own inbound/outbound/internal connections so the graph stays readable.
  const maskPadding = Math.max(Math.abs(targetX-sourceX), Math.abs(targetY-sourceY)) / 2 + 100;
  const maskBounds = { x: Math.min(sourceX,targetX)-maskPadding, y: Math.min(sourceY,targetY)-maskPadding, width: Math.abs(targetX-sourceX)+maskPadding*2, height: Math.abs(targetY-sourceY)+maskPadding*2 };
  const occluders = preferences.groupOccludesEdges ? groups.filter(g =>
    !g.nodeIds.includes(source) && !g.nodeIds.includes(target) && g.position && g.width && g.height &&
    g.position.x < maskBounds.x + maskBounds.width && g.position.x + g.width > maskBounds.x &&
    g.position.y < maskBounds.y + maskBounds.height && g.position.y + g.height > maskBounds.y
  ) : [];

  const deleteEdge = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (readOnly) return;
    const store = useStore.getState();
    store.pushUndoSnapshot();
    store.onEdgesChange([{ type: 'remove', id }]);
  };

  if (preferences.onlyFocusedEdges && !selected && !linkedToSelection) return null;
  return (
    <>
      {occluders.length > 0 && <defs><mask id={maskId} maskUnits="userSpaceOnUse" {...maskBounds}><rect {...maskBounds} fill="white" />{occluders.map(g => <rect key={g.id} x={g.position!.x} y={g.position!.y} width={g.width} height={g.height} fill="black" />)}</mask></defs>}
      <g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} mask={occluders.length ? `url(#${maskId})` : undefined}>
      <BaseEdge
        id={`${id}-base`}
        path={edgePath}
        interactionWidth={preferences.edgeHitWidth}
        style={{
          stroke: baseStroke,
          strokeWidth: preferences.edgeWidth,
          strokeOpacity: emphasized ? .9 : .38,
          fill: 'none',
          transition: 'stroke 0.15s ease',
        }}
      />
      {active && preferences.edgeAnimation ? (
        <path
          d={edgePath}
          fill="none"
          stroke={baseStroke}
          strokeWidth={preferences.edgeWidth}
          pointerEvents="none"
          strokeLinecap="round"
          strokeDasharray="6 10"
        >
          <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="0.8s" repeatCount="indefinite" />
        </path>
      ) : null}
      </g>
      {selected && !readOnly ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            title="删除连线"
            onClick={deleteEdge}
            className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-white/30 bg-[#15181d] text-neutral-300 shadow-lg transition hover:border-rose-400/60 hover:text-rose-300"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <X className="h-3 w-3" />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
