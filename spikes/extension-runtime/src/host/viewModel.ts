// Turns a loaded plan into the chart's view model: one level for the overview
// and one per flow, with parents, progress and source lines resolved here so
// the webview only has to draw.
import type { LoadedFile, Project } from '../../../format/src/load.js';
import { positionOf } from '../../../format/src/load.js';
import { nodeLabel, type PlanNode } from '../../../format/src/schema.js';
import { flowProgress, indexProject, MAIN, validateProject, type ProjectIndex } from '../../../format/src/validate.js';
import { OVERVIEW, type Crumb, type Level, type LevelId, type SourcePos, type VEdge, type ViewModel, type VNode } from '../shared/viewModel.js';

function pos(file: LoadedFile<unknown> | null, path: readonly PropertyKey[]): SourcePos {
  if (!file) return { file: 'plan/map.yaml', line: 1 };
  return { file: file.path, line: positionOf(file, path).line };
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

function flowNode(index: ProjectIndex, n: PlanNode, source: SourcePos): VNode {
  const v: VNode = { id: n.id, kind: n.type, label: nodeLabel(n), source };
  if (n.description) v.description = n.description;
  if (n.type === 'component') {
    v.componentKind = n.kind;
    if (n.tech) v.tech = n.tech;
  }
  if (n.type === 'step' || n.type === 'component') {
    const child = n.expands ? index.flows.get(n.expands) : undefined;
    if (child && child.parentNodeId === n.id) {
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

export function buildViewModel(project: Project): ViewModel {
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
      node.planned = true;
    }
    overviewNodes.push(node);
  });
  (map?.components ?? []).forEach((c, i) => {
    const node: VNode = { id: c.id, kind: 'component', label: c.label, componentKind: c.kind, source: pos(project.map, ['components', i]) };
    if (c.tech) node.tech = c.tech;
    if (c.description) node.description = c.description;
    if (c.status) node.status = c.status;
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
      nodes: ref.flow.nodes.map((n, i) => flowNode(index, n, pos(ref.file, ['flows', ref.key, 'nodes', i]))),
      edges: edgesOf(ref.flow.edges),
      progress: flowProgress(index, ref.id),
      source: pos(ref.file, ['flows', ref.key]),
    };
    if (ref.flow.description) level.description = ref.flow.description;
    levels[ref.id] = level;
  }

  const issues = validateProject(project).map((i) => ({
    file: i.file,
    line: i.line,
    severity: i.severity,
    code: i.code,
    message: i.message,
  }));
  return { project: title, levels, issues };
}
