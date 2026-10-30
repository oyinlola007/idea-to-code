// What changed between two versions of a plan, compared by ID, which never
// changes. So a renamed node is a change, not a delete plus an add. The result
// is a flat list: history summaries read it now, and the chart's visual diff
// can use it later (`level` to jump to a change, `path` for badges on parents).
import type { LoadedFile, Project } from './load.js';
import { OVERVIEW } from './progress.js';
import type { FeatureFile, PlanNode } from './schema.js';
import { indexProject, type ProjectIndex } from './validate.js';

export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

interface Located {
  /** The level this change shows at: a flow id, or "overview". */
  level: string;
  levelLabel: string;
  /** Levels from the overview down to `level`, inclusive. */
  path: string[];
}

export type Change = Located &
  (
    | { kind: 'project-changed'; fields: FieldChange[] }
    | { kind: 'feature-added' | 'feature-removed'; id: string; label: string }
    | { kind: 'feature-changed'; id: string; label: string; fields: FieldChange[] }
    | { kind: 'component-added' | 'component-removed'; id: string; label: string }
    | { kind: 'component-changed'; id: string; label: string; fields: FieldChange[] }
    | { kind: 'connection-added' | 'connection-removed'; from: string; to: string }
    | { kind: 'connection-changed'; from: string; to: string; fields: FieldChange[] }
    | { kind: 'flow-added' | 'flow-removed'; id: string; label: string; nodes: number }
    | { kind: 'flow-changed'; id: string; label: string; fields: FieldChange[] }
    | { kind: 'node-added' | 'node-removed'; id: string; label: string; nodeType: PlanNode['type'] }
    | { kind: 'node-changed'; id: string; label: string; fields: FieldChange[] }
    | { kind: 'node-moved'; id: string; label: string; fromFlow: string; toFlow: string; toFlowLabel: string }
    | { kind: 'status-changed'; id: string; label: string; from: string; to: string }
    | { kind: 'edge-added' | 'edge-removed'; from: string; to: string }
    | { kind: 'edge-changed'; from: string; to: string; fields: FieldChange[] }
  );

export interface PlanDiff {
  changes: Change[];
  /** Files that couldn't be read in one version or the other, and so weren't compared. */
  unreadable: string[];
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function fieldChanges<T extends object>(a: T, b: T, fields: readonly (keyof T & string)[]): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of fields) {
    const from = text(a[field]);
    const to = text(b[field]);
    if (from !== to) out.push({ field, from, to });
  }
  return out;
}

function pathOf(index: ProjectIndex, flowId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = index.flows.get(flowId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current.id);
    const parent: string | undefined = current.parentNodeId ? index.nodes.get(current.parentNodeId)?.flowId : undefined;
    current = parent ? index.flows.get(parent) : undefined;
  }
  return [OVERVIEW, ...chain];
}

const NODE_FIELDS = ['type', 'label', 'description', 'kind', 'tech', 'ref', 'expands'] as const;

function nodeFields(a: PlanNode, b: PlanNode): FieldChange[] {
  return fieldChanges<Record<string, unknown>>(a, b, NODE_FIELDS);
}

const statusOf = (n: PlanNode): string | null => (n.type === 'step' || n.type === 'component' ? (n.status ?? 'todo') : null);

const nameOf = (n: PlanNode): string => n.label ?? n.id;

function brokenPaths(project: Project): Set<string> {
  const files: (LoadedFile<unknown> | null)[] = [project.map, ...project.features];
  return new Set(files.flatMap((f) => (f?.data === null ? [f.path] : [])));
}

/** Compares two versions of a plan. Anything in a file unreadable on either side is left out, never reported as deleted. */
export function diffProjects(a: Project, b: Project): PlanDiff {
  const unreadable = new Set([...brokenPaths(a), ...brokenPaths(b)]);
  const ia = indexProject(a);
  const ib = indexProject(b);
  const changes: Change[] = [];

  const overviewLabel = b.map?.data?.project ?? a.map?.data?.project ?? 'Overview';
  const atOverview: Located = { level: OVERVIEW, levelLabel: overviewLabel, path: [OVERVIEW] };
  const mapA = a.map?.data;
  const mapB = b.map?.data;
  if (mapA && mapB) {
    const fields = fieldChanges(mapA, mapB, ['project', 'description']);
    if (fields.length > 0) changes.push({ ...atOverview, kind: 'project-changed', fields });

    const featuresA = new Map(mapA.features.map((f) => [f.id, f]));
    for (const f of mapB.features) {
      const before = featuresA.get(f.id);
      if (!before) {
        changes.push({ ...atOverview, kind: 'feature-added', id: f.id, label: f.label });
        continue;
      }
      const changed = fieldChanges(before, f, ['label', 'description']);
      if (changed.length > 0) changes.push({ ...atOverview, kind: 'feature-changed', id: f.id, label: f.label, fields: changed });
    }
    const featureIdsB = new Set(mapB.features.map((f) => f.id));
    for (const f of mapA.features) {
      if (!featureIdsB.has(f.id)) changes.push({ ...atOverview, kind: 'feature-removed', id: f.id, label: f.label });
    }

    const componentsA = new Map(mapA.components.map((c) => [c.id, c]));
    for (const c of mapB.components) {
      const before = componentsA.get(c.id);
      if (!before) {
        changes.push({ ...atOverview, kind: 'component-added', id: c.id, label: c.label });
        continue;
      }
      const changed = fieldChanges(before, c, ['label', 'kind', 'tech', 'description']);
      if (changed.length > 0) changes.push({ ...atOverview, kind: 'component-changed', id: c.id, label: c.label, fields: changed });
      const from = before.status ?? 'todo';
      const to = c.status ?? 'todo';
      if (from !== to) changes.push({ ...atOverview, kind: 'status-changed', id: c.id, label: c.label, from, to });
    }
    const componentIdsB = new Set(mapB.components.map((c) => c.id));
    for (const c of mapA.components) {
      if (!componentIdsB.has(c.id)) changes.push({ ...atOverview, kind: 'component-removed', id: c.id, label: c.label });
    }

    const key = (c: { from: string; to: string }) => `${c.from}->${c.to}`;
    const connectionsA = new Map(mapA.connections.map((c) => [key(c), c]));
    const connectionsB = new Set(mapB.connections.map(key));
    for (const c of mapB.connections) {
      const before = connectionsA.get(key(c));
      if (!before) {
        changes.push({ ...atOverview, kind: 'connection-added', from: c.from, to: c.to });
        continue;
      }
      const changed = fieldChanges(before, c, ['label', 'data']);
      if (changed.length > 0) changes.push({ ...atOverview, kind: 'connection-changed', from: c.from, to: c.to, fields: changed });
    }
    for (const c of mapA.connections) {
      if (!connectionsB.has(key(c))) changes.push({ ...atOverview, kind: 'connection-removed', from: c.from, to: c.to });
    }
  }

  // Flows and nodes in a file unreadable on either side aren't comparable at all.
  const comparable = (file: LoadedFile<FeatureFile>) => !unreadable.has(file.path);
  const flowsA = new Map([...ia.flows].filter(([, f]) => comparable(f.file)));
  const flowsB = new Map([...ib.flows].filter(([, f]) => comparable(f.file)));
  const nodesA = new Map([...ia.nodes].filter(([, n]) => comparable(n.file)));
  const nodesB = new Map([...ib.nodes].filter(([, n]) => comparable(n.file)));

  const locate = (index: ProjectIndex, flowId: string, label: string): Located => ({
    level: flowId,
    levelLabel: label,
    path: pathOf(index, flowId),
  });

  for (const [id, flow] of flowsB) {
    const before = flowsA.get(id);
    const at = locate(ib, id, flow.flow.label);
    if (!before) {
      changes.push({ ...at, kind: 'flow-added', id, label: flow.flow.label, nodes: flow.flow.nodes.length });
      continue;
    }
    const fields = fieldChanges(before.flow, flow.flow, ['label', 'description']);
    if (fields.length > 0) changes.push({ ...at, kind: 'flow-changed', id, label: flow.flow.label, fields });
  }
  for (const [id, flow] of flowsA) {
    if (!flowsB.has(id))
      changes.push({ ...locate(ia, id, flow.flow.label), kind: 'flow-removed', id, label: flow.flow.label, nodes: flow.flow.nodes.length });
  }

  for (const [id, ref] of nodesB) {
    const flow = flowsB.get(ref.flowId);
    if (!flow) continue;
    const at = locate(ib, ref.flowId, flow.flow.label);
    const before = nodesA.get(id);
    if (!before) {
      changes.push({ ...at, kind: 'node-added', id, label: nameOf(ref.node), nodeType: ref.node.type });
      continue;
    }
    if (before.flowId !== ref.flowId) {
      changes.push({
        ...at,
        kind: 'node-moved',
        id,
        label: nameOf(ref.node),
        fromFlow: before.flowId,
        toFlow: ref.flowId,
        toFlowLabel: flow.flow.label,
      });
    }
    const fields = nodeFields(before.node, ref.node);
    if (fields.length > 0) changes.push({ ...at, kind: 'node-changed', id, label: nameOf(ref.node), fields });
    const from = statusOf(before.node);
    const to = statusOf(ref.node);
    // A node with a child flow has computed progress, so a stored status going away means nothing.
    const computed = 'expands' in ref.node && ref.node.expands !== undefined;
    if (from !== null && to !== null && from !== to && !computed)
      changes.push({ ...at, kind: 'status-changed', id, label: nameOf(ref.node), from, to });
  }
  for (const [id, ref] of nodesA) {
    if (nodesB.has(id)) continue;
    const flow = flowsA.get(ref.flowId);
    if (flow)
      changes.push({
        ...locate(ia, ref.flowId, flow.flow.label),
        kind: 'node-removed',
        id,
        label: nameOf(ref.node),
        nodeType: ref.node.type,
      });
  }

  const edgeKey = (e: { from: string; to: string }) => `${e.from}->${e.to}`;
  for (const [id, flow] of flowsB) {
    const at = locate(ib, id, flow.flow.label);
    const before = new Map((flowsA.get(id)?.flow.edges ?? []).map((e) => [edgeKey(e), e]));
    for (const e of flow.flow.edges) {
      const old = before.get(edgeKey(e));
      if (!old) {
        changes.push({ ...at, kind: 'edge-added', from: e.from, to: e.to });
        continue;
      }
      const fields = fieldChanges(old, e, ['label', 'data']);
      if (fields.length > 0) changes.push({ ...at, kind: 'edge-changed', from: e.from, to: e.to, fields });
    }
  }
  for (const [id, flow] of flowsA) {
    const after = new Set((flowsB.get(id)?.flow.edges ?? []).map(edgeKey));
    const at = locate(ia, id, flow.flow.label);
    for (const e of flow.flow.edges) {
      if (!after.has(edgeKey(e))) changes.push({ ...at, kind: 'edge-removed', from: e.from, to: e.to });
    }
  }

  return { changes, unreadable: [...unreadable].sort() };
}
