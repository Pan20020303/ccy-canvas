import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

/** Unified canvas edge: grey base line with a cyan dashed flow animation on top. */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      {/* Grey base stroke */}
      <BaseEdge
        id={`${id}-base`}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke: 'rgba(148, 163, 184, 0.55)', strokeWidth: 1.6, fill: 'none' }}
      />
      {/* Animated cyan dashed overlay flowing along the curve */}
      <path
        d={edgePath}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeDasharray="8 12"
        opacity={0.85}
      >
        <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="0.8s" repeatCount="indefinite" />
      </path>
    </>
  );
}
