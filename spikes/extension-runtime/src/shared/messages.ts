// The webview bridge contract. Every message is parsed on arrival in both
// directions; anything that doesn't match is dropped.
import { z } from 'zod';
import type { Level, PlanIssue, VEdge, ViewModel, VNode } from './viewModel.js';

const SourcePos = z.strictObject({ file: z.string(), line: z.number().int() });
const Progress = z.strictObject({ done: z.number().int(), total: z.number().int() });

const VNodeSchema: z.ZodType<VNode> = z.strictObject({
  id: z.string(),
  kind: z.enum(['feature', 'start', 'end', 'step', 'decision', 'component', 'reference']),
  label: z.string(),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'done']).optional(),
  componentKind: z.string().optional(),
  tech: z.string().optional(),
  opens: z.string().optional(),
  jumpsTo: z.string().optional(),
  refLabel: z.string().optional(),
  progress: Progress.optional(),
  planned: z.boolean().optional(),
  source: SourcePos,
});

const VEdgeSchema: z.ZodType<VEdge> = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  data: z.string().optional(),
});

const LevelSchema: z.ZodType<Level> = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  parent: z.string().nullable(),
  crumbs: z.array(z.strictObject({ id: z.string(), title: z.string() })),
  depth: z.number().int(),
  nodes: z.array(VNodeSchema),
  edges: z.array(VEdgeSchema),
  progress: Progress,
  source: SourcePos,
});

const PlanIssueSchema: z.ZodType<PlanIssue> = z.strictObject({
  file: z.string(),
  line: z.number().int(),
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
});

export const ViewModelSchema: z.ZodType<ViewModel> = z.strictObject({
  project: z.string(),
  levels: z.record(z.string(), LevelSchema),
  issues: z.array(PlanIssueSchema),
});

export const WorkerMode = z.enum(['blob', 'url', 'main']);
export type WorkerMode = z.infer<typeof WorkerMode>;
export const WorkerSetting = z.enum(['auto', 'blob', 'url', 'main']);
export type WorkerSetting = z.infer<typeof WorkerSetting>;

export const HostToView = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('model'), model: ViewModelSchema, start: z.string().optional() }),
  z.strictObject({ type: z.literal('navigate'), level: z.string() }),
  z.strictObject({ type: z.literal('config'), workerMode: WorkerSetting, workerUrl: z.string() }),
  z.strictObject({ type: z.literal('dumpTheme') }),
]);
export type HostToView = z.infer<typeof HostToView>;

export const ViewToHost = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({
    type: z.literal('rendered'),
    level: z.string(),
    nodes: z.number().int(),
    layoutMs: z.number(),
    workerMode: WorkerMode,
    width: z.number(),
    height: z.number(),
  }),
  z.strictObject({ type: z.literal('workerFailed'), mode: z.string(), error: z.string() }),
  z.strictObject({ type: z.literal('openSource'), file: z.string(), line: z.number().int().positive() }),
  z.strictObject({ type: z.literal('level'), level: z.string() }),
  z.strictObject({ type: z.literal('themeVars'), bodyClass: z.string(), vars: z.record(z.string(), z.string()) }),
  z.strictObject({ type: z.literal('log'), level: z.enum(['info', 'warn', 'error']), message: z.string() }),
]);
export type ViewToHost = z.infer<typeof ViewToHost>;
