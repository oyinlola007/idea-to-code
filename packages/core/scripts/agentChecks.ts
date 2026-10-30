// Checks that a coding agent did what a task asked, on top of the validator.
import type { Project } from '../src/load.js';
import { errorsOf, indexProject, MAIN, validateProject, type ProjectIndex } from '../src/validate.js';

export interface Check {
  passed: boolean;
  failures: string[];
  errors: string[];
}

function finish(after: Project, failures: string[]): Check {
  const errors = errorsOf(validateProject(after)).map((i) => `${i.file}:${i.line} [${i.code}] ${i.message}`);
  return { passed: failures.length === 0 && errors.length === 0, failures, errors };
}

function otherNodes(index: ProjectIndex, skip: string): string {
  const rows = [...index.nodes.values()].filter((n) => n.id !== skip).map((n) => JSON.stringify(n.node));
  return rows.sort().join('\n');
}

function nothingRemoved(before: ProjectIndex, after: ProjectIndex, failures: string[]): void {
  const gone = [...before.nodes.keys()].filter((id) => !after.nodes.has(id));
  if (gone.length > 0) failures.push(`nodes removed or renamed: ${gone.join(', ')}`);
}

/** In every flow with several nodes, each node is touched by at least one edge. */
function connected(index: ProjectIndex, flowIds: string[], failures: string[]): void {
  for (const id of flowIds) {
    const flow = index.flows.get(id)?.flow;
    if (!flow || flow.nodes.length < 2) continue;
    const touched = new Set(flow.edges.flatMap((e) => [e.from, e.to]));
    const loose = flow.nodes.filter((n) => !touched.has(n.id)).map((n) => n.id);
    if (loose.length > 0) failures.push(`flow "${id}" has unconnected nodes: ${loose.join(', ')}`);
  }
}

export function markDone(before: Project, after: Project, nodeId: string): Check {
  const failures: string[] = [];
  const b = indexProject(before);
  const a = indexProject(after);
  const node = a.nodes.get(nodeId)?.node;
  if (!node) failures.push(`node "${nodeId}" is missing`);
  else if (!('status' in node) || node.status !== 'done') failures.push(`node "${nodeId}" is not done`);
  if (otherNodes(b, nodeId) !== otherNodes(a, nodeId)) failures.push('other nodes changed too');
  return finish(after, failures);
}

export function addChildFlow(before: Project, after: Project, nodeId: string, min = 4, max = 6): Check {
  const failures: string[] = [];
  const a = indexProject(after);
  nothingRemoved(indexProject(before), a, failures);
  const ref = a.nodes.get(nodeId);
  const target = ref && 'expands' in ref.node ? ref.node.expands : undefined;
  const child = target ? a.flows.get(target) : undefined;
  if (!target) failures.push(`node "${nodeId}" has no expands`);
  else if (!child) failures.push(`flow "${target}" does not exist`);
  else {
    if (child.file !== ref?.file) failures.push('child flow is in a different file');
    // The task asks for steps; start, end and decision nodes are the flow's shape, not its size.
    const n = child.flow.nodes.filter((node) => node.type === 'step').length;
    if (n < min || n > max) failures.push(`child flow has ${n} steps, expected ${min}-${max}`);
    connected(a, [child.id], failures);
  }
  return finish(after, failures);
}

export function generatedFeature(
  before: Project,
  after: Project,
  x: { featureId: string; minMainNodes: number; requiredRef: string; duplicatePattern: RegExp },
): Check {
  const failures: string[] = [];
  const b = indexProject(before);
  const a = indexProject(after);
  nothingRemoved(b, a, failures);
  const feature = a.features.get(x.featureId);
  if (!feature?.file) {
    failures.push(`feature "${x.featureId}" has no flows file`);
    return finish(after, failures);
  }
  const main = feature.file.data?.flows[MAIN];
  if (!main || main.nodes.length < x.minMainNodes)
    failures.push(`main flow has ${main?.nodes.length ?? 0} nodes, expected at least ${x.minMainNodes}`);
  const flowIds = [...a.flows.values()].filter((f) => f.featureId === x.featureId).map((f) => f.id);
  if (flowIds.length < 2) failures.push('no child flow was added');
  const nodes = [...a.nodes.values()].filter((n) => n.featureId === x.featureId).map((n) => n.node);
  if (!nodes.some((n) => n.type === 'reference' && n.ref === x.requiredRef)) failures.push(`no reference to ${x.requiredRef}`);
  connected(a, flowIds, failures);
  const dupes = [...a.features.entries()].filter(
    ([id, f]) => id !== x.featureId && !b.features.has(id) && x.duplicatePattern.test(`${id} ${f.label}`),
  );
  if (dupes.length > 0)
    failures.push(`created a duplicate feature instead of filling "${x.featureId}": ${dupes.map(([id]) => id).join(', ')}`);
  return finish(after, failures);
}
