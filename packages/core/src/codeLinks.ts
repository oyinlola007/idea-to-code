// Links from the plan to the code that builds it (`implements:`). Pure: core lists
// the links with their positions and says which paths are allowed; each host checks
// which ones exist (the editor's file system, or Node's) and gets issues back.
import { positionOf, type Issue, type LoadedFile, type Project } from './load.js';
import { nodeLabel } from './schema.js';
import { indexProject } from './validate.js';

export const MAX_CODE_LINK = 300;

/** Why a link can't be used, or null. Links stay inside the project: relative, with "/" and no "..". */
export function checkCodeLinkPath(path: string): string | null {
  if (path.trim() === '') return 'it is empty';
  if (path.length > MAX_CODE_LINK) return `it is longer than ${String(MAX_CODE_LINK)} characters`;
  if (path.includes('\\') || path.includes('\0')) return 'it must use "/" between folders';
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return 'it must be relative to the project';
  const parts = normalizeCodeLink(path).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return 'it must stay inside the project';
  return null;
}

/** A folder may be written with a trailing "/": the same link without it. */
export function normalizeCodeLink(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

export interface CodeLink {
  path: string;
  /** The step, component or shared component it belongs to. */
  nodeId: string;
  label: string;
  file: string;
  line: number;
  col: number;
}

function linksIn(
  file: LoadedFile<unknown>,
  base: (string | number)[],
  nodeId: string,
  label: string,
  paths: readonly string[],
): CodeLink[] {
  return paths.map((path, i) => ({ path, nodeId, label, file: file.path, ...positionOf(file, [...base, 'implements', i]) }));
}

/** Every link in the plan, in file order, with where it's written. */
export function codeLinksOf(project: Project): CodeLink[] {
  const links: CodeLink[] = [];
  const map = project.map;
  map?.data?.components.forEach((c, i) => {
    if (c.implements) links.push(...linksIn(map, ['components', i], c.id, c.label, c.implements));
  });
  for (const flow of indexProject(project).flows.values()) {
    flow.flow.nodes.forEach((node, i) => {
      if ((node.type === 'step' || node.type === 'component') && node.implements)
        links.push(...linksIn(flow.file, ['flows', flow.key, 'nodes', i], node.id, nodeLabel(node), node.implements));
    });
  }
  return links;
}

/** The distinct paths worth checking on disk: allowed ones only, never anything outside the project. */
export function codeLinkPaths(project: Project): string[] {
  return [...new Set(codeLinksOf(project).flatMap((l) => (checkCodeLinkPath(l.path) === null ? [normalizeCodeLink(l.path)] : [])))];
}

/** A warning for each link whose path the host found missing. */
export function missingCodeLinkIssues(project: Project, missing: ReadonlySet<string>): Issue[] {
  return codeLinksOf(project)
    .filter((l) => missing.has(normalizeCodeLink(l.path)))
    .map((l) => ({
      file: l.file,
      line: l.line,
      col: l.col,
      severity: 'warning' as const,
      code: 'code-link-missing',
      message: `"${l.label}" links to ${l.path}, which doesn't exist. Update the link or remove it`,
    }));
}
