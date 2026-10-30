// The plan file format. Per-file shape only: rules that span files (unique
// ids, expands targets, the flow tree) live in validate.ts so their errors
// can point at a file and line.
import { z } from 'zod';

export const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'ids are lowercase words joined by hyphens, e.g. "tailor-cv"');

export const Status = z.enum(['todo', 'in_progress', 'done']);

const base = {
  id: Slug,
  label: z.string().min(1),
  description: z.string().optional(),
};

// Start and end nodes may leave out the label; they render as "Start" / "End".
export const StartNode = z.strictObject({ ...base, label: z.string().min(1).optional(), type: z.literal('start') });
export const EndNode = z.strictObject({ ...base, label: z.string().min(1).optional(), type: z.literal('end') });
export const DecisionNode = z.strictObject({ ...base, type: z.literal('decision') });
export const StepNode = z.strictObject({
  ...base,
  type: z.literal('step'),
  status: Status.optional(),
  expands: Slug.optional(),
});
export const ComponentNode = z.strictObject({
  ...base,
  type: z.literal('component'),
  kind: z.string().min(1),
  tech: z.string().optional(),
  status: Status.optional(),
  expands: Slug.optional(),
});
export const ReferenceNode = z.strictObject({
  ...base,
  type: z.literal('reference'),
  ref: Slug,
});

export const Node = z.discriminatedUnion('type', [StartNode, EndNode, StepNode, DecisionNode, ComponentNode, ReferenceNode]);

export const Edge = z.strictObject({
  from: Slug,
  to: Slug,
  label: z.string().optional(),
  data: z.string().optional(),
});

export const Flow = z.strictObject({
  label: z.string().min(1),
  description: z.string().optional(),
  nodes: z.array(Node).default([]),
  edges: z.array(Edge).default([]),
});

export const FeatureFile = z.strictObject({
  feature: Slug,
  flows: z.record(Slug, Flow),
});

export const FeatureEntry = z.strictObject({
  id: Slug,
  label: z.string().min(1),
  description: z.string().optional(),
});

export const TopComponent = z.strictObject({
  id: Slug,
  label: z.string().min(1),
  kind: z.string().min(1),
  tech: z.string().optional(),
  description: z.string().optional(),
  status: Status.optional(),
});

export const Connection = z.strictObject({
  from: Slug,
  to: Slug,
  label: z.string().optional(),
  data: z.string().optional(),
});

export const MapFile = z.strictObject({
  project: z.string().min(1),
  description: z.string().optional(),
  features: z.array(FeatureEntry).default([]),
  components: z.array(TopComponent).default([]),
  connections: z.array(Connection).default([]),
});

export type Status = z.infer<typeof Status>;
export type PlanNode = z.infer<typeof Node>;
export type Edge = z.infer<typeof Edge>;
export type Flow = z.infer<typeof Flow>;
export type FeatureFile = z.infer<typeof FeatureFile>;
export type MapFile = z.infer<typeof MapFile>;
export type NodeType = PlanNode['type'];

/** The format version, recorded by the history store. User files never carry a version. */
export const PLAN_FORMAT_VERSION = 1;

export function nodeLabel(n: PlanNode): string {
  return n.label ?? (n.type === 'start' ? 'Start' : n.type === 'end' ? 'End' : n.id);
}

/** Node types that can carry a status and expand into a child flow. */
export const WORK_TYPES: ReadonlySet<NodeType> = new Set(['step', 'component']);
