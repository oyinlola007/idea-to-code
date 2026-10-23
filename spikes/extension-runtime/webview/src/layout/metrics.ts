// Node and label sizes, computed before layout so ELK gets the real boxes.
// The node components render the same wrapped lines, so what is measured is
// what is drawn. Pure: the text measurer is passed in (canvas in the webview,
// a stub in tests).
import type { VEdge, VNode } from '../../../src/shared/viewModel.js';

export type Measure = (text: string, font: 'title' | 'label' | 'body' | 'meta' | 'mono') => number;

export const M = {
  width: { feature: 240, step: 232, component: 232, reference: 232, decision: 232 },
  padX: 14,
  padY: 12,
  lineH: { title: 20, label: 18, body: 17, meta: 16 },
  gap: 6,
  pill: { height: 34, padX: 16, icon: 14, iconGap: 8, min: 104 },
  maxLines: { title: 2, label: 3, body: 2 },
  edgeLabel: { height: 20, padX: 8, gap: 4, maxWidth: 150 },
} as const;

export interface NodeBox {
  width: number;
  height: number;
  title: string[];
  body: string[];
  hasMeta: boolean;
}

export function wrap(text: string, font: Parameters<Measure>[1], maxWidth: number, maxLines: number, measure: Measure): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next, font) > maxWidth) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines) {
    if (line) lines.push(line);
  } else {
    // Out of room: fold the rest into the last line with an ellipsis.
    let last = lines[maxLines - 1]!;
    while (last && measure(`${last}…`, font) > maxWidth) last = last.slice(0, -1).trimEnd();
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.length ? lines : [''];
}

function hasMeta(n: VNode): boolean {
  return Boolean(n.opens || n.planned || n.status || n.tech || n.kind === 'component' || n.kind === 'reference');
}

export function nodeBox(n: VNode, measure: Measure): NodeBox {
  if (n.kind === 'start' || n.kind === 'end') {
    const w = measure(n.label, 'label') + M.pill.padX * 2 + M.pill.icon + M.pill.iconGap;
    return { width: Math.max(M.pill.min, Math.ceil(w)), height: M.pill.height, title: [n.label], body: [], hasMeta: false };
  }
  const width = M.width[n.kind];
  const inner = width - M.padX * 2;
  const isFeature = n.kind === 'feature';
  // Decision and component cards have a leading glyph on the title line.
  const glyph = n.kind === 'decision' ? 22 : 0;
  const title = wrap(n.label, isFeature ? 'title' : 'label', inner - glyph, isFeature ? M.maxLines.title : M.maxLines.label, measure);
  const body = isFeature && n.description ? wrap(n.description, 'body', inner, M.maxLines.body, measure) : [];
  const meta = hasMeta(n);
  const kindRow = n.kind === 'component' ? M.lineH.meta + 4 : 0;
  const height =
    M.padY * 2 +
    kindRow +
    title.length * (isFeature ? M.lineH.title : M.lineH.label) +
    (body.length ? M.gap + body.length * M.lineH.body : 0) +
    (meta ? M.gap + 4 + M.lineH.meta : 0);
  return { width, height, title, body, hasMeta: meta };
}

export interface EdgeLabelBox {
  width: number;
  height: number;
  label?: string;
  data?: string;
}

function clampText(text: string, font: 'meta' | 'mono', max: number, measure: Measure): string {
  if (measure(text, font) <= max) return text;
  let t = text;
  while (t && measure(`${t}…`, font) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

export function edgeLabelBox(e: VEdge, measure: Measure): EdgeLabelBox | null {
  if (!e.label && !e.data) return null;
  const inner = M.edgeLabel.maxWidth - M.edgeLabel.padX * 2;
  const label = e.label ? clampText(e.label, 'meta', inner, measure) : undefined;
  const data = e.data ? clampText(e.data, 'mono', inner - 14, measure) : undefined;
  const widths = [label ? measure(label, 'meta') : 0, data ? measure(data, 'mono') + 14 : 0];
  const rows = (label ? 1 : 0) + (data ? 1 : 0);
  return {
    width: Math.ceil(Math.max(...widths) + M.edgeLabel.padX * 2),
    height: rows * M.edgeLabel.height + (rows - 1) * M.edgeLabel.gap,
    ...(label ? { label } : {}),
    ...(data ? { data } : {}),
  };
}

/** A deterministic measurer for tests and as a fallback: average glyph widths per font. */
export const approxMeasure: Measure = (text, font) => text.length * ({ title: 7.8, label: 7.2, body: 6.6, meta: 6.2, mono: 6.8 } as const)[font];
