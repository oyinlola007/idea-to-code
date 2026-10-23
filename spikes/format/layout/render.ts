// Lays out every level of a plan with ELK, top-down and left-right, and
// writes a static HTML page for judging readability. Usage:
//   npm run layout -- [project-dir]   (default: fixtures/career-app)
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import { loadProject } from '../src/load.js';
import { nodeLabel } from '../src/schema.js';
import { breadcrumb } from '../src/outline.js';
import { flowProgress, indexProject, type ProjectIndex } from '../src/validate.js';

type Shape = 'feature' | 'step' | 'decision' | 'start' | 'end' | 'component' | 'reference';

interface VNode {
  id: string;
  shape: Shape;
  lines: string[];
  sub?: string;
  status?: string;
  progress?: string;
  expandable: boolean;
  kind?: string;
}

interface VEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

interface Level {
  id: string;
  title: string;
  nodes: VNode[];
  edges: VEdge[];
}

const CHAR_W = 7.2;
const LINE_H = 16;

function wrap(text: string, max = 26): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > max) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function sizeOf(n: VNode): { width: number; height: number } {
  const textLines = n.lines.length + (n.sub ? 1 : 0) + (n.progress ? 1 : 0);
  const longest = Math.max(...n.lines.map((l) => l.length), n.sub?.length ?? 0);
  let width = Math.max(120, Math.min(260, longest * CHAR_W + 36));
  let height = Math.max(48, textLines * LINE_H + 24);
  if (n.shape === 'decision') {
    width += 50;
    height += 36;
  }
  if (n.shape === 'start' || n.shape === 'end') height = Math.max(40, height - 8);
  return { width, height };
}

function progressText(index: ProjectIndex, flowId: string): string | undefined {
  const p = flowProgress(index, flowId);
  return p.total ? `${p.done}/${p.total} done` : undefined;
}

function buildLevels(index: ProjectIndex): Level[] {
  const levels: Level[] = [];
  const overview: Level = { id: 'overview', title: 'Overview', nodes: [], edges: [] };
  for (const [id, f] of index.features) {
    overview.nodes.push({ id, shape: 'feature', lines: wrap(f.label), expandable: !!f.file, progress: f.file ? progressText(index, id) ?? 'no work yet' : 'no flows yet' });
  }
  for (const c of index.components.values()) {
    overview.nodes.push({ id: c.id, shape: 'component', kind: c.kind, lines: wrap(c.label), sub: [c.kind, c.tech].filter(Boolean).join(' · '), expandable: false });
  }
  (index.map?.connections ?? []).forEach((c, i) => overview.edges.push({ id: `c${i}`, from: c.from, to: c.to, label: c.data ?? c.label }));
  levels.push(overview);

  for (const ref of index.flows.values()) {
    const level: Level = { id: ref.id, title: breadcrumb(index, ref.id).join(' › '), nodes: [], edges: [] };
    for (const n of ref.flow.nodes) {
      const expands = 'expands' in n ? n.expands : undefined;
      const vnode: VNode = { id: n.id, shape: n.type, lines: wrap(nodeLabel(n)), expandable: !!expands };
      if (n.type === 'component') {
        vnode.sub = [n.kind, n.tech].filter(Boolean).join(' · ');
        vnode.kind = n.kind;
      }
      if (n.type === 'reference') {
        vnode.sub = `↗ ${n.ref}`;
        const target = index.components.get(n.ref);
        if (target) vnode.kind = target.kind;
      }
      if ((n.type === 'step' || n.type === 'component') && !expands) vnode.status = n.status ?? 'todo';
      if (expands) vnode.progress = progressText(index, expands) ?? 'no work yet';
      level.nodes.push(vnode);
    }
    ref.flow.edges.forEach((e, i) => level.edges.push({ id: `e${i}`, from: e.from, to: e.to, label: [e.label, e.data].filter(Boolean).join(' · ') || undefined }));
    levels.push(level);
  }
  return levels;
}

// elkjs is CommonJS; load it directly so NodeNext typing stays simple.
const ElkCtor = createRequire(import.meta.url)('elkjs/lib/elk.bundled.js') as new () => { layout(graph: ElkNode): Promise<ElkNode> };
const elk = new ElkCtor();

/** Width left for the chart on a 1440px laptop with VS Code's chat panel open. */
const MAX_WIDTH = 960;

type Mode = 'DOWN' | 'WRAP';

/** Top-down, or left-to-right wrapped into rows that fit MAX_WIDTH and grow downward. */
async function layoutFor(level: Level, mode: Mode): Promise<ElkNode> {
  if (mode === 'DOWN') return layout(level, 'DOWN');
  let result = await layout(level, 'RIGHT');
  for (let ratio = 1.6; (result.width ?? 0) > MAX_WIDTH && ratio > 0.05; ratio *= 0.7) {
    result = await layout(level, 'RIGHT', { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': ratio.toFixed(3) });
  }
  return result;
}

async function layout(level: Level, direction: 'DOWN' | 'RIGHT', extra: Record<string, string> = {}) {
  const ids = new Set(level.nodes.map((n) => n.id));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': '40',
      'elk.spacing.edgeLabel': '6',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      ...extra,
    },
    children: level.nodes.map((n) => ({ id: n.id, ...sizeOf(n) })),
    edges: level.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map<ElkExtendedEdge>((e) => ({
        id: e.id,
        sources: [e.from],
        targets: [e.to],
        labels: e.label ? wrap(e.label, 30).map((t, i) => ({ id: `${e.id}-l${i}`, text: t, width: t.length * 6.4 + 8, height: 14 })) : [],
      })),
  };
  return elk.layout(graph);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Counts edge segments that pass through a node other than their own ends. */
function edgesThroughNodes(result: ElkNode): number {
  const rects = new Map((result.children ?? []).map((c) => [c.id, c as Rect]));
  let hits = 0;
  for (const e of result.edges ?? []) {
    const own = new Set([...e.sources, ...e.targets]);
    for (const s of e.sections ?? []) {
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        for (const [id, r] of rects) {
          if (own.has(id)) continue;
          const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
          if (maxX > r.x + 2 && minX < r.x + r.width - 2 && maxY > r.y + 2 && minY < r.y + r.height - 2) hits++;
        }
      }
    }
  }
  return hits;
}

function shapeSvg(n: VNode, r: Rect): string {
  const { x, y, width: w, height: h } = r;
  const cls = `node ${n.shape}${n.status ? ` status-${n.status}` : ''}${n.expandable ? ' expandable' : ''}`;
  const parts: string[] = [];
  if (n.expandable) parts.push(`<rect class="stack" x="${x + 5}" y="${y + 5}" width="${w}" height="${h}" rx="10"/>`);
  if (n.shape === 'decision') {
    parts.push(`<polygon class="${cls}" points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"/>`);
  } else if (n.shape === 'start' || n.shape === 'end') {
    parts.push(`<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`);
  } else if (n.kind === 'database') {
    parts.push(`<path class="${cls}" d="M${x},${y + 10} a${w / 2},10 0 0,0 ${w},0 v${h - 20} a${w / 2},10 0 0,1 ${-w},0 z M${x},${y + 10} a${w / 2},10 0 0,1 ${w},0"/>`);
  } else {
    const rx = n.shape === 'component' ? 4 : n.shape === 'feature' ? 14 : 10;
    const dash = n.shape === 'reference' ? ' stroke-dasharray="6 4"' : '';
    parts.push(`<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"${dash}/>`);
  }
  const lines = [...n.lines.map((t) => ({ t, c: 'label' })), ...(n.sub ? [{ t: n.sub, c: 'sub' }] : []), ...(n.progress ? [{ t: n.progress, c: 'progress' }] : [])];
  const top = y + h / 2 - ((lines.length - 1) * LINE_H) / 2 + (n.kind === 'database' ? 6 : 0);
  lines.forEach((l, i) => parts.push(`<text class="${l.c}" x="${x + w / 2}" y="${top + i * LINE_H}" dominant-baseline="middle" text-anchor="middle">${esc(l.t)}</text>`));
  return parts.join('');
}

function renderSvg(level: Level, result: ElkNode): string {
  const byId = new Map(level.nodes.map((n) => [n.id, n]));
  const w = Math.ceil(result.width ?? 0);
  const h = Math.ceil(result.height ?? 0);
  const edges = (result.edges ?? [])
    .map((e) => {
      const paths = (e.sections ?? []).map((s) => {
        const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
        return `<path class="edge" marker-end="url(#arrow)" d="M${pts.map((p) => `${p.x},${p.y}`).join(' L')}"/>`;
      });
      // Put the label on the middle of the edge's longest segment, so it always sits on its line.
      let mid = { x: 0, y: 0 };
      let longest = -1;
      for (const s of e.sections ?? []) {
        const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i]!;
          const b = pts[i + 1]!;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          if (len > longest) {
            longest = len;
            mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          }
        }
      }
      const texts = (e.labels ?? []).map((l) => l.text ?? '');
      const top = mid.y - ((texts.length - 1) * 13) / 2;
      const labels = texts.map((t, i) => `<text class="edge-label" x="${mid.x}" y="${top + i * 13}" text-anchor="middle" dominant-baseline="middle">${esc(t)}</text>`);
      return paths.join('') + labels.join('');
    })
    .join('');
  const nodes = (result.children ?? []).map((c) => shapeSvg(byId.get(c.id)!, c as Rect)).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${edges}${nodes}</svg>`;
}

const CSS = `
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --card:#ffffff; --line:#a8a29e; --todo:#a8a29e; --doing:#d97706; --done:#16a34a; --accent:#4f46e5; }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --card:#292524; --line:#78716c; --todo:#78716c; --doing:#f59e0b; --done:#22c55e; --accent:#818cf8; } }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
header, section { padding:16px 24px; }
h1 { font-size:20px; margin:0 0 8px; } h2 { font-size:16px; margin:24px 0 4px; }
.checklist { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 16px; max-width:900px; }
nav a { color:var(--accent); margin-right:12px; }
.pair { display:flex; gap:24px; flex-wrap:wrap; align-items:flex-start; }
.pane { background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:auto; max-width:100%; }
.meta { color:var(--muted); font-size:12px; padding:4px 8px; }
.bad { color:#dc2626; font-weight:600; }
svg text { fill:var(--fg); font:13px system-ui, sans-serif; }
svg text.sub { fill:var(--muted); font-size:11px; }
svg text.progress { fill:var(--accent); font-size:11px; font-weight:600; }
svg text.edge-label { fill:var(--muted); font-size:11px; paint-order:stroke; stroke:var(--bg); stroke-width:4px; stroke-linejoin:round; }
.node { fill:var(--card); stroke:var(--line); stroke-width:1.5; }
.node.feature { stroke:var(--accent); stroke-width:2; }
.node.status-todo { stroke:var(--todo); } .node.status-in_progress { stroke:var(--doing); stroke-width:2.5; } .node.status-done { stroke:var(--done); stroke-width:2.5; }
.node.start, .node.end { fill:var(--bg); }
.stack { fill:var(--card); stroke:var(--line); stroke-width:1; }
.edge { fill:none; stroke:var(--line); stroke-width:1.5; }
`;

async function main() {
  const dir = resolve(process.argv[2] ?? 'fixtures/career-app');
  const index = indexProject(await loadProject(dir));
  const levels = buildLevels(index);
  const sections: string[] = [];
  const summary: string[] = [];
  for (const level of levels) {
    const panes: string[] = [];
    for (const dir of ['DOWN', 'WRAP'] as const) {
      const result = await layoutFor(level, dir);
      const through = edgesThroughNodes(result);
      const width = Math.ceil(result.width ?? 0);
      const fits = width <= MAX_WIDTH;
      summary.push(`${level.id} ${dir}: ${level.nodes.length} nodes, ${width}×${Math.ceil(result.height ?? 0)}px, edges through nodes: ${through}`);
      const marker = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#a8a29e"/></marker></defs>';
      const lightCss = CSS.replace(/@media \(prefers-color-scheme: dark\)[^\n]*\n/, '');
      const standalone = renderSvg(level, result).replace(/^<svg([^>]*)>/, `<svg$1><style>${lightCss}</style>${marker}<rect width="100%" height="100%" fill="#fafaf9"/>`);
      await mkdir(resolve('out/layout/svg'), { recursive: true });
      await writeFile(resolve(`out/layout/svg/${level.id}-${dir.toLowerCase()}.svg`), standalone);
      panes.push(
        `<div class="pane"><div class="meta">${dir === 'DOWN' ? 'Top-down' : 'Left-right, wrapped into rows'} · ${width}×${Math.ceil(result.height ?? 0)}px · <span class="${fits ? '' : 'bad'}">${fits ? `fits ${MAX_WIDTH}px` : `wider than ${MAX_WIDTH}px`}</span> · <span class="${through ? 'bad' : ''}">edges through nodes: ${through}</span></div>${renderSvg(level, result)}</div>`,
      );
    }
    sections.push(`<section id="${esc(level.id)}"><h2>${esc(level.title)} <span class="meta">(${level.nodes.length} nodes)</span></h2><div class="pair">${panes.join('')}</div></section>`);
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plan layout check</title><style>${CSS}</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#a8a29e"/></marker></defs></svg>
<header><h1>Plan layout check (ITC-2)</h1>
<div class="checklist"><strong>Judge each level at 100% zoom:</strong><ol>
<li>Labels are readable without zooming.</li>
<li>No edge runs through a node (also counted automatically per pane).</li>
<li>Each level fits the ~960px left for the chart on a 1440px laptop with the chat panel open, growing downward.</li>
<li>Decision branches are easy to follow.</li>
<li>Which reads better: top-down, or left-to-right wrapped into rows? Note it per kind of flow (process vs system).</li>
</ol>Legend: green border = done, amber = in progress, grey = to do; stacked card = has a child flow (with its progress); dashed = reference.</div>
<nav>${levels.map((l) => `<a href="#${esc(l.id)}">${esc(l.id)}</a>`).join('')}</nav></header>
${sections.join('\n')}
</body></html>`;
  const outDir = resolve('out/layout');
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/index.html`, html);
  console.log(summary.join('\n'));
  console.log(`\nWrote ${outDir}/index.html`);
}

await main();
