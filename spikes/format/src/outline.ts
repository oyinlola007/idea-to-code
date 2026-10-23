// Plain-text views of the plan that agents receive as context. The shape is
// what the built-in chat (ITC-16) will send: an outline of everything, plus
// the full flow the user is looking at.
import type { Project } from './load.js';
import { nodeLabel, type PlanNode } from './schema.js';
import { flowProgress, indexProject, type ProjectIndex } from './validate.js';

function progressText(index: ProjectIndex, flowId: string): string {
  const p = flowProgress(index, flowId);
  return p.total ? `${p.done}/${p.total} done` : 'no work items yet';
}

function nodeSummary(n: PlanNode): string {
  const parts: string[] = [n.type];
  if (n.type === 'component') parts.push(`kind=${n.kind}${n.tech ? `, tech=${n.tech}` : ''}`);
  if (n.type === 'reference') parts.push(`ref=${n.ref}`);
  if ((n.type === 'step' || n.type === 'component') && n.status) parts.push(`status=${n.status}`);
  return parts.join(', ');
}

/** Ancestors of a flow from the overview down, as labels. */
export function breadcrumb(index: ProjectIndex, flowId: string | 'overview'): string[] {
  if (flowId === 'overview') return ['Overview'];
  const chain: string[] = [];
  let flow = index.flows.get(flowId);
  while (flow) {
    chain.unshift(flow.flow.label);
    const parentFlowId = flow.parentNodeId ? index.nodes.get(flow.parentNodeId)?.flowId : undefined;
    flow = parentFlowId ? index.flows.get(parentFlowId) : undefined;
  }
  return ['Overview', ...chain];
}

export function listFeatures(project: Project): string {
  const index = indexProject(project);
  const lines = [...index.features].map(([id, f]) => `- ${id}: ${f.label} (${f.file ? progressText(index, id) : 'no flows yet'})`);
  return lines.join('\n') || '(no features yet)';
}

export function getOutline(project: Project): string {
  const index = indexProject(project);
  const out: string[] = [`Project: ${index.map?.project ?? '(no map)'}`, '', 'Features (flow id = feature id):'];
  const childFlows = (flowId: string, depth: number) => {
    const ref = index.flows.get(flowId);
    if (!ref) return;
    for (const n of ref.flow.nodes) {
      const target = 'expands' in n ? n.expands : undefined;
      const child = target ? index.flows.get(target) : undefined;
      if (child && child.parentNodeId === n.id) {
        out.push(`${'  '.repeat(depth)}- flow ${child.id}: ${child.flow.label} (under node ${n.id}; ${progressText(index, child.id)})`);
        childFlows(child.id, depth + 1);
      }
    }
  };
  for (const [id, f] of index.features) {
    out.push(`- ${id}: ${f.label} (${f.file ? progressText(index, id) : 'no flows yet'})`);
    if (f.file) childFlows(id, 1);
  }
  if (index.components.size) {
    out.push('', 'Shared components (use a reference node to include one in a flow):');
    for (const c of index.components.values()) out.push(`- ${c.id}: ${c.label} (${c.kind}${c.tech ? `, ${c.tech}` : ''})`);
  }
  const connections = index.map?.connections ?? [];
  if (connections.length) {
    out.push('', 'Connections between features:');
    for (const c of connections) out.push(`- ${c.from} -> ${c.to}${c.data ? ` [data: ${c.data}]` : ''}${c.label ? ` (${c.label})` : ''}`);
  }
  return out.join('\n');
}

export function getFlow(project: Project, flowId: string): string {
  const index = indexProject(project);
  const ref = index.flows.get(flowId);
  if (!ref) return `No flow "${flowId}". Known flows: ${[...index.flows.keys()].join(', ')}`;
  const out = [`Flow ${ref.id}: ${ref.flow.label} (${progressText(index, ref.id)})`, `Path: ${breadcrumb(index, ref.id).join(' › ')}`, `File: ${ref.file.path}`];
  if (ref.flow.description) out.push(`Description: ${ref.flow.description}`);
  out.push('', 'Nodes:');
  for (const n of ref.flow.nodes) {
    const expands = 'expands' in n && n.expands ? `, expands=${n.expands} (${progressText(index, n.expands)})` : '';
    out.push(`- ${n.id}: "${nodeLabel(n)}" (${nodeSummary(n)}${expands})${n.description ? ` — ${n.description}` : ''}`);
  }
  if (ref.flow.nodes.length === 0) out.push('(none)');
  out.push('', 'Edges:');
  for (const e of ref.flow.edges) out.push(`- ${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ''}${e.data ? ` [data: ${e.data}]` : ''}`);
  if (ref.flow.edges.length === 0) out.push('(none)');
  return out.join('\n');
}

/** What the agent sees each turn: the outline, the flow being viewed, and where the user is. */
export function mapView(project: Project, current: string | 'overview'): string {
  const index = indexProject(project);
  const parts = ['## Current plan', getOutline(project)];
  if (current !== 'overview' && index.flows.has(current)) {
    parts.push('', '## Flow the user is viewing', getFlow(project, current));
  }
  parts.push('', `Current level: ${breadcrumb(index, current).join(' › ')}`);
  return parts.join('\n');
}
