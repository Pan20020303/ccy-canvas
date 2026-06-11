import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useStore } from '../store';

/** Unified canvas edge.
 *  - Default: a single faint white bezier line, no arrowhead — matches the
 *    "暗夜灰" neowow aesthetic.
 *  - Active: when either endpoint node is running/generating, a white dashed
 *    overlay flows along the curve so you can spot the live wire at a glance. */
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
  const [edgePath] = getBezierPath({
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

  const baseStroke = selected ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.2)';

  return (
    <>
      <BaseEdge
        id={`${id}-base`}
        path={edgePath}
        style={{ stroke: baseStroke, strokeWidth: 2, fill: 'none' }}
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
    </>
  );
}
