// The messages between the webview and the extension host. Both sides parse every
// message with these schemas, so neither trusts what crosses the boundary.
import { z } from 'zod';
import { type Project, loadFromTexts } from './load.js';
import { OVERVIEW, rollup } from './progress.js';
import { indexProject, validateProject } from './validate.js';
import { ViewModel } from './viewModel.js';

const Problem = z.strictObject({
  file: z.string(),
  line: z.number(),
  col: z.number(),
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
});

const FeatureSummary = z.strictObject({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  done: z.number(),
  total: z.number(),
  /** Listed in map.yaml, with no flows file yet. */
  planned: z.boolean(),
});

const PlanSummary = z.strictObject({
  /** Null when map.yaml can't be read. */
  project: z.string().nullable(),
  features: z.array(FeatureSummary),
  done: z.number(),
  total: z.number(),
  problems: z.array(Problem),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

export const AppState = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('no-plan'), trusted: z.boolean() }),
  z.strictObject({ kind: z.literal('plan'), trusted: z.boolean(), folder: z.string(), plan: PlanSummary, model: ViewModel }),
]);
export type AppState = z.infer<typeof AppState>;

export const HostMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state'), state: AppState }),
  /** Show this level, e.g. the feature whose file was opened. */
  z.strictObject({ type: z.literal('show-level'), level: z.string() }),
]);
export type HostMessage = z.infer<typeof HostMessage>;

export const WebviewMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('log'), level: z.enum(['info', 'warn', 'error']), message: z.string().max(2000) }),
  z.strictObject({ type: z.literal('rendered'), kind: z.enum(['no-plan', 'plan']), features: z.number(), problems: z.number() }),
  z.strictObject({
    type: z.literal('chart-rendered'),
    level: z.string(),
    nodes: z.number().int(),
    width: z.number(),
    height: z.number(),
    layoutMs: z.number(),
    workerMode: z.enum(['blob', 'main']),
  }),
  z.strictObject({ type: z.literal('init-plan') }),
  z.strictObject({ type: z.literal('open-source'), file: z.string().max(500), line: z.number().int().min(1) }),
]);
export type WebviewMessage = z.infer<typeof WebviewMessage>;

function summarize(project: Project): PlanSummary {
  const progress = rollup(project);
  const listed = project.map?.data?.features ?? [];
  const features = [...indexProject(project).features.entries()].map(([id, feature]) => {
    const { done, total } = progress.get(id) ?? { done: 0, total: 0 };
    const description = listed.find((f) => f.id === id)?.description;
    return { id, label: feature.label, ...(description === undefined ? {} : { description }), done, total, planned: !feature.file };
  });
  const overall = progress.get(OVERVIEW) ?? { done: 0, total: 0 };
  return {
    project: project.map?.data?.project ?? null,
    features,
    done: overall.done,
    total: overall.total,
    // A listed feature without flows is a normal stage of planning, and its row already says so.
    problems: validateProject(project).filter((issue) => issue.code !== 'feature-without-flows'),
  };
}

/** What the app shows about a plan, from its file contents. */
export function summarizePlan(texts: Readonly<Record<string, string>>): PlanSummary {
  return summarize(loadFromTexts(texts));
}
