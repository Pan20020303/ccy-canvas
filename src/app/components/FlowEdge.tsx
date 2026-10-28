import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { memo, useId, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../store';
import { canvasQueries } from '../canvas-selectors';
import { selectedEdgeColor, useCanvasPreferences } from '../canvas-preferences';
import './FlowEdge.css';

const EMPTY_GROUPS: never[] = [];

/** Unified canvas edge.
 *  - Default: a single faint white bezier line, no arrowhead — matches the
 *    "暗夜灰" neowow aesthetic.
 *  - Linked: selected nodes highlight their incoming and outgoing wires.
 *  - Motion: wave-like stripe packets travel left-to-right along selected or
 *    generating wires. Both selection effects and motion have settings.
 *  - Selected: brightest, plus a ✕ button at the midpoint to delete the
 *    connection (edges also die with Backspace/Delete). */
export const FlowEdge = memo(function FlowEdge({
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
  const groups = useStore(state => state.groups ?? EMPTY_GROUPS);
  const readOnly = useStore(state => state.backendProjects?.find(project => project.id === state.activeBackendProjectId)?.my_role === 'visitor');
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
    const src = canvasQueries.node(state.nodes, source);
    const tgt = canvasQueries.node(state.nodes, target);
    const isRunning = (n: typeof src) => {
      const s = (n?.data as { status?: string } | undefined)?.status;
      return s === 'running' || s === 'generating';
    };
    return isRunning(src) || isRunning(tgt);
  });

  // Brighten wires attached to the current node selection (boolean selector —
  // the edge only re-renders when the flag actually flips).
  const linkedToSelection = useStore((state) =>
    Boolean(canvasQueries.node(state.nodes, source)?.selected || canvasQueries.node(state.nodes, target)?.selected),
  );

  // 白天模式下白色描边隐形 — stroke 是内联样式，CSS 覆盖不到，按主题取色。
  const light = useStore((state) => state.theme) === 'light';
  const baseStroke = preferences.edgeColorId === 'default'
    ? (light ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.38)')
    : selectedEdgeColor(preferences);
  const selectionFocused = preferences.edgeSelectionHighlight && linkedToSelection;
  const highlighted = Boolean(selected || selectionFocused);
  const emphasized = highlighted || (hovered && preferences.edgeHover);
  const focusedStroke = preferences.edgeColorId === 'default' ? (light ? '#0284c7' : '#38bdf8') : selectedEdgeColor(preferences);
  const stroke = highlighted ? focusedStroke : baseStroke;
  const animated = preferences.edgeAnimation && (active || highlighted);
  // The Bezier can be stored in either direction. Screen-space motion always
  // travels left to right, including an incoming edge whose source is on the right.
  const flowOffset = targetX >= sourceX ? '-48px' : '48px';
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
      {highlighted && <path className="canvas-flow-edge-glow" d={edgePath} fill="none" stroke={stroke} strokeWidth={preferences.edgeWidth + 6} strokeOpacity={light ? .1 : .14} pointerEvents="none" />}
      <BaseEdge
        id={`${id}-base`}
        path={edgePath}
        interactionWidth={preferences.edgeHitWidth}
        style={{
          stroke,
          strokeWidth: preferences.edgeWidth + (highlighted ? .5 : 0),
          strokeOpacity: highlighted ? 1 : emphasized ? .9 : .38,
          fill: 'none',
          transition: 'stroke 0.15s ease, stroke-opacity 0.15s ease, stroke-width 0.15s ease',
        }}
      />
      {animated ? (
        <path
          className="canvas-flow-edge-motion"
          d={edgePath}
          fill="none"
          stroke={highlighted ? (light ? focusedStroke : '#c8f1ff') : baseStroke}
          strokeWidth={preferences.edgeWidth + .5}
          pointerEvents="none"
          strokeLinecap="round"
          strokeDasharray="2 4 6 4 12 20"
          style={{ '--edge-flow-offset': flowOffset } as CSSProperties}
        />
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
});
