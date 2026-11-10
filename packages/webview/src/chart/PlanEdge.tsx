// Edges follow ELK's orthogonal route with rounded corners. The label sits on the
// line (ITC-2): its name, or its data when it has no name. A line with both shows
// its data below the name only while that line is picked out.
import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { labelPoint, roundedPath, type Point } from '../layout/geometry.js';
import type { EdgeLabelBox } from '../layout/metrics.js';

export interface PlanEdgeData extends Record<string, unknown> {
  points: Point[];
  label: EdgeLabelBox | null;
  labelAt: Point | null;
  emphasis: 'none' | 'active' | 'dim';
  /** This line is the one picked out. */
  picked: boolean;
  /** Picks this line out; its label picks it too. */
  onSelect?: (id: string) => void;
}
export type PlanFlowEdge = Edge<PlanEdgeData, 'plan'>;

export const PlanEdge = memo(function PlanEdge({ id, data }: EdgeProps<PlanFlowEdge>) {
  if (!data || data.points.length < 2) return null;
  const at = data.labelAt ?? labelPoint(data.points);
  const cls = `edge edge--${data.emphasis}`;
  return (
    <>
      <BaseEdge id={id} path={roundedPath(data.points)} className={cls} markerEnd={`url(#arrow-${data.emphasis})`} interactionWidth={12} />
      {data.label && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label edge-label--${data.emphasis}${data.picked ? ' edge-label--picked' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)`, width: data.label.width }}
            onClick={(event) => {
              event.stopPropagation();
              data.onSelect?.(id);
            }}
          >
            {data.label.label && <span className="edge-label__branch">{data.label.label}</span>}
            {data.label.data && (!data.label.label || data.picked) && (
              <span className={`edge-label__data${data.label.label ? ' edge-label__data--below' : ''}`} title={data.label.data}>
                <span className="codicon codicon-package" aria-hidden="true" />
                {data.label.data}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { plan: PlanEdge };

/** Arrowheads per emphasis, coloured by CSS. */
export function EdgeMarkers() {
  return (
    <svg className="edge-markers" aria-hidden="true">
      <defs>
        {(['none', 'active', 'dim'] as const).map((e) => (
          <marker
            key={e}
            id={`arrow-${e}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path
              d="M1,1.5 L9,5 L1,8.5"
              className={`edge-arrow edge-arrow--${e}`}
              fill="none"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
