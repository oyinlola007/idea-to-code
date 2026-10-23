// Comment-preserving operations on plan files. Each operation edits fresh
// yaml Documents, re-validates the whole project, and is rejected (leaving
// the workspace untouched) if it introduced new errors.
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { allIds, slugify, uniqueId } from './ids.js';
import { featurePath, loadFromTexts, MAP_PATH, type Issue, type Project } from './load.js';
import type { NodeType, Status } from './schema.js';
import { errorsOf, indexProject, MAIN, validateProject, type ProjectIndex } from './validate.js';

export type OpResult =
  | { ok: true; changedFiles: string[]; created?: Record<string, string>; warnings?: string[] }
  | { ok: false; error: string };

class OpError extends Error {}

interface OpContext {
  project: Project;
  index: ProjectIndex;
  ids: Set<string>;
  doc(path: string): Document;
  createFile(path: string, value: unknown): void;
}

function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
}

function issueKey(i: Issue): string {
  return `${i.code}|${i.message}`;
}

function formatIssues(issues: Issue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.file}:${i.line} [${i.code}] ${i.message}`)
    .join('; ');
}

/** Appends to a sequence at `path`, matching the style (flow `{}` or block) of its last item. */
function appendTo(doc: Document, path: (string | number)[], value: unknown) {
  const node = doc.createNode(value);
  const seq = doc.getIn(path, true);
  if (isSeq(seq)) {
    const items = (seq as YAMLSeq).items;
    const last = items.at(-1);
    // An empty `[]` becomes a block list; otherwise follow the existing style.
    if (items.length === 0) (seq as YAMLSeq).flow = false;
    else if (isMap(last) && (last as YAMLMap).flow && isMap(node)) node.flow = true;
    items.push(node);
  } else {
    doc.setIn(path, doc.createNode([value]));
  }
}

export class PlanWorkspace {
  private current: Record<string, string>;
  private cached: Project | null = null;

  constructor(texts: Record<string, string>) {
    this.current = { ...texts };
  }

  get texts(): Readonly<Record<string, string>> {
    return this.current;
  }

  get project(): Project {
    this.cached ??= loadFromTexts(this.current);
    return this.cached;
  }

  issues(): Issue[] {
    return validateProject(this.project);
  }

  private run(fn: (ctx: OpContext) => Omit<Extract<OpResult, { ok: true }>, 'ok' | 'changedFiles'> | void): OpResult {
    const before = this.project;
    const docs = new Map<string, Document>();
    const created = new Map<string, Document>();
    const ctx: OpContext = {
      project: before,
      index: indexProject(before),
      ids: allIds(before),
      doc: (path) => {
        let d = docs.get(path) ?? created.get(path);
        if (!d) {
          const text = this.current[path];
          if (text === undefined) throw new OpError(`file ${path} does not exist`);
          d = parseDocument(text);
          docs.set(path, d);
        }
        return d;
      },
      createFile: (path, value) => {
        if (this.current[path] !== undefined) throw new OpError(`file ${path} already exists`);
        created.set(path, new Document(value));
      },
    };
    let extra: ReturnType<typeof fn>;
    try {
      extra = fn(ctx);
    } catch (err) {
      if (err instanceof OpError) return { ok: false, error: err.message };
      throw err;
    }
    const next = { ...this.current };
    for (const [path, d] of [...docs, ...created]) next[path] = d.toString({ lineWidth: 0 });
    const beforeErrors = new Set(errorsOf(validateProject(before)).map(issueKey));
    const afterIssues = validateProject(loadFromTexts(next));
    const introduced = errorsOf(afterIssues).filter((i) => !beforeErrors.has(issueKey(i)));
    if (introduced.length > 0) {
      return { ok: false, error: `change rejected, it would make the plan invalid: ${formatIssues(introduced)}` };
    }
    this.current = next;
    this.cached = null;
    const changedFiles = [...docs.keys(), ...created.keys()];
    return { ok: true, changedFiles, ...(extra ?? {}) };
  }

  addFeature(args: { label: string; description?: string }): OpResult {
    return this.run((ctx) => {
      if (!ctx.project.map) throw new OpError('plan/map.yaml is missing');
      const id = uniqueId(slugify(args.label), ctx.ids);
      appendTo(ctx.doc(MAP_PATH), ['features'], clean({ id, label: args.label, description: args.description }));
      ctx.createFile(featurePath(id), { feature: id, flows: { [MAIN]: { label: args.label, nodes: [], edges: [] } } });
      return { created: { featureId: id, flowId: id } };
    });
  }

  addNode(args: {
    flowId: string;
    type: NodeType;
    label: string;
    description?: string;
    status?: Status;
    kind?: string;
    tech?: string;
    ref?: string;
  }): OpResult {
    return this.run((ctx): { created: Record<string, string> } => {
      const id = uniqueId(slugify(args.label), ctx.ids);
      const node = clean({ id, type: args.type, label: args.label, description: args.description, status: args.status, kind: args.kind, tech: args.tech, ref: args.ref });
      const listed = ctx.index.features.get(args.flowId);
      if (!ctx.index.flows.has(args.flowId) && listed && !listed.file) {
        // First node of a feature that is listed in map.yaml but has no file yet.
        ctx.createFile(featurePath(args.flowId), { feature: args.flowId, flows: { [MAIN]: { label: listed.label, nodes: [node], edges: [] } } });
        return { created: { nodeId: id, file: featurePath(args.flowId) } };
      }
      const flow = requireFlow(ctx, args.flowId);
      appendTo(ctx.doc(flow.file.path), ['flows', flow.key, 'nodes'], node);
      return { created: { nodeId: id } };
    });
  }

  updateNode(args: { id: string; label?: string; description?: string; status?: Status; kind?: string; tech?: string; ref?: string }): OpResult {
    return this.run((ctx) => {
      const ref = requireNode(ctx, args.id);
      const doc = ctx.doc(ref.file.path);
      const base = ['flows', ctx.index.flows.get(ref.flowId)!.key, 'nodes', ref.index];
      const fields = clean({ label: args.label, description: args.description, status: args.status, kind: args.kind, tech: args.tech, ref: args.ref });
      if (Object.keys(fields).length === 0) throw new OpError('nothing to update: pass at least one of label, description, status, kind, tech, ref');
      for (const [key, value] of Object.entries(fields)) doc.setIn([...base, key], value);
    });
  }

  setStatus(args: { id: string; status: Status }): OpResult {
    return this.updateNode({ id: args.id, status: args.status });
  }

  removeNode(args: { id: string }): OpResult {
    return this.run((ctx) => {
      const ref = requireNode(ctx, args.id);
      const doc = ctx.doc(ref.file.path);
      const flowKey = ctx.index.flows.get(ref.flowId)!.key;
      const removedFlows: string[] = [];
      const dropFlowTree = (key: string) => {
        const flow = ref.file.data!.flows[key];
        if (!flow) return;
        for (const n of flow.nodes) if ('expands' in n && n.expands) dropFlowTree(n.expands);
        doc.deleteIn(['flows', key]);
        removedFlows.push(key);
      };
      if ('expands' in ref.node && ref.node.expands) dropFlowTree(ref.node.expands);
      const edges = ref.file.data!.flows[flowKey]!.edges;
      for (let i = edges.length - 1; i >= 0; i--) {
        if (edges[i]!.from === args.id || edges[i]!.to === args.id) doc.deleteIn(['flows', flowKey, 'edges', i]);
      }
      doc.deleteIn(['flows', flowKey, 'nodes', ref.index]);
      return removedFlows.length ? { warnings: [`also removed child flow(s): ${removedFlows.join(', ')}`] } : undefined;
    });
  }

  addEdge(args: { flowId: string; from: string; to: string; label?: string; data?: string }): OpResult {
    return this.run((ctx) => {
      const flow = requireFlow(ctx, args.flowId);
      appendTo(ctx.doc(flow.file.path), ['flows', flow.key, 'edges'], clean({ from: args.from, to: args.to, label: args.label, data: args.data }));
    });
  }

  removeEdge(args: { flowId: string; from: string; to: string }): OpResult {
    return this.run((ctx) => {
      const flow = requireFlow(ctx, args.flowId);
      const i = flow.flow.edges.findIndex((e) => e.from === args.from && e.to === args.to);
      if (i < 0) throw new OpError(`no edge ${args.from} -> ${args.to} in flow "${args.flowId}"`);
      ctx.doc(flow.file.path).deleteIn(['flows', flow.key, 'edges', i]);
    });
  }

  expandNode(args: { id: string; label?: string }): OpResult {
    return this.run((ctx) => {
      const ref = requireNode(ctx, args.id);
      if (ref.node.type !== 'step' && ref.node.type !== 'component') {
        throw new OpError(`"${args.id}" is a ${ref.node.type}; only step and component nodes can have a child flow`);
      }
      if (ref.node.expands) throw new OpError(`"${args.id}" already has a child flow "${ref.node.expands}"; add nodes to that flow instead`);
      const key = uniqueId(`${args.id}-flow`, ctx.ids);
      const doc = ctx.doc(ref.file.path);
      const flowKey = ctx.index.flows.get(ref.flowId)!.key;
      doc.setIn(['flows', key], doc.createNode({ label: args.label ?? ref.node.label, nodes: [], edges: [] }));
      doc.setIn(['flows', flowKey, 'nodes', ref.index, 'expands'], key);
      if ('status' in ref.node && ref.node.status !== undefined) doc.deleteIn(['flows', flowKey, 'nodes', ref.index, 'status']);
      return { created: { flowId: key } };
    });
  }

  connectFeatures(args: { from: string; to: string; data?: string; label?: string }): OpResult {
    return this.run((ctx) => {
      if (!ctx.project.map) throw new OpError('plan/map.yaml is missing');
      appendTo(ctx.doc(MAP_PATH), ['connections'], clean({ from: args.from, to: args.to, data: args.data, label: args.label }));
    });
  }
}

function requireFlow(ctx: OpContext, flowId: string) {
  const flow = ctx.index.flows.get(flowId);
  if (!flow) {
    const known = [...ctx.index.flows.keys()].join(', ');
    throw new OpError(`no flow "${flowId}". A feature's top-level flow has the feature's id. Known flows: ${known || 'none'}`);
  }
  return flow;
}

function requireNode(ctx: OpContext, id: string) {
  const ref = ctx.index.nodes.get(id);
  if (!ref) {
    const close = [...ctx.index.nodes.keys()].filter((k) => k.includes(id.split('-')[0] ?? id)).slice(0, 8);
    throw new OpError(`no node "${id}"${close.length ? `. Similar ids: ${close.join(', ')}` : ''}`);
  }
  return ref;
}
