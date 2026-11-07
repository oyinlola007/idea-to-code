// Plain-text views of a plan, for agents: the outline of everything, one flow in full,
// and where the user is. The built-in chat sends them every turn, and the read tools
// return them; the MCP server can use the same ones.
import { featurePath, type Project } from './load.js';
import { flowProgress, OVERVIEW } from './progress.js';
import { nodeLabel, type PlanNode } from './schema.js';
import { indexProject, type ProjectIndex } from './validate.js';

function progressText(index: ProjectIndex, flowId: string): string {
  const p = flowProgress(index, flowId);
  return p.total > 0 ? `${String(p.done)}/${String(p.total)} done` : 'no steps yet';
}

/** Why a feature has no flows to show: none yet, or a file that can't be read. */
function featureState(project: Project, index: ProjectIndex, id: string): string {
  if (index.features.get(id)?.file) return progressText(index, id);
  const broken = project.features.find((f) => f.path === featurePath(id) && f.data === null);
  return broken ? `can't be read: fix ${broken.path}` : 'no flows yet';
}

function nodeSummary(node: PlanNode): string {
  const parts: string[] = [node.type];
  if (node.type === 'component') parts.push(`kind=${node.kind}${node.tech ? `, tech=${node.tech}` : ''}`);
  if (node.type === 'reference') parts.push(`ref=${node.ref}`);
  if ((node.type === 'step' || node.type === 'component') && node.status) parts.push(`status=${node.status}`);
  if ((node.type === 'step' || node.type === 'component') && node.implements?.length) parts.push(`code=${node.implements.join(' ')}`);
  return parts.join(', ');
}

/** The labels from the overview down to a level, e.g. Overview › Bookings › Take deposit. */
export function breadcrumb(index: ProjectIndex, level: string): string[] {
  const chain: string[] = [];
  let flow = level === OVERVIEW ? undefined : index.flows.get(level);
  while (flow) {
    chain.unshift(flow.flow.label);
    const parentFlowId = flow.parentNodeId ? index.nodes.get(flow.parentNodeId)?.flowId : undefined;
    flow = parentFlowId ? index.flows.get(parentFlowId) : undefined;
  }
  return ['Overview', ...chain];
}

/** The overview's features, one per line, with their progress. */
export function listFeatures(project: Project): string {
  const index = indexProject(project);
  const lines = [...index.features].map(([id, f]) => `- ${id}: ${f.label} (${featureState(project, index, id)})`);
  return lines.join('\n') || '(no features yet)';
}

/** Every feature and child flow with progress, the shared components and the connections. No node details. */
export function getOutline(project: Project): string {
  const index = indexProject(project);
  const out: string[] = [`Project: ${index.map?.project ?? '(map.yaml is missing or broken)'}`];
  if (index.map?.description) out.push(`Description: ${index.map.description}`);
  out.push('', "Features (a feature's top-level flow id is the feature id):");
  const childFlows = (flowId: string, depth: number) => {
    for (const node of index.flows.get(flowId)?.flow.nodes ?? []) {
      const target = 'expands' in node ? node.expands : undefined;
      const child = target ? index.flows.get(target) : undefined;
      if (child?.parentNodeId !== node.id) continue;
      out.push(`${'  '.repeat(depth)}- flow ${child.id}: ${child.flow.label} (under node ${node.id}; ${progressText(index, child.id)})`);
      childFlows(child.id, depth + 1);
    }
  };
  const listed = index.map?.features ?? [];
  for (const [id, feature] of index.features) {
    const description = listed.find((f) => f.id === id)?.description;
    out.push(`- ${id}: ${feature.label} (${featureState(project, index, id)})${description ? ` — ${description}` : ''}`);
    if (feature.file) childFlows(id, 1);
  }
  if (index.features.size === 0) out.push('(no features yet)');
  if (index.components.size > 0) {
    out.push('', 'Shared components (include one in a flow with a reference node):');
    for (const c of index.components.values()) {
      const code = c.implements?.length ? `, code=${c.implements.join(' ')}` : '';
      out.push(`- ${c.id}: ${c.label} (${c.kind}${c.tech ? `, ${c.tech}` : ''}${c.status ? `, status=${c.status}` : ''}${code})`);
    }
  }
  const connections = index.map?.connections ?? [];
  if (connections.length > 0) {
    out.push('', 'Connections between features:');
    for (const c of connections) out.push(`- ${c.from} -> ${c.to}${c.data ? ` [data: ${c.data}]` : ''}${c.label ? ` (${c.label})` : ''}`);
  }
  return out.join('\n');
}

/** One flow in full: every node with its description, and every edge. */
export function getFlow(project: Project, flowId: string): string {
  const index = indexProject(project);
  const ref = index.flows.get(flowId);
  if (!ref) {
    const known = [...index.flows.keys()].join(', ');
    return `No flow "${flowId}". A feature's top-level flow has the feature's id. Known flows: ${known || 'none'}`;
  }
  const out = [
    `Flow ${ref.id}: ${ref.flow.label} (${progressText(index, ref.id)})`,
    `Path: ${breadcrumb(index, ref.id).join(' › ')}`,
    `File: ${ref.file.path}`,
  ];
  if (ref.flow.description) out.push(`Description: ${ref.flow.description}`);
  out.push('', 'Nodes:');
  for (const node of ref.flow.nodes) {
    const expands = 'expands' in node && node.expands ? `, expands=${node.expands} (${progressText(index, node.expands)})` : '';
    out.push(`- ${node.id}: "${nodeLabel(node)}" (${nodeSummary(node)}${expands})${node.description ? ` — ${node.description}` : ''}`);
  }
  if (ref.flow.nodes.length === 0) out.push('(none)');
  out.push('', 'Edges:');
  for (const e of ref.flow.edges) out.push(`- ${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ''}${e.data ? ` [data: ${e.data}]` : ''}`);
  if (ref.flow.edges.length === 0) out.push('(none)');
  return out.join('\n');
}

/** What the agent sees each turn: the outline, the flow the user is looking at, and where they are. */
export function mapView(project: Project, level: string): string {
  const index = indexProject(project);
  const current = index.flows.has(level) ? level : OVERVIEW;
  const parts = ['## The plan', getOutline(project)];
  if (current !== OVERVIEW) parts.push('', '## The flow the user is looking at', getFlow(project, current));
  parts.push('', `## Where the user is`, `${breadcrumb(index, current).join(' › ')} (level id: ${current})`);
  return parts.join('\n');
}
