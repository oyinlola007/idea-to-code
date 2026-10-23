// Turns plan file contents into a project model. Parsing and schema checks
// happen here; rules that span files are applied by validate.ts. No I/O:
// callers pass the file contents in, keyed by path relative to the project.
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import type { z } from 'zod';
import { FeatureFile, MapFile } from './schema.js';

export type Severity = 'error' | 'warning';

export interface Issue {
  file: string;
  line: number;
  col: number;
  severity: Severity;
  code: string;
  message: string;
}

export interface LoadedFile<T> {
  path: string;
  text: string;
  doc: Document;
  lineCounter: LineCounter;
  data: T | null;
  issues: Issue[];
}

export interface Project {
  map: LoadedFile<MapFile> | null;
  features: LoadedFile<FeatureFile>[];
}

export const MAP_PATH = 'plan/map.yaml';
export const FEATURES_DIR = 'plan/features';

export function featurePath(featureId: string): string {
  return `${FEATURES_DIR}/${featureId}.yaml`;
}

interface Ranged {
  range?: [number, number, number] | null;
}

/** Start offset of the entry at `segment` inside `parent`: the key for map entries, the item for sequences. */
function entryStart(parent: unknown, segment: PropertyKey): number | undefined {
  if (isMap(parent)) {
    const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === segment);
    return (pair?.key as Ranged | undefined)?.range?.[0];
  }
  if (isSeq(parent) && typeof segment === 'number') {
    return (parent.items[segment] as Ranged | undefined)?.range?.[0];
  }
  return undefined;
}

/** Line and column (1-based) of the entry at `path`, or of its nearest existing ancestor. */
export function positionOf(file: LoadedFile<unknown>, path: readonly PropertyKey[]): { line: number; col: number } {
  for (let depth = path.length; depth > 0; depth--) {
    const parent = depth === 1 ? file.doc.contents : file.doc.getIn(path.slice(0, depth - 1) as unknown[], true);
    const segment = path[depth - 1];
    if (segment === undefined) continue;
    const start = entryStart(parent, segment);
    if (start !== undefined) return file.lineCounter.linePos(start);
  }
  return { line: 1, col: 1 };
}

const WORK_ONLY_KEYS = new Set(['status', 'expands']);

function schemaIssues(file: LoadedFile<unknown>, error: z.ZodError): Issue[] {
  return error.issues.map((issue) => {
    const pos = positionOf(file, issue.path);
    let code = 'schema';
    let message = `${issue.path.join('.') || '(root)'}: ${issue.message}`;
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys;
      const misplaced = keys.find((k) => WORK_ONLY_KEYS.has(k));
      if (misplaced) {
        code = `${misplaced}-not-allowed`;
        message = `${issue.path.join('.')}: only step and component nodes can have "${misplaced}"`;
      } else {
        code = 'unknown-key';
        message = `${issue.path.join('.') || '(root)'}: unknown key(s) ${keys.map((k) => `"${k}"`).join(', ')}`;
        if (keys.some((k) => /\s/.test(k))) {
          message +=
            '. This usually means a comma inside an unquoted value in { } inline style: quote the text, or write one field per line';
        }
      }
    }
    return { file: file.path, ...pos, severity: 'error' as const, code, message };
  });
}

function parseFile<T>(path: string, text: string, schema: z.ZodType<T>): LoadedFile<T> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const file: LoadedFile<T> = { path, text, doc, lineCounter, data: null, issues: [] };
  if (doc.errors.length > 0) {
    file.issues = doc.errors.map((err) => {
      const pos = lineCounter.linePos(err.pos[0]);
      return { file: path, ...pos, severity: 'error' as const, code: 'yaml-syntax', message: err.message.split('\n')[0] ?? err.message };
    });
    return file;
  }
  const result = schema.safeParse(doc.toJS() ?? {});
  if (result.success) {
    file.data = result.data;
  } else {
    file.issues = schemaIssues(file, result.error);
  }
  return file;
}

/** Builds a project from file contents keyed by path relative to the project root. */
export function loadFromTexts(files: Readonly<Record<string, string>>): Project {
  const mapText = files[MAP_PATH];
  const map = mapText === undefined ? null : parseFile(MAP_PATH, mapText, MapFile);
  const features = Object.entries(files)
    .filter(([p]) => p.startsWith(`${FEATURES_DIR}/`) && p.endsWith('.yaml'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, text]) => parseFile(p, text, FeatureFile));
  return { map, features };
}

/** Plan file contents of a project, keyed by relative path. */
export function projectTexts(project: Project): Record<string, string> {
  const out: Record<string, string> = {};
  if (project.map) out[project.map.path] = project.map.text;
  for (const f of project.features) out[f.path] = f.text;
  return out;
}
