import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { useStore } from '../store';

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

  const baseStroke = selected
    ? 'rgba(255,255,255,0.6)'
    : linkedToSelection
      ? 'rgba(255,255,255,0.38)'
      : 'rgba(255,255,255,0.2)';

  const deleteEdge = (event: React.MouseEvent) => {
    event.stopPropagation();
    const store = useStore.getState();
    store.pushUndoSnapshot();
    store.onEdgesChange([{ type: 'remove', id }]);
  };

  return (
    <>
      <BaseEdge
        id={`${id}-base`}
        path={edgePath}
        style={{
          stroke: baseStroke,
          strokeWidth: 2,
          fill: 'none',
          transition: 'stroke 0.15s ease',
        }}
      />
      {active ? (
        <path
          d={edgePath}
          fill="none"
          stroke="rgba(255,255,255,0.85)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="6 10"
        >
          <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="0.8s" repeatCount="indefinite" />
        </path>
      ) : null}
      {selected ? (
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
