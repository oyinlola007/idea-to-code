// What the chart needs to draw a plan: one level for the overview and one per flow,
// with parents, progress and source lines resolved here so the webview only draws.
// The schemas are the source of truth: both sides of the bridge parse with them.
import { z } from 'zod';
import { normalizeCodeLink } from './codeLinks.js';
import { featurePath, positionOf, type Issue, type LoadedFile, type Project } from './load.js';
import { flowProgress, OVERVIEW } from './progress.js';
import { nodeLabel, type PlanNode } from './schema.js';
import { indexProject, MAIN, validateProject, type ProjectIndex } from './validate.js';

/** `overview`, or a flow id (a feature's main flow uses the feature id). */
export type LevelId = string;

const SourcePos = z.strictObject({ file: z.string(), line: z.number().int() });
export type SourcePos = z.infer<typeof SourcePos>;

const ProgressCount = z.strictObject({ done: z.number().int(), total: z.number().int() });

const VNode = z.strictObject({
  id: z.string(),
  kind: z.enum(['feature', 'start', 'end', 'step', 'decision', 'component', 'reference']),
  label: z.string(),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'done']).optional(),
  componentKind: z.string().optional(),
  tech: z.string().optional(),
  /** The level this node expands into (child flow, or a feature's main flow). */
  opens: z.string().optional(),
  /** For references: the level the target lives at, when it has one. */
  jumpsTo: z.string().optional(),
  refLabel: z.string().optional(),
  /** The files or folders that build it; `missing` when the host found nothing there. */
  code: z.array(z.strictObject({ path: z.string(), missing: z.boolean().optional() })).optional(),
  /** Computed for nodes that open a level. */
  progress: ProgressCount.optional(),
  /** An overview feature that has no flows yet. */
  planned: z.boolean().optional(),
  /** A feature whose file can't be read, so its flows can't be shown. */
  broken: z.boolean().optional(),
  /** What the validator says about this node's lines. */
  problems: z.array(z.strictObject({ severity: z.enum(['error', 'warning']), message: z.string() })).optional(),
  source: SourcePos,
});
export type VNode = z.infer<typeof VNode>;

const VEdge = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  data: z.string().optional(),
});
export type VEdge = z.infer<typeof VEdge>;

const Crumb = z.strictObject({ id: z.string(), title: z.string() });
export type Crumb = z.infer<typeof Crumb>;

const Level = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  parent: z.string().nullable(),
  /** From the overview down to this level, inclusive. */
  crumbs: z.array(Crumb),
  depth: z.number().int(),
  nodes: z.array(VNode),
  edges: z.array(VEdge),
  progress: ProgressCount,
  source: SourcePos,
});
export type Level = z.infer<typeof Level>;

const PlanIssue = z.strictObject({
  file: z.string(),
  line: z.number().int(),
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
});

export const ViewModel = z.strictObject({
  project: z.string(),
  levels: z.record(z.string(), Level),
  issues: z.array(PlanIssue),
});
export type ViewModel = z.infer<typeof ViewModel>;

function pos(file: LoadedFile<unknown> | null, path: readonly PropertyKey[]): SourcePos {
  if (!file) return { file: 'plan/map.yaml', line: 1 };
  return { file: file.path, line: positionOf(file, path).line };
}

/** The last line of the entry at `path`, for telling which node an issue belongs to. */
function endLine(file: LoadedFile<unknown>, path: readonly PropertyKey[]): number {
  const node = file.doc.getIn(path as unknown[], true) as { range?: [number, number, number] | null } | undefined;
  const end = node?.range?.[1];
  return end === undefined ? positionOf(file, path).line : file.lineCounter.linePos(end).line;
}

/** Marks each node with the issues inside its lines, the narrowest match when nodes nest. */
function attachProblems(project: Project, levels: Record<LevelId, Level>, issues: ViewModel['issues']): void {
  const spans = new Map<string, { node: VNode; start: number; end: number }[]>();
  const add = (file: LoadedFile<unknown> | null | undefined, node: VNode, path: readonly PropertyKey[]) => {
    if (!file) return;
    spans.set(file.path, [...(spans.get(file.path) ?? []), { node, start: positionOf(file, path).line, end: endLine(file, path) }]);
  };
  for (const level of Object.values(levels)) {
    level.nodes.forEach((node) => {
      const file = node.source.file === project.map?.path ? project.map : project.features.find((f) => f.path === node.source.file);
      const path = locate(file, node.id);
      if (path) add(file, node, path);
    });
  }
  const mark = (node: VNode, severity: 'error' | 'warning', message: string) => {
    node.problems = [...(node.problems ?? []), { severity, message }];
  };
  const overview = levels[OVERVIEW]?.nodes ?? [];
  for (const issue of issues) {
    const hit = (spans.get(issue.file) ?? [])
      .filter((span) => span.start <= issue.line && issue.line <= span.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (hit) mark(hit.node, issue.severity, issue.message);
    // From the overview you should be able to see which feature needs attention.
    const match = /^plan\/features\/(.+)\.yaml$/.exec(issue.file);
    const feature = overview.find((node) => node.kind === 'feature' && node.id === match?.[1]);
    if (feature && feature !== hit?.node && issue.severity === 'error') mark(feature, 'error', issue.message);
  }
}

/** Where a node with this id is written in its file. */
function locate(file: LoadedFile<unknown> | null | undefined, id: string): PropertyKey[] | undefined {
  const data = file?.data as
    { features?: { id: string }[]; components?: { id: string }[]; flows?: Record<string, { nodes: { id: string }[] }> } | null | undefined;
  if (!data) return undefined;
  for (const key of ['features', 'components'] as const) {
    const i = data[key]?.findIndex((entry) => entry.id === id) ?? -1;
    if (i >= 0) return [key, i];
  }
  for (const [key, flow] of Object.entries(data.flows ?? {})) {
    const i = flow.nodes.findIndex((node) => node.id === id);
    if (i >= 0) return ['flows', key, 'nodes', i];
  }
  return undefined;
}

function parentOf(index: ProjectIndex, flowId: string): LevelId {
  const flow = index.flows.get(flowId);
  if (!flow) return OVERVIEW;
  if (flow.parentNodeId) return index.nodes.get(flow.parentNodeId)?.flowId ?? OVERVIEW;
  if (flow.key === MAIN) return OVERVIEW;
  // An orphan flow (a validator warning): show it under its feature.
  return index.flows.has(flow.featureId) && flow.featureId !== flowId ? flow.featureId : OVERVIEW;
}

function crumbsOf(index: ProjectIndex, flowId: string, overviewTitle: string): Crumb[] {
  const chain: Crumb[] = [];
  const seen = new Set<string>();
  let id: LevelId = flowId;
  while (id !== OVERVIEW && !seen.has(id)) {
    seen.add(id);
    const flow = index.flows.get(id);
    if (!flow) break;
    chain.unshift({ id, title: flow.flow.label });
    id = parentOf(index, id);
  }
  return [{ id: OVERVIEW, title: overviewTitle }, ...chain];
}

function edgesOf(edges: { from: string; to: string; label?: string; data?: string }[]): VEdge[] {
  return edges.map((e, i) => ({
    id: `${e.from}->${e.to}#${i}`,
    from: e.from,
    to: e.to,
    ...(e.label ? { label: e.label } : {}),
    ...(e.data ? { data: e.data } : {}),
  }));
}

function codeOf(paths: readonly string[] | undefined, missing: ReadonlySet<string>): VNode['code'] {
  if (!paths || paths.length === 0) return undefined;
  return paths.map((path) => (missing.has(normalizeCodeLink(path)) ? { path, missing: true } : { path }));
}

function flowNode(index: ProjectIndex, n: PlanNode, source: SourcePos, missing: ReadonlySet<string>): VNode {
  const v: VNode = { id: n.id, kind: n.type, label: nodeLabel(n), source };
  if (n.description) v.description = n.description;
  if (n.type === 'component') {
    v.componentKind = n.kind;
    if (n.tech) v.tech = n.tech;
  }
  if (n.type === 'step' || n.type === 'component') {
    const code = codeOf(n.implements, missing);
    if (code) v.code = code;
    const child = n.expands ? index.flows.get(n.expands) : undefined;
    if (child?.parentNodeId === n.id) {
      // A parent's progress is computed; a stored status is ignored (status-on-parent).
      v.opens = child.id;
      v.progress = flowProgress(index, child.id);
    } else if (n.status) {
      v.status = n.status;
    }
  }
  if (n.type === 'reference') {
    const flow = index.flows.get(n.ref);
    const feature = index.features.get(n.ref);
    const component = index.components.get(n.ref);
    if (flow) {
      v.jumpsTo = flow.id;
      v.refLabel = flow.flow.label;
    } else if (feature) {
      v.refLabel = feature.label;
      if (index.flows.has(n.ref)) v.jumpsTo = n.ref;
    } else if (component) {
      v.refLabel = component.label;
      v.componentKind = component.kind;
      if (component.tech) v.tech = component.tech;
    }
  }
  return v;
}

export interface ViewOptions {
  /** Code links the host found nothing at (normalized paths). */
  missingCode?: ReadonlySet<string>;
  /** Problems the host found that core can't see, e.g. missing code. */
  extraIssues?: readonly Issue[];
}

export function buildViewModel(project: Project, options: ViewOptions = {}): ViewModel {
  const missing = options.missingCode ?? new Set<string>();
  const index = indexProject(project);
  const map = index.map;
  const title = map?.project ?? 'Plan';
  const levels: Record<LevelId, Level> = {};

  const overviewNodes: VNode[] = [];
  (map?.features ?? []).forEach((f, i) => {
    const node: VNode = { id: f.id, kind: 'feature', label: f.label, source: pos(project.map, ['features', i]) };
    if (f.description) node.description = f.description;
    if (index.flows.has(f.id)) {
      node.opens = f.id;
      node.progress = flowProgress(index, f.id);
    } else {
      const unreadable = project.features.find((file) => file.path === featurePath(f.id) && file.data === null);
      if (unreadable) {
        node.broken = true;
        // Open in YAML goes to the problem, not to the map.
        node.source = { file: unreadable.path, line: unreadable.issues[0]?.line ?? 1 };
      } else {
        node.planned = true;
      }
    }
    overviewNodes.push(node);
  });
  (map?.components ?? []).forEach((c, i) => {
    const node: VNode = { id: c.id, kind: 'component', label: c.label, componentKind: c.kind, source: pos(project.map, ['components', i]) };
    if (c.tech) node.tech = c.tech;
    if (c.description) node.description = c.description;
    if (c.status) node.status = c.status;
    const code = codeOf(c.implements, missing);
    if (code) node.code = code;
    overviewNodes.push(node);
  });
  const work = overviewNodes.reduce(
    (sum, n) => {
      if (n.progress) return { done: sum.done + n.progress.done, total: sum.total + n.progress.total };
      if (n.kind === 'component') return { done: sum.done + (n.status === 'done' ? 1 : 0), total: sum.total + 1 };
      return sum;
    },
    { done: 0, total: 0 },
  );
  levels[OVERVIEW] = {
    id: OVERVIEW,
    title,
    ...(map?.description ? { description: map.description } : {}),
    parent: null,
    crumbs: [{ id: OVERVIEW, title }],
    depth: 0,
    nodes: overviewNodes,
    edges: edgesOf(map?.connections ?? []),
    progress: work,
    source: pos(project.map, ['project']),
  };

  for (const ref of index.flows.values()) {
    const crumbs = crumbsOf(index, ref.id, title);
    const level: Level = {
      id: ref.id,
      title: ref.flow.label,
      parent: parentOf(index, ref.id),
      crumbs,
      depth: crumbs.length - 1,
      // The flow's own node list, not index.nodes: duplicates are still drawn where they're written.
      nodes: ref.flow.nodes.map((n, i) => flowNode(index, n, pos(ref.file, ['flows', ref.key, 'nodes', i]), missing)),
      edges: edgesOf(ref.flow.edges),
      progress: flowProgress(index, ref.id),
      source: pos(ref.file, ['flows', ref.key]),
    };
    if (ref.flow.description) level.description = ref.flow.description;
    levels[ref.id] = level;
  }

  // A listed feature without flows is a normal stage of planning, and its card already says so.
  const issues = [...validateProject(project), ...(options.extraIssues ?? [])]
    .filter((i) => i.code !== 'feature-without-flows')
    .map((i) => ({ file: i.file, line: i.line, severity: i.severity, code: i.code, message: i.message }));
  attachProblems(project, levels, issues);
  return { project: title, levels, issues };
}
