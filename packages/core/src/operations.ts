// The engine behind every plan edit. An operation edits fresh yaml Documents
// (so comments survive), the whole project is re-validated, and the edit is
// refused if it introduced new errors. Pure: file contents in, file contents
// out; writing to disk belongs to the caller. A bad request never throws.
import { Document, isMap, isSeq, parseDocument } from 'yaml';
import type { z } from 'zod';
import { allIds } from './ids.js';
import { featurePath, loadFromTexts, MAP_PATH, type Issue, type LoadedFile, type Project } from './load.js';
import type { FeatureFile } from './schema.js';
import { errorsOf, indexProject, validateProject, type FlowRef, type NodeRef, type ProjectIndex } from './validate.js';

export interface OpSuccess {
  ok: true;
  /** The full new set of plan files. */
  texts: Record<string, string>;
  /** Files created or modified. */
  changed: string[];
  /** Files removed. */
  deleted: string[];
  /** IDs the caller needs next, e.g. nodeId, flowId, or fill_flow's keys. */
  created: Record<string, string>;
  /** What else happened or should be looked at: cascades, new validator warnings. */
  warnings: string[];
}

export type OpErrorCode = 'unknown-operation' | 'invalid-input' | 'not-found' | 'not-allowed' | 'file-invalid' | 'rejected';

export interface OpFailure {
  ok: false;
  code: OpErrorCode;
  message: string;
}

export type OpResult = OpSuccess | OpFailure;

export interface OpRequest {
  name: string;
  input: unknown;
}

/** A refusal raised while applying an operation; the engine turns it into an OpFailure. */
export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OpContext {
  project: Project;
  index: ProjectIndex;
  /** Every ID in use; add generated IDs here so later ones in the same operation stay unique. */
  ids: Set<string>;
  /** The editable document for a file. Refuses a file that can't be parsed. */
  doc(path: string): Document;
  createFile(path: string, value: unknown): void;
  deleteFile(path: string): void;
  warn(message: string): void;
}

export interface Operation {
  name: string;
  description: string;
  input: z.ZodType;
  execute(ctx: OpContext, input: unknown): Record<string, string> | undefined;
}

/** Defines one operation; the input is parsed before `apply` runs, so `apply` sees checked values. */
export function defineOperation<S extends z.ZodType>(def: {
  name: string;
  description: string;
  input: S;
  apply: (ctx: OpContext, input: z.output<S>) => Record<string, string> | undefined;
}): Operation {
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    execute(ctx, input) {
      const parsed = def.input.safeParse(input);
      if (!parsed.success) {
        const reasons = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
        throw new OpError('invalid-input', `invalid input for ${def.name}: ${reasons}`);
      }
      return def.apply(ctx, parsed.data);
    },
  };
}

function issueKey(i: Issue): string {
  return `${i.code}|${i.message}`;
}

function formatIssues(issues: Issue[]): string {
  const shown = issues.slice(0, 5).map((i) => `${i.file}:${i.line} [${i.code}] ${i.message}`);
  if (issues.length > shown.length) shown.push(`and ${issues.length - shown.length} more`);
  return shown.join('; ');
}

function brokenFile(project: Project, path: string): LoadedFile<unknown> | undefined {
  const file = path === MAP_PATH ? project.map : project.features.find((f) => f.path === path);
  return file?.data === null ? file : undefined;
}

export function fileInvalid(file: LoadedFile<unknown>): OpError {
  const first = file.issues[0];
  return new OpError(
    'file-invalid',
    `fix ${file.path} first: ${first ? `${file.path}:${first.line} ${first.message}` : 'it could not be read'}`,
  );
}

/** Applies one operation from `operations` to the given plan files. */
export function runOperation(operations: readonly Operation[], texts: Readonly<Record<string, string>>, request: OpRequest): OpResult {
  const operation = operations.find((o) => o.name === request.name);
  if (!operation) {
    return {
      ok: false,
      code: 'unknown-operation',
      message: `unknown operation "${request.name}". Known: ${operations.map((o) => o.name).join(', ')}`,
    };
  }

  const before = loadFromTexts(texts);
  const docs = new Map<string, Document>();
  const createdFiles = new Map<string, Document>();
  const deletedFiles = new Set<string>();
  const warnings: string[] = [];
  const ctx: OpContext = {
    project: before,
    index: indexProject(before),
    ids: allIds(before),
    doc(path) {
      const existing = docs.get(path) ?? createdFiles.get(path);
      if (existing) return existing;
      const broken = brokenFile(before, path);
      if (broken) throw fileInvalid(broken);
      const text = texts[path];
      if (text === undefined) throw new OpError('not-found', `${path} does not exist`);
      const parsed = parseDocument(text);
      docs.set(path, parsed);
      return parsed;
    },
    createFile(path, value) {
      if (texts[path] !== undefined) throw new OpError('not-allowed', `${path} already exists`);
      createdFiles.set(path, new Document(value));
    },
    deleteFile(path) {
      deletedFiles.add(path);
    },
    warn(message) {
      warnings.push(message);
    },
  };

  let created: Record<string, string> | undefined;
  try {
    created = operation.execute(ctx, request.input);
  } catch (err) {
    if (err instanceof OpError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }

  const next: Record<string, string> = { ...texts };
  for (const [path, doc] of [...docs, ...createdFiles]) next[path] = doc.toString({ lineWidth: 0 });
  for (const path of deletedFiles) Reflect.deleteProperty(next, path);

  // Only what this edit broke counts, so a plan with an unrelated broken file stays editable.
  const beforeIssues = new Set(validateProject(before).map(issueKey));
  const afterIssues = validateProject(loadFromTexts(next)).filter((i) => !beforeIssues.has(issueKey(i)));
  const introduced = errorsOf(afterIssues);
  if (introduced.length > 0) {
    return { ok: false, code: 'rejected', message: `change rejected, it would make the plan invalid: ${formatIssues(introduced)}` };
  }
  for (const issue of afterIssues) warnings.push(`${issue.file}:${issue.line} [${issue.code}] ${issue.message}`);

  return {
    ok: true,
    texts: next,
    changed: [...docs.keys(), ...createdFiles.keys()].filter((p) => !deletedFiles.has(p)),
    deleted: [...deletedFiles],
    created: created ?? {},
    warnings,
  };
}

/** Appends to a sequence: an empty `[]` becomes a block list; otherwise it follows the style already there. */
export function appendTo(doc: Document, path: (string | number)[], value: unknown): void {
  const node = doc.createNode(value);
  const seq = doc.getIn(path, true);
  if (isSeq(seq)) {
    const last = seq.items.at(-1);
    if (seq.items.length === 0) seq.flow = false;
    else if (isMap(last) && last.flow === true && isMap(node)) node.flow = true;
    seq.items.push(node);
  } else {
    doc.setIn(path, doc.createNode([value]));
  }
}

/** Sets fields on the map at `base`: undefined leaves a field alone, null removes it. */
export function setFields(doc: Document, base: (string | number)[], fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) doc.deleteIn([...base, key]);
    else doc.setIn([...base, key], value);
  }
}

/** Refuses an update that wouldn't change anything. */
export function requireSomeField(fields: Record<string, unknown>, names: string): void {
  if (Object.values(fields).every((v) => v === undefined))
    throw new OpError('invalid-input', `nothing to update: pass at least one of ${names}`);
}

/** Why something can't be found might be a file that can't be read, so say so. */
function unreadableHint(ctx: OpContext): string {
  const broken = [ctx.project.map, ...ctx.project.features].filter((f) => f?.data === null).map((f) => f?.path);
  return broken.length > 0 ? `. Note: ${broken.join(', ')} can't be read, so anything in it isn't visible; fix that first` : '';
}

export function requireFlow(ctx: OpContext, flowId: string): FlowRef {
  const flow = ctx.index.flows.get(flowId);
  if (flow) return flow;
  const broken = brokenFile(ctx.project, featurePath(flowId));
  if (broken) throw fileInvalid(broken);
  const known = [...ctx.index.flows.keys()].join(', ');
  throw new OpError(
    'not-found',
    `no flow "${flowId}". A feature's top-level flow has the feature's id. Known flows: ${known || 'none'}${unreadableHint(ctx)}`,
  );
}

export function requireNode(ctx: OpContext, id: string): NodeRef {
  const ref = ctx.index.nodes.get(id);
  if (ref) return ref;
  const stem = id.split('-')[0] ?? id;
  const close = [...ctx.index.nodes.keys()].filter((k) => k.includes(stem)).slice(0, 8);
  throw new OpError('not-found', `no node "${id}"${close.length > 0 ? `. Similar ids: ${close.join(', ')}` : ''}${unreadableHint(ctx)}`);
}

/** The YAML path of a node inside its file. */
export function nodePath(ctx: OpContext, ref: NodeRef): (string | number)[] {
  return ['flows', requireFlow(ctx, ref.flowId).key, 'nodes', ref.index];
}

/** The parsed flows of a node's file, which is known to be readable because the node was indexed from it. */
export function flowsOf(file: LoadedFile<FeatureFile>): FeatureFile['flows'] {
  return file.data?.flows ?? {};
}
