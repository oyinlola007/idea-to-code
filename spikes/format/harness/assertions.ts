// Checks that an agent did what a task asked, on top of the validator.
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

function nodesWithout(index: ProjectIndex, skip: (id: string) => boolean): string {
  const rows = [...index.nodes.values()].filter((n) => !skip(n.id)).map((n) => JSON.stringify(n.node));
  return rows.sort().join('\n');
}

/** Every node that existed before still exists. */
function nothingRemoved(before: ProjectIndex, after: ProjectIndex, failures: string[]) {
  const gone = [...before.nodes.keys()].filter((id) => !after.nodes.has(id));
  if (gone.length) failures.push(`nodes removed or renamed: ${gone.join(', ')}`);
}

/** In every flow with several nodes, each node is touched by at least one edge. */
function connected(index: ProjectIndex, flowIds: string[], failures: string[]) {
  for (const id of flowIds) {
    const flow = index.flows.get(id)?.flow;
    if (!flow || flow.nodes.length < 2) continue;
    const touched = new Set(flow.edges.flatMap((e) => [e.from, e.to]));
    const loose = flow.nodes.filter((n) => !touched.has(n.id)).map((n) => n.id);
    if (loose.length) failures.push(`flow "${id}" has unconnected nodes: ${loose.join(', ')}`);
  }
}

export function markDone(before: Project, after: Project, nodeId: string): Check {
  const failures: string[] = [];
  const b = indexProject(before);
  const a = indexProject(after);
  const node = a.nodes.get(nodeId)?.node;
  if (!node) failures.push(`node "${nodeId}" is missing`);
  else if (!('status' in node) || node.status !== 'done') failures.push(`node "${nodeId}" is not done`);
  if (nodesWithout(b, (id) => id === nodeId) !== nodesWithout(a, (id) => id === nodeId)) failures.push('other nodes changed too');
  return finish(after, failures);
}

export function addChildFlow(before: Project, after: Project, nodeId: string, min = 4, max = 8): Check {
  const failures: string[] = [];
  const a = indexProject(after);
  nothingRemoved(indexProject(before), a, failures);
  const ref = a.nodes.get(nodeId);
  const target = ref && 'expands' in ref.node ? ref.node.expands : undefined;
  const child = target ? a.flows.get(target) : undefined;
  if (!target) failures.push(`node "${nodeId}" has no expands`);
  else if (!child) failures.push(`flow "${target}" does not exist`);
  else {
    if (child.file !== ref!.file) failures.push('child flow is in a different file');
    const n = child.flow.nodes.length;
    if (n < min || n > max) failures.push(`child flow has ${n} nodes, expected ${min}-${max}`);
    connected(a, [child.id], failures);
  }
  return finish(after, failures);
}

export interface FeatureExpectations {
  featureId: string;
  minMainNodes?: number;
  requireChildFlow?: boolean;
  requireLlm?: boolean;
  /** Labels that would mean the agent created a duplicate feature instead of filling the existing one. */
  duplicatePattern?: RegExp;
}

export function generatedFeature(before: Project, after: Project, x: FeatureExpectations): Check {
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
  const minMain = x.minMainNodes ?? 5;
  if (!main || main.nodes.length < minMain) failures.push(`main flow has ${main?.nodes.length ?? 0} nodes, expected at least ${minMain}`);
  const flowIds = [...a.flows.values()].filter((f) => f.featureId === x.featureId).map((f) => f.id);
  if ((x.requireChildFlow ?? true) && flowIds.length < 2) failures.push('no child flow was added');
  if (x.requireLlm) {
    const nodes = [...a.nodes.values()].filter((n) => n.featureId === x.featureId).map((n) => n.node);
    const llm = nodes.some((n) => (n.type === 'reference' && n.ref === 'llm-api') || (n.type === 'component' && /llm|ai|model/i.test(`${n.kind} ${n.label} ${n.tech ?? ''}`)));
    if (!llm) failures.push('no LLM component or reference to llm-api');
  }
  connected(a, flowIds, failures);
  if (x.duplicatePattern) {
    const dupes = [...a.features.entries()].filter(([id, f]) => id !== x.featureId && !b.features.has(id) && x.duplicatePattern!.test(`${id} ${f.label}`));
    if (dupes.length) failures.push(`created a duplicate feature instead of filling "${x.featureId}": ${dupes.map(([id]) => id).join(', ')}`);
  }
  return finish(after, failures);
}
