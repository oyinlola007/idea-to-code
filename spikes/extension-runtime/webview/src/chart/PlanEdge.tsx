// Edges follow ELK's orthogonal route with rounded corners. The branch label
// and the data chip sit on the middle of the longest segment (ITC-2).
import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { labelPoint, roundedPath, type Point } from '../layout/geometry';
import type { EdgeLabelBox } from '../layout/metrics';

export interface PlanEdgeData extends Record<string, unknown> {
  points: Point[];
  label: EdgeLabelBox | null;
  labelAt: Point | null;
  emphasis: 'none' | 'active' | 'dim';
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
            className={`edge-label edge-label--${data.emphasis}`}
            style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)`, width: data.label.width }}
          >
            {data.label.label && <span className="edge-label__branch">{data.label.label}</span>}
            {data.label.data && (
              <span className="edge-label__data" title={data.label.data}>
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
          <marker key={e} id={`arrow-${e}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M1,1.5 L9,5 L1,8.5" className={`edge-arrow edge-arrow--${e}`} fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
