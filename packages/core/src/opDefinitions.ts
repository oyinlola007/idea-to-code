// Every edit a plan can receive, defined once. The UI, the chat agent and the
// MCP server all go through this list, and agent tool definitions are generated
// from it (tools.ts). On update operations, a missing field stays as it is and
// null removes it.
import { z } from 'zod';
import { slugify, uniqueId } from './ids.js';
import { featurePath, MAP_PATH } from './load.js';
import {
  appendTo,
  defineOperation,
  fileInvalid,
  flowsOf,
  nodePath,
  OpError,
  requireFlow,
  requireNode,
  requireSomeField,
  runOperation,
  setFields,
  type OpContext,
  type Operation,
  type OpRequest,
  type OpResult,
} from './operations.js';
import { nodeLabel, Status, type NodeType } from './schema.js';
import { MAIN } from './validate.js';

const Text = z.string().min(1);
const Id = z.string().min(1).describe('An existing id');
const NODE_TYPES = ['start', 'end', 'step', 'decision', 'component', 'reference'] as const;
const NodeTypeInput = z.enum(NODE_TYPES);

const nodeFieldInputs = {
  label: Text.optional().describe('Required, except on start and end nodes'),
  description: Text.optional(),
  status: Status.optional().describe('Only on step and component nodes'),
  kind: Text.optional().describe('Component nodes: e.g. database, server, queue, service, external-api'),
  tech: Text.optional().describe('Component nodes: the technology, e.g. PostgreSQL'),
  ref: Text.optional().describe('Reference nodes: a feature, flow or shared component id'),
};

interface NodeFields {
  label?: string | undefined;
  description?: string | undefined;
  status?: Status | undefined;
  kind?: string | undefined;
  tech?: string | undefined;
  ref?: string | undefined;
}

function checkNodeFields(type: NodeType, fields: NodeFields, where: string): void {
  if (type !== 'start' && type !== 'end' && !fields.label) throw new OpError('invalid-input', `${where}: a ${type} node needs a label`);
  if (type === 'component' && !fields.kind)
    throw new OpError('invalid-input', `${where}: a component node needs a kind (e.g. database, server, queue)`);
  if (type === 'reference' && !fields.ref)
    throw new OpError('invalid-input', `${where}: a reference node needs ref (a feature, flow or shared component id)`);
}

/** A new node with a generated ID, without empty fields, in the order the canonical style writes them. */
function buildNode(ctx: OpContext, flowId: string, type: NodeType, fields: NodeFields): Record<string, unknown> {
  const id = uniqueId(slugify(fields.label ?? `${flowId}-${type}`), ctx.ids);
  ctx.ids.add(id);
  const node: Record<string, unknown> = { id, type };
  for (const key of ['label', 'description', 'status', 'kind', 'tech', 'ref'] as const) {
    const value = fields[key];
    if (value !== undefined) node[key] = value;
  }
  return node;
}

/** Appends nodes and edges to a flow. A feature listed in map.yaml with no file yet gets its file now. */
function writeToFlow(
  ctx: OpContext,
  flowId: string,
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
): string | undefined {
  const listed = ctx.index.features.get(flowId);
  if (!ctx.index.flows.has(flowId) && listed && !listed.file) {
    const path = featurePath(flowId);
    const unreadable = ctx.project.features.find((f) => f.path === path);
    if (unreadable) throw fileInvalid(unreadable);
    ctx.createFile(path, { feature: flowId, flows: { [MAIN]: { label: listed.label, nodes, edges } } });
    return path;
  }
  const flow = requireFlow(ctx, flowId);
  const doc = ctx.doc(flow.file.path);
  for (const node of nodes) appendTo(doc, ['flows', flow.key, 'nodes'], node);
  for (const edge of edges) appendTo(doc, ['flows', flow.key, 'edges'], edge);
  return undefined;
}

function definedOnly<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function hasChildFlow(ctx: OpContext, id: string): boolean {
  const node = requireNode(ctx, id).node;
  if (node.type !== 'step' && node.type !== 'component') return false;
  return node.expands !== undefined && ctx.index.flows.get(node.expands)?.parentNodeId === id;
}

function refuseStatusOnParent(ctx: OpContext, id: string): void {
  if (hasChildFlow(ctx, id)) {
    throw new OpError(
      'not-allowed',
      `"${id}" has a child flow, so its progress is computed from that flow. Set the status of the nodes inside it instead`,
    );
  }
}

function mapData(ctx: OpContext) {
  // Going through doc() first refuses a map that can't be read.
  const doc = ctx.doc(MAP_PATH);
  const data = ctx.project.map?.data;
  if (!data) throw new OpError('not-found', 'plan/map.yaml is missing');
  return { doc, data };
}

/** Removes every overview connection touching an id, reporting them. */
function dropConnections(ctx: OpContext, id: string): void {
  const { doc, data } = mapData(ctx);
  const removed: string[] = [];
  for (let i = data.connections.length - 1; i >= 0; i--) {
    const c = data.connections[i];
    if (c && (c.from === id || c.to === id)) {
      doc.deleteIn(['connections', i]);
      removed.unshift(`${c.from} -> ${c.to}`);
    }
  }
  if (removed.length > 0) ctx.warn(`also removed connection(s): ${removed.join(', ')}`);
}

function connectionIndex(ctx: OpContext, from: string, to: string): number {
  const i = mapData(ctx).data.connections.findIndex((c) => c.from === from && c.to === to);
  if (i < 0) throw new OpError('not-found', `no connection ${from} -> ${to} in the overview`);
  return i;
}

function edgeIndex(ctx: OpContext, flowId: string, from: string, to: string): number {
  const i = requireFlow(ctx, flowId).flow.edges.findIndex((e) => e.from === from && e.to === to);
  if (i < 0) throw new OpError('not-found', `no edge ${from} -> ${to} in flow "${flowId}"`);
  return i;
}

export const OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: 'add_feature',
    description: 'Add a new feature to the overview, with an empty top-level flow. Do not use this for features already listed.',
    input: z.strictObject({ label: Text, description: Text.optional() }),
    apply(ctx, { label, description }) {
      const { doc } = mapData(ctx);
      const id = uniqueId(slugify(label), ctx.ids);
      appendTo(doc, ['features'], definedOnly({ id, label, description }));
      ctx.createFile(featurePath(id), { feature: id, flows: { [MAIN]: { label, nodes: [], edges: [] } } });
      return { featureId: id, flowId: id };
    },
  }),
  defineOperation({
    name: 'update_feature',
    description:
      "Rename a feature or change its description. The id never changes. The feature's top-level flow follows the new name if it had the old one.",
    input: z.strictObject({ id: Id, label: Text.optional(), description: Text.nullable().optional() }),
    apply(ctx, { id, label, description }) {
      requireSomeField({ label, description }, 'label, description');
      const { doc, data } = mapData(ctx);
      const i = data.features.findIndex((f) => f.id === id);
      const feature = data.features[i];
      if (!feature)
        throw new OpError('not-found', `no feature "${id}". Known features: ${data.features.map((f) => f.id).join(', ') || 'none'}`);
      setFields(doc, ['features', i], { label, description });
      const file = ctx.index.features.get(id)?.file;
      if (label !== undefined && file && flowsOf(file)[MAIN]?.label === feature.label)
        ctx.doc(file.path).setIn(['flows', MAIN, 'label'], label);
      return undefined;
    },
  }),
  defineOperation({
    name: 'remove_feature',
    description: 'Remove a feature, its file and its overview connections. Refused while another flow still references it.',
    input: z.strictObject({ id: Id }),
    apply(ctx, { id }) {
      const { doc, data } = mapData(ctx);
      const i = data.features.findIndex((f) => f.id === id);
      if (i < 0)
        throw new OpError('not-found', `no feature "${id}". Known features: ${data.features.map((f) => f.id).join(', ') || 'none'}`);
      dropConnections(ctx, id);
      doc.deleteIn(['features', i]);
      if (ctx.project.features.some((f) => f.path === featurePath(id))) {
        ctx.deleteFile(featurePath(id));
        ctx.warn(`also removed ${featurePath(id)}`);
      }
      return undefined;
    },
  }),
  defineOperation({
    name: 'add_component',
    description: 'Add a shared component to the overview (database, server, queue, external API…), which several features can reference.',
    input: z.strictObject({ label: Text, kind: Text, tech: Text.optional(), description: Text.optional(), status: Status.optional() }),
    apply(ctx, { label, kind, tech, description, status }) {
      const { doc } = mapData(ctx);
      const id = uniqueId(slugify(label), ctx.ids);
      appendTo(doc, ['components'], definedOnly({ id, label, kind, tech, description, status }));
      return { componentId: id };
    },
  }),
  defineOperation({
    name: 'update_component',
    description: "Change a shared component's label, kind, tech, description or status. The id never changes.",
    input: z.strictObject({
      id: Id,
      label: Text.optional(),
      kind: Text.optional(),
      tech: Text.nullable().optional(),
      description: Text.nullable().optional(),
      status: Status.nullable().optional(),
    }),
    apply(ctx, { id, ...fields }) {
      requireSomeField(fields, 'label, kind, tech, description, status');
      const { doc, data } = mapData(ctx);
      const i = data.components.findIndex((c) => c.id === id);
      if (i < 0)
        throw new OpError('not-found', `no component "${id}". Known components: ${data.components.map((c) => c.id).join(', ') || 'none'}`);
      setFields(doc, ['components', i], fields);
      return undefined;
    },
  }),
  defineOperation({
    name: 'remove_component',
    description: 'Remove a shared component and its overview connections. Refused while a reference node still points at it.',
    input: z.strictObject({ id: Id }),
    apply(ctx, { id }) {
      const { doc, data } = mapData(ctx);
      const i = data.components.findIndex((c) => c.id === id);
      if (i < 0)
        throw new OpError('not-found', `no component "${id}". Known components: ${data.components.map((c) => c.id).join(', ') || 'none'}`);
      dropConnections(ctx, id);
      doc.deleteIn(['components', i]);
      return undefined;
    },
  }),
  defineOperation({
    name: 'connect_features',
    description: 'Connect two features (or a feature and a shared component) in the overview, with the data passed between them.',
    input: z.strictObject({ from: Id, to: Id, label: Text.optional(), data: Text.optional() }),
    apply(ctx, { from, to, label, data }) {
      appendTo(mapData(ctx).doc, ['connections'], definedOnly({ from, to, label, data }));
      return undefined;
    },
  }),
  defineOperation({
    name: 'update_connection',
    description: 'Change the label or data of an overview connection.',
    input: z.strictObject({ from: Id, to: Id, label: Text.nullable().optional(), data: Text.nullable().optional() }),
    apply(ctx, { from, to, label, data }) {
      requireSomeField({ label, data }, 'label, data');
      setFields(mapData(ctx).doc, ['connections', connectionIndex(ctx, from, to)], { label, data });
      return undefined;
    },
  }),
  defineOperation({
    name: 'disconnect_features',
    description: 'Remove an overview connection.',
    input: z.strictObject({ from: Id, to: Id }),
    apply(ctx, { from, to }) {
      mapData(ctx).doc.deleteIn(['connections', connectionIndex(ctx, from, to)]);
      return undefined;
    },
  }),
  defineOperation({
    name: 'add_node',
    description:
      'Add a node to a flow and get its generated id. For type "component" pass kind (e.g. database, server, queue, service, external-api) and optionally tech. For type "reference" pass ref (a feature, flow or shared component id). Only step and component nodes take a status. To add several nodes and edges, use fill_flow.',
    input: z.strictObject({ flowId: Id, type: NodeTypeInput, ...nodeFieldInputs }),
    apply(ctx, { flowId, type, ...fields }) {
      checkNodeFields(type, fields, 'add_node');
      const node = buildNode(ctx, flowId, type, fields);
      const file = writeToFlow(ctx, flowId, [node], []);
      return { nodeId: String(node.id), ...(file ? { file } : {}) };
    },
  }),
  defineOperation({
    name: 'update_node',
    description: "Change a node's label, description, status, kind, tech or ref. The id never changes.",
    input: z.strictObject({
      id: Id,
      label: Text.optional(),
      description: Text.nullable().optional(),
      status: Status.nullable().optional(),
      kind: Text.optional(),
      tech: Text.nullable().optional(),
      ref: Text.optional(),
    }),
    apply(ctx, { id, ...fields }) {
      requireSomeField(fields, 'label, description, status, kind, tech, ref');
      const ref = requireNode(ctx, id);
      if (fields.status) refuseStatusOnParent(ctx, id);
      setFields(ctx.doc(ref.file.path), nodePath(ctx, ref), fields);
      return undefined;
    },
  }),
  defineOperation({
    name: 'set_status',
    description:
      'Mark a step or component node todo, in_progress or done. A node with a child flow gets its progress from that flow instead.',
    input: z.strictObject({ id: Id, status: Status }),
    apply(ctx, { id, status }) {
      const ref = requireNode(ctx, id);
      refuseStatusOnParent(ctx, id);
      setFields(ctx.doc(ref.file.path), nodePath(ctx, ref), { status });
      return undefined;
    },
  }),
  defineOperation({
    name: 'remove_node',
    description: 'Remove a node, its edges and its child flows. Refused if another flow still references one of those child flows.',
    input: z.strictObject({ id: Id }),
    apply(ctx, { id }) {
      const ref = requireNode(ctx, id);
      const doc = ctx.doc(ref.file.path);
      const flows = flowsOf(ref.file);
      const flowKey = requireFlow(ctx, ref.flowId).key;
      const removedFlows: string[] = [];
      const dropFlowTree = (key: string) => {
        const flow = flows[key];
        if (!flow || removedFlows.includes(key)) return;
        removedFlows.push(key);
        for (const n of flow.nodes) if ('expands' in n && n.expands) dropFlowTree(n.expands);
        doc.deleteIn(['flows', key]);
      };
      if ('expands' in ref.node && ref.node.expands) dropFlowTree(ref.node.expands);
      const edges = flows[flowKey]?.edges ?? [];
      for (let i = edges.length - 1; i >= 0; i--) {
        const edge = edges[i];
        if (edge && (edge.from === id || edge.to === id)) doc.deleteIn(['flows', flowKey, 'edges', i]);
      }
      doc.deleteIn(nodePath(ctx, ref));
      if (removedFlows.length > 0) ctx.warn(`also removed child flow(s): ${removedFlows.join(', ')}`);
      return undefined;
    },
  }),
  defineOperation({
    name: 'add_edge',
    description: 'Connect two nodes of the same flow ("flows into"). Use label for decision branches and data for what is passed along.',
    input: z.strictObject({ flowId: Id, from: Id, to: Id, label: Text.optional(), data: Text.optional() }),
    apply(ctx, { flowId, from, to, label, data }) {
      const flow = requireFlow(ctx, flowId);
      appendTo(ctx.doc(flow.file.path), ['flows', flow.key, 'edges'], definedOnly({ from, to, label, data }));
      return undefined;
    },
  }),
  defineOperation({
    name: 'update_edge',
    description: 'Change the label or data of an edge between two nodes of a flow.',
    input: z.strictObject({ flowId: Id, from: Id, to: Id, label: Text.nullable().optional(), data: Text.nullable().optional() }),
    apply(ctx, { flowId, from, to, label, data }) {
      requireSomeField({ label, data }, 'label, data');
      const flow = requireFlow(ctx, flowId);
      setFields(ctx.doc(flow.file.path), ['flows', flow.key, 'edges', edgeIndex(ctx, flowId, from, to)], { label, data });
      return undefined;
    },
  }),
  defineOperation({
    name: 'remove_edge',
    description: 'Remove the edge between two nodes of a flow.',
    input: z.strictObject({ flowId: Id, from: Id, to: Id }),
    apply(ctx, { flowId, from, to }) {
      const flow = requireFlow(ctx, flowId);
      ctx.doc(flow.file.path).deleteIn(['flows', flow.key, 'edges', edgeIndex(ctx, flowId, from, to)]);
      return undefined;
    },
  }),
  defineOperation({
    name: 'expand_node',
    description: 'Give a step or component node a child flow for more detail. Returns the new flow id; then add to it with fill_flow.',
    input: z.strictObject({ id: Id, label: Text.optional() }),
    apply(ctx, { id, label }) {
      const ref = requireNode(ctx, id);
      const node = ref.node;
      if (node.type !== 'step' && node.type !== 'component') {
        throw new OpError('not-allowed', `"${id}" is a ${node.type}; only step and component nodes can have a child flow`);
      }
      if (node.expands)
        throw new OpError('not-allowed', `"${id}" already has a child flow "${node.expands}"; add nodes to that flow instead`);
      const flowId = uniqueId(`${id}-flow`, ctx.ids);
      const doc = ctx.doc(ref.file.path);
      doc.setIn(['flows', flowId], doc.createNode({ label: label ?? nodeLabel(node), nodes: [], edges: [] }));
      setFields(doc, nodePath(ctx, ref), { expands: flowId, status: node.status === undefined ? undefined : null });
      return { flowId };
    },
  }),
  defineOperation({
    name: 'fill_flow',
    description:
      'Write several nodes and edges into a flow in one call, all or nothing. Give each new node a short key; edges use those keys, or the ids of nodes already in the flow. Returns each key with its generated id. Prefer this to many add_node and add_edge calls.',
    input: z.strictObject({
      flowId: Id,
      nodes: z
        .array(
          z.strictObject({
            key: Text.describe('A short name for this node, used by edges in this call'),
            type: NodeTypeInput,
            ...nodeFieldInputs,
          }),
        )
        .default([]),
      edges: z
        .array(
          z.strictObject({
            from: Text.describe('A key from this call, or the id of a node in the flow'),
            to: Text.describe('A key from this call, or the id of a node in the flow'),
            label: Text.optional(),
            data: Text.optional(),
          }),
        )
        .default([]),
    }),
    apply(ctx, { flowId, nodes, edges }) {
      if (nodes.length === 0 && edges.length === 0) throw new OpError('invalid-input', 'fill_flow needs at least one node or edge');
      const existing = new Set(ctx.index.flows.get(flowId)?.flow.nodes.map((n) => n.id));
      const idsByKey = new Map<string, string>();
      const newNodes = nodes.map(({ key, type, ...fields }) => {
        if (idsByKey.has(key)) throw new OpError('invalid-input', `duplicate key "${key}" in nodes`);
        checkNodeFields(type, fields, `node "${key}"`);
        const node = buildNode(ctx, flowId, type, fields);
        idsByKey.set(key, String(node.id));
        return node;
      });
      const resolve = (end: string): string => {
        const id = idsByKey.get(end) ?? (existing.has(end) ? end : undefined);
        if (id === undefined) {
          const valid = [...idsByKey.keys(), ...existing].join(', ') || 'none';
          throw new OpError(
            'invalid-input',
            `edge end "${end}" is neither a key from this call nor a node in flow "${flowId}". Valid: ${valid}`,
          );
        }
        return id;
      };
      const newEdges = edges.map((e) => definedOnly({ from: resolve(e.from), to: resolve(e.to), label: e.label, data: e.data }));
      const file = writeToFlow(ctx, flowId, newNodes, newEdges);
      return { ...Object.fromEntries(idsByKey), ...(file ? { file } : {}) };
    },
  }),
];

/** Applies one plan edit: file contents in, new file contents (or the reason it was refused) out. */
export function applyOperation(texts: Readonly<Record<string, string>>, request: OpRequest): OpResult {
  return runOperation(OPERATIONS, texts, request);
}
