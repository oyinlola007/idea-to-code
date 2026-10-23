// Rules that span files, plus progress rollup. Issues are returned as data;
// nothing here throws for a bad plan.
import { featurePath, positionOf, type Issue, type LoadedFile, type Project, type Severity } from './load.js';
import { WORK_TYPES, type FeatureFile, type Flow, type MapFile, type PlanNode } from './schema.js';

export const MAIN = 'main';

export interface FlowRef {
  /** Project-wide id: the feature id for a feature's main flow, otherwise the flow key. */
  id: string;
  key: string;
  featureId: string;
  file: LoadedFile<FeatureFile>;
  flow: Flow;
  parentNodeId?: string;
}

export interface NodeRef {
  id: string;
  flowId: string;
  featureId: string;
  file: LoadedFile<FeatureFile>;
  index: number;
  node: PlanNode;
}

export interface ProjectIndex {
  map: MapFile | null;
  features: Map<string, { label: string; file: LoadedFile<FeatureFile> | null }>;
  components: Map<string, MapFile['components'][number]>;
  flows: Map<string, FlowRef>;
  nodes: Map<string, NodeRef>;
}

export function flowIdFor(featureId: string, key: string): string {
  return key === MAIN ? featureId : key;
}

export function indexProject(project: Project): ProjectIndex {
  const map = project.map?.data ?? null;
  const index: ProjectIndex = { map, features: new Map(), components: new Map(), flows: new Map(), nodes: new Map() };
  for (const entry of map?.features ?? []) index.features.set(entry.id, { label: entry.label, file: null });
  for (const c of map?.components ?? []) index.components.set(c.id, c);
  for (const file of project.features) {
    const data = file.data;
    if (!data) continue;
    const feature = index.features.get(data.feature);
    if (feature && !feature.file) feature.file = file;
    for (const [key, flow] of Object.entries(data.flows)) {
      const id = flowIdFor(data.feature, key);
      if (!index.flows.has(id)) index.flows.set(id, { id, key, featureId: data.feature, file, flow });
      flow.nodes.forEach((node, i) => {
        if (!index.nodes.has(node.id)) index.nodes.set(node.id, { id: node.id, flowId: id, featureId: data.feature, file, index: i, node });
      });
    }
  }
  for (const ref of index.nodes.values()) {
    const target = 'expands' in ref.node ? ref.node.expands : undefined;
    const child = target ? index.flows.get(target) : undefined;
    if (child && child.file === ref.file && child.parentNodeId === undefined) child.parentNodeId = ref.id;
  }
  return index;
}

class Collector {
  readonly issues: Issue[] = [];
  add(file: LoadedFile<unknown>, path: readonly PropertyKey[], severity: Severity, code: string, message: string) {
    this.issues.push({ file: file.path, ...positionOf(file, path), severity, code, message });
  }
  addAt(file: string, severity: Severity, code: string, message: string) {
    this.issues.push({ file, line: 1, col: 1, severity, code, message });
  }
}

function checkIds(project: Project, out: Collector) {
  const seen = new Map<string, string>();
  const claim = (id: string, what: string, file: LoadedFile<unknown>, path: PropertyKey[]) => {
    const prev = seen.get(id);
    if (prev) {
      out.add(file, path, 'error', 'duplicate-id', `id "${id}" is already used by ${prev}; every id must be unique across the whole plan`);
    } else {
      seen.set(id, `${what} in ${file.path}`);
    }
  };
  const mapFile = project.map;
  if (mapFile?.data) {
    mapFile.data.features.forEach((f, i) => claim(f.id, `feature "${f.label}"`, mapFile, ['features', i, 'id']));
    mapFile.data.components.forEach((c, i) => claim(c.id, `component "${c.label}"`, mapFile, ['components', i, 'id']));
  }
  for (const file of project.features) {
    if (!file.data) continue;
    for (const [key, flow] of Object.entries(file.data.flows)) {
      if (key !== MAIN) claim(key, `flow "${flow.label}"`, file, ['flows', key]);
      flow.nodes.forEach((n, i) => claim(n.id, `node "${n.label}"`, file, ['flows', key, 'nodes', i, 'id']));
    }
  }
}

function checkFeatureFiles(project: Project, index: ProjectIndex, out: Collector) {
  const filesByFeature = new Map<string, LoadedFile<FeatureFile>>();
  for (const file of project.features) {
    if (!file.data) continue;
    const id = file.data.feature;
    if (file.path !== featurePath(id)) {
      out.add(file, ['feature'], 'error', 'feature-file-mismatch', `file must be named ${featurePath(id)} to match feature "${id}"`);
    }
    if (!index.features.has(id)) {
      out.add(file, ['feature'], 'error', 'file-not-in-map', `feature "${id}" is not listed under "features" in plan/map.yaml`);
    }
    if (!(MAIN in file.data.flows)) {
      out.add(file, ['flows'], 'error', 'missing-main', `feature "${id}" needs a "main" flow`);
    }
    filesByFeature.set(id, file);
  }
  const mapFile = project.map;
  mapFile?.data?.features.forEach((f, i) => {
    if (!filesByFeature.has(f.id) && !project.features.some((pf) => pf.path === featurePath(f.id))) {
      out.add(mapFile, ['features', i], 'warning', 'feature-without-flows', `feature "${f.id}" has no flows yet (no ${featurePath(f.id)})`);
    }
  });
}

function checkFlows(project: Project, index: ProjectIndex, out: Collector) {
  const parents = new Map<string, string[]>(); // flow id -> node ids expanding it
  for (const file of project.features) {
    const data = file.data;
    if (!data) continue;
    for (const [key, flow] of Object.entries(data.flows)) {
      const nodeIds = new Set(flow.nodes.map((n) => n.id));
      flow.nodes.forEach((node, i) => {
        const path = ['flows', key, 'nodes', i];
        if (node.type === 'step' || node.type === 'component') {
          if (node.expands !== undefined) {
            if (node.expands === MAIN) {
              out.add(file, [...path, 'expands'], 'error', 'expands-main', `"${node.id}" cannot expand the main flow`);
            } else if (!(node.expands in data.flows)) {
              out.add(file, [...path, 'expands'], 'error', 'unknown-expands', `"${node.id}" expands "${node.expands}", but no flow with that key exists in ${file.path}`);
            } else {
              parents.set(node.expands, [...(parents.get(node.expands) ?? []), node.id]);
              if (node.status !== undefined) {
                out.add(file, [...path, 'status'], 'warning', 'status-on-parent', `"${node.id}" has a child flow, so its status is computed from that flow; the stored status is ignored`);
              }
            }
          }
        }
        const refTargets = [index.flows, index.components, index.features];
        if (node.type === 'reference' && !refTargets.some((m) => m.has(node.ref))) {
          out.add(file, [...path, 'ref'], 'error', 'unknown-ref', `"${node.id}" references "${node.ref}", which is not a feature, flow or top-level component id`);
        }
      });
      const pairs = new Set<string>();
      flow.edges.forEach((edge, i) => {
        const path = ['flows', key, 'edges', i];
        for (const end of ['from', 'to'] as const) {
          if (!nodeIds.has(edge[end])) {
            out.add(file, [...path, end], 'error', 'edge-unknown-node', `edge ${end} "${edge[end]}" is not a node in flow "${key}" (nodes: ${[...nodeIds].join(', ') || 'none'})`);
          }
        }
        if (edge.from === edge.to) out.add(file, path, 'error', 'self-loop', `edge from "${edge.from}" to itself`);
        const pair = `${edge.from}->${edge.to}`;
        if (pairs.has(pair)) out.add(file, path, 'error', 'duplicate-edge', `duplicate edge ${edge.from} -> ${edge.to}`);
        pairs.add(pair);
        const from = flow.nodes.find((n) => n.id === edge.from);
        if (from?.type === 'decision' && !edge.label) {
          out.add(file, path, 'warning', 'decision-edge-unlabeled', `edge leaving decision "${edge.from}" should have a label (e.g. "yes"/"no")`);
        }
      });
    }
    for (const key of Object.keys(data.flows)) {
      if (key === MAIN) continue;
      const by = parents.get(key) ?? [];
      if (by.length === 0) {
        out.add(file, ['flows', key], 'warning', 'orphan-flow', `flow "${key}" is not expanded by any node`);
      } else if (by.length > 1) {
        out.add(file, ['flows', key], 'error', 'flow-multi-parent', `flow "${key}" is expanded by ${by.join(' and ')}; a flow has exactly one parent (use a reference node to reuse it)`);
      }
    }
    parents.clear();
  }
  // Cycles: walk up parent links from every flow; report each cycle once.
  const reported = new Set<string>();
  for (const flow of index.flows.values()) {
    const chain = [flow.id];
    let current = flow;
    while (current.parentNodeId) {
      const parentFlowId = index.nodes.get(current.parentNodeId)?.flowId;
      const parent = parentFlowId ? index.flows.get(parentFlowId) : undefined;
      if (!parent) break;
      const at = chain.indexOf(parent.id);
      if (at >= 0) {
        const cycle = chain.slice(at);
        const key = [...cycle].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          const first = index.flows.get([...cycle].sort()[0] as string) ?? flow;
          out.add(first.file, ['flows', first.key], 'error', 'cycle', `flows ${cycle.map((c) => `"${c}"`).join(', ')} expand each other in a loop`);
        }
        break;
      }
      chain.push(parent.id);
      current = parent;
    }
  }
}

function checkConnections(project: Project, index: ProjectIndex, out: Collector) {
  const mapFile = project.map;
  if (!mapFile?.data) return;
  const ends = new Set([...index.features.keys(), ...index.components.keys()]);
  const pairs = new Set<string>();
  mapFile.data.connections.forEach((c, i) => {
    for (const end of ['from', 'to'] as const) {
      if (!ends.has(c[end])) {
        out.add(mapFile, ['connections', i, end], 'error', 'connection-unknown-endpoint', `connection ${end} "${c[end]}" is not a feature or top-level component`);
      }
    }
    const pair = `${c.from}->${c.to}`;
    if (pairs.has(pair)) out.add(mapFile, ['connections', i], 'error', 'duplicate-edge', `duplicate connection ${pair}`);
    pairs.add(pair);
  });
}

export function validateProject(project: Project): Issue[] {
  const out = new Collector();
  if (!project.map) out.addAt('plan/map.yaml', 'error', 'missing-map', 'plan/map.yaml is missing');
  const fileIssues = [project.map, ...project.features].flatMap((f) => f?.issues ?? []);
  const index = indexProject(project);
  checkIds(project, out);
  checkFeatureFiles(project, index, out);
  checkFlows(project, index, out);
  checkConnections(project, index, out);
  return [...fileIssues, ...out.issues].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
}

export function errorsOf(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.severity === 'error');
}

export interface Progress {
  done: number;
  total: number;
}

/** Done/total over work nodes; a node with a child flow counts as that flow's work. */
export function flowProgress(index: ProjectIndex, flowId: string, seen = new Set<string>()): Progress {
  const ref = index.flows.get(flowId);
  if (!ref || seen.has(flowId)) return { done: 0, total: 0 };
  seen.add(flowId);
  const sum: Progress = { done: 0, total: 0 };
  for (const node of ref.flow.nodes) {
    if (!WORK_TYPES.has(node.type)) continue;
    const child = 'expands' in node && node.expands ? index.flows.get(node.expands) : undefined;
    if (child && child.parentNodeId === node.id) {
      const p = flowProgress(index, child.id, seen);
      sum.done += p.done;
      sum.total += p.total;
    } else {
      sum.total += 1;
      if ('status' in node && node.status === 'done') sum.done += 1;
    }
  }
  return sum;
}

export function rollup(project: Project): Map<string, Progress> {
  const index = indexProject(project);
  const out = new Map<string, Progress>();
  for (const id of index.flows.keys()) out.set(id, flowProgress(index, id));
  for (const id of index.features.keys()) if (!out.has(id)) out.set(id, { done: 0, total: 0 });
  return out;
}
