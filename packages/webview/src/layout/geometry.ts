// Layout geometry, free of the DOM: the ELK graph for a level, positioned
// nodes and edge polylines back out, rounded edge paths, where labels sit,
// and the viewport rules (fit the width, never zoom in, start at the top; the
// zoom buttons' steps and the reading view they come back to).
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import { OVERVIEW, type Level } from '@idea-to-code/core';
import { edgeLabelBox, nodeBox, type EdgeLabelBox, type Measure, type NodeBox } from './metrics.js';

export interface Point {
  x: number;
  y: number;
}

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  box: NodeBox;
}

export interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  points: Point[];
  label: EdgeLabelBox | null;
  /** Centre of the label, on the edge's own line. */
  labelAt: Point | null;
  /** 0 when the label sits on a straight run of its own line with nothing beneath it. */
  labelCost: number;
}

export interface Placed {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

export const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.layered.spacing.edgeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '28',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '16',
  // Lines leaving a card run sideways in the gap below it. Kept this far apart, a
  // label sitting on one of them doesn't cover the next (ITC-37).
  'elk.layered.spacing.edgeEdgeBetweenLayers': '32',
  'elk.spacing.edgeLabel': '12',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // Sources go on top; in a loop (growth feeds back into the profile) the
  // edge reversed is the one that goes against the YAML order.
  'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
  // At most two cards side by side: wide fan-outs stack downward instead of
  // spreading past the ~960px a laptop leaves next to the chat panel.
  'elk.layered.layering.strategy': 'COFFMAN_GRAHAM',
  'elk.layered.layering.coffmanGraham.layerBound': '2',
  'elk.edgeLabels.placement': 'CENTER',
  // Parts of the chart with no line between them (often shared components) are laid
  // out apart, then packed. Aiming for a tall shape wraps them into rows no wider
  // than the main chart, instead of lining them up beside it.
  'elk.aspectRatio': '0.6',
  // Those parts follow the plan's order, so the first feature stays at the top.
  'elk.layered.considerModelOrder.components': 'MODEL_ORDER',
  'elk.padding': '[top=8,left=8,bottom=8,right=8]',
};

/**
 * On the overview, cards with no lines are set apart from the chart: shared components
 * in a grid above it, features in a grid below it, each grid in cards of one size.
 * Inside a feature, every card stays in its flow.
 */
function looseOnOverview(level: Level): { infra: string[]; features: string[] } {
  if (level.id !== OVERVIEW) return { infra: [], features: [] };
  const linked = new Set(level.edges.flatMap((e) => [e.from, e.to]));
  const loose = level.nodes.filter((n) => !linked.has(n.id));
  return {
    infra: loose.filter((n) => n.kind === 'component').map((n) => n.id),
    features: loose.filter((n) => n.kind === 'feature').map((n) => n.id),
  };
}

export function toElkGraph(
  level: Level,
  measure: Measure,
): { graph: ElkNode; boxes: Map<string, NodeBox>; labels: Map<string, EdgeLabelBox | null> } {
  const boxes = new Map<string, NodeBox>();
  for (const n of level.nodes) boxes.set(n.id, nodeBox(n, measure));
  const { infra, features } = looseOnOverview(level);
  const apart = new Set([...infra, ...features]);
  const children = level.nodes
    .filter((n) => !apart.has(n.id))
    .map((n) => {
      const box = boxes.get(n.id) ?? nodeBox(n, measure);
      return { id: n.id, width: box.width, height: box.height };
    });
  const labels = new Map(level.edges.map((e) => [e.id, edgeLabelBox(e, measure)]));
  const graph: ElkNode = {
    id: `root:${level.id}`,
    layoutOptions: LAYOUT_OPTIONS,
    children,
    edges: level.edges
      .filter((e) => boxes.has(e.from) && boxes.has(e.to))
      .map<ElkExtendedEdge>((e) => {
        const l = labels.get(e.id);
        return {
          id: e.id,
          sources: [e.from],
          targets: [e.to],
          labels: l ? [{ id: `${e.id}:label`, width: l.width, height: l.height }] : [],
        };
      }),
  };
  return { graph, boxes, labels };
}

export function fromElk(result: ElkNode, boxes: Map<string, NodeBox>, labels: Map<string, EdgeLabelBox | null>, level: Level): Placed {
  const nodes = (result.children ?? []).flatMap((c) => {
    const box = boxes.get(c.id);
    return box ? [{ id: c.id, x: c.x ?? 0, y: c.y ?? 0, box }] : [];
  });
  const byId = new Map(level.edges.map((e) => [e.id, e]));
  const edges: PlacedEdge[] = (result.edges ?? []).flatMap((e) => {
    const v = byId.get(e.id);
    if (!v) return [];
    const points: Point[] = [];
    for (const s of e.sections ?? []) {
      for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
        const last = points.at(-1);
        if (last?.x !== p.x || last.y !== p.y) points.push({ x: p.x, y: p.y });
      }
    }
    return [{ id: e.id, from: v.from, to: v.to, points, label: labels.get(e.id) ?? null, labelAt: null, labelCost: 0 }];
  });
  const placed = withGrids({ width: Math.ceil(result.width ?? 0), height: Math.ceil(result.height ?? 0), nodes, edges }, boxes, level);
  placeLabels(placed);
  return placed;
}

/** Space between grid cards, and between the grids and the chart. */
export const GRID_GAP = { card: 28, section: 56 };
const PAD = 8;
/** A grid of loose cards wraps at the chart's width, or this, whichever is wider. */
const GRID_MAX = 960;

/** Cards in rows of one size, `width` wide at most. */
function grid(ids: string[], boxes: Map<string, NodeBox>, width: number): { nodes: PlacedNode[]; width: number; height: number } {
  const cards = ids.flatMap((id) => {
    const box = boxes.get(id);
    return box ? [{ id, box }] : [];
  });
  if (cards.length === 0) return { nodes: [], width: 0, height: 0 };
  const w = Math.max(...cards.map((c) => c.box.width));
  const h = Math.max(...cards.map((c) => c.box.height));
  const columns = Math.max(1, Math.min(cards.length, Math.floor((width + GRID_GAP.card) / (w + GRID_GAP.card))));
  const rows = Math.ceil(cards.length / columns);
  return {
    nodes: cards.map(({ id, box }, i) => ({
      id,
      x: (i % columns) * (w + GRID_GAP.card),
      y: Math.floor(i / columns) * (h + GRID_GAP.card),
      box: { ...box, width: w, height: h },
    })),
    width: columns * w + (columns - 1) * GRID_GAP.card,
    height: rows * h + (rows - 1) * GRID_GAP.card,
  };
}

/** The overview's loose cards: infrastructure above the chart, features below it, each block centred. */
function withGrids(chart: Placed, boxes: Map<string, NodeBox>, level: Level): Placed {
  const { infra, features } = looseOnOverview(level);
  if (infra.length === 0 && features.length === 0) return chart;
  const hasChart = chart.nodes.length > 0;
  const inner = hasChart ? chart.width - PAD * 2 : 0;
  const wrapAt = Math.max(inner, GRID_MAX - PAD * 2);
  const top = grid(infra, boxes, wrapAt);
  const bottom = grid(features, boxes, wrapAt);
  const width = Math.max(inner, top.width, bottom.width);
  const blocks: { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number; x0: number; y0: number }[] = [];
  if (top.nodes.length) blocks.push({ ...top, edges: [], x0: 0, y0: 0 });
  if (hasChart) blocks.push({ nodes: chart.nodes, edges: chart.edges, width: inner, height: chart.height - PAD * 2, x0: PAD, y0: PAD });
  if (bottom.nodes.length) blocks.push({ ...bottom, edges: [], x0: 0, y0: 0 });
  const nodes: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];
  let y = PAD;
  for (const b of blocks) {
    // Moves a block from where it was laid out to its place in the column, centred.
    const dx = PAD + (width - b.width) / 2 - b.x0;
    const dy = y - b.y0;
    for (const n of b.nodes) nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
    for (const e of b.edges) edges.push({ ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
    y += b.height + GRID_GAP.section;
  }
  return { width: Math.ceil(width + PAD * 2), height: Math.ceil(y - GRID_GAP.section + PAD), nodes, edges };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect, margin = 4) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 });

const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Clear space kept around cards (so arrowheads stay visible) and between labels. */
export const LABEL_GAP = { node: 14, label: 8 };
/** A label must not cover a corner of its own edge: keep this much straight line beyond it. */
const CORNER_CLEAR = 12;

interface Segment {
  a: Point;
  b: Point;
  len: number;
}

function segmentsOf(points: Point[]): Segment[] {
  const segments: Segment[] = [];
  let a: Point | undefined;
  for (const b of points) {
    if (a) segments.push({ a, b, len: Math.hypot(b.x - a.x, b.y - a.y) });
    a = b;
  }
  return segments;
}

/** Whether a segment passes through a rectangle. */
function crosses(seg: Segment, r: Rect): boolean {
  const minX = Math.min(seg.a.x, seg.b.x),
    maxX = Math.max(seg.a.x, seg.b.x);
  const minY = Math.min(seg.a.y, seg.b.y),
    maxY = Math.max(seg.a.y, seg.b.y);
  return maxX >= r.x && minX <= r.x + r.w && maxY >= r.y && minY <= r.y + r.h;
}

// Costs, from worst to mildest: covering a card or another label, sticking out
// of the chart, another edge's line running under the label, covering a corner
// of its own edge. A label that sits on a straight run of its own line, with
// nothing else beneath it, costs 0.
const COST = { crossing: 400, corner: 150 };

/**
 * Puts each label on its own edge. Candidates are spots along each segment,
 * longest segment first and nearest its middle first (the ITC-2 rule). The
 * first spot with nothing in the way wins; otherwise the cheapest one.
 */
export function placeLabels(placed: Placed): void {
  const nodes: Rect[] = placed.nodes.map((n) => ({ x: n.x, y: n.y, w: n.box.width, h: n.box.height }));
  const labels: Rect[] = [];
  for (const e of placed.edges) {
    if (!e.label) continue;
    const { width: w, height: h } = e.label;
    const own = segmentsOf(e.points);
    const others = placed.edges.filter((o) => o.id !== e.id).flatMap((o) => segmentsOf(o.points));
    const segments = [...own].sort((s, t) => t.len - s.len);
    let best: { p: Point; cost: number } | null = null;
    search: for (const s of segments) {
      const vertical = Math.abs(s.b.x - s.a.x) < Math.abs(s.b.y - s.a.y);
      // How far along the segment the label reaches, each way from its centre.
      const half = (vertical ? h : w) / 2 + CORNER_CLEAR;
      const offsets = [0];
      for (let d = 8; d <= s.len / 2; d += 8) offsets.push(-d, d);
      for (const off of offsets) {
        const along = s.len / 2 + off;
        const t = s.len ? along / s.len : 0.5;
        const p = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
        const rect = { x: p.x - w / 2, y: p.y - h / 2, w, h };
        const outside = Math.max(0, -rect.x) + Math.max(0, rect.x + w - placed.width);
        const near = (rs: Rect[], gap: number) =>
          rs.reduce((sum, r) => sum + (overlaps(rect, r, gap) ? overlapArea(grow(rect, gap), r) + 1 : 0), 0);
        const coversCorner = along < half || s.len - along < half;
        const crossings = others.filter((o) => crosses(o, rect)).length;
        const cost =
          (near(nodes, LABEL_GAP.node) + near(labels, LABEL_GAP.label)) * 10 +
          outside * h * 10 +
          crossings * COST.crossing +
          (coversCorner ? COST.corner : 0);
        if (!best || cost < best.cost) best = { p, cost };
        if (cost === 0) break search;
      }
    }
    e.labelAt = best?.p ?? labelPoint(e.points);
    e.labelCost = best?.cost ?? 0;
    labels.push({ x: e.labelAt.x - w / 2, y: e.labelAt.y - h / 2, w, h });
  }
}

/** Labels with another edge's line running beneath them (should be 0 where avoidable). */
export function labelCrossings(placed: Placed): number {
  let hits = 0;
  for (const e of placed.edges) {
    if (!e.label || !e.labelAt) continue;
    const r = { x: e.labelAt.x - e.label.width / 2, y: e.labelAt.y - e.label.height / 2, w: e.label.width, h: e.label.height };
    for (const o of placed.edges) if (o.id !== e.id && segmentsOf(o.points).some((s) => crosses(s, r))) hits++;
  }
  return hits;
}

/** The smallest gap between any label and any card, in px (for tests and tuning). */
export function labelClearance(placed: Placed): number {
  let min = Infinity;
  for (const e of placed.edges) {
    if (!e.label || !e.labelAt) continue;
    const r = { x: e.labelAt.x - e.label.width / 2, y: e.labelAt.y - e.label.height / 2, w: e.label.width, h: e.label.height };
    for (const n of placed.nodes) {
      const dx = Math.max(n.x - (r.x + r.w), r.x - (n.x + n.box.width), 0);
      const dy = Math.max(n.y - (r.y + r.h), r.y - (n.y + n.box.height), 0);
      min = Math.min(min, Math.hypot(dx, dy));
    }
  }
  return min;
}

/** Pairs of labels that overlap each other or a node (should be 0). */
export function labelCollisions(placed: Placed): number {
  const rects = placed.edges.flatMap((e) =>
    e.label && e.labelAt
      ? [{ x: e.labelAt.x - e.label.width / 2, y: e.labelAt.y - e.label.height / 2, w: e.label.width, h: e.label.height }]
      : [],
  );
  const nodes = placed.nodes.map((n) => ({ x: n.x, y: n.y, w: n.box.width, h: n.box.height }));
  let hits = 0;
  rects.forEach((r, i) => {
    for (const other of rects.slice(i + 1)) if (overlaps(r, other, 0)) hits++;
    for (const n of nodes) if (overlaps(r, n, 0)) hits++;
  });
  return hits;
}

/** An orthogonal polyline as an SVG path with rounded corners. */
export function roundedPath(points: Point[], radius = 10): string {
  const [first] = points;
  if (!first) return '';
  let d = `M${String(first.x)},${String(first.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const p = points[i];
    const next = points[i + 1];
    if (!prev || !p || !next) continue;
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L${p.x},${p.y}`;
      continue;
    }
    const a = { x: p.x - ((p.x - prev.x) / inLen) * r, y: p.y - ((p.y - prev.y) / inLen) * r };
    const b = { x: p.x + ((next.x - p.x) / outLen) * r, y: p.y + ((next.y - p.y) / outLen) * r };
    const sweep = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x) > 0 ? 1 : 0;
    d += ` L${a.x},${a.y} A${r},${r} 0 0 ${sweep} ${b.x},${b.y}`;
  }
  const last = points.at(-1);
  if (last && points.length > 1) d += ` L${String(last.x)},${String(last.y)}`;
  return d;
}

/** The middle of the longest segment: labels always sit on their own line (ITC-2). */
export function labelPoint(points: Point[]): Point {
  let best = points[0] ?? { x: 0, y: 0 };
  let longest = -1;
  for (const { a, b, len } of segmentsOf(points)) {
    if (len > longest) {
      longest = len;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
}

/** Segments that cross a node other than the edge's own ends (should be 0). */
export function edgesThroughNodes(placed: Placed): number {
  let hits = 0;
  for (const e of placed.edges) {
    for (const { a, b } of segmentsOf(e.points)) {
      const minX = Math.min(a.x, b.x),
        maxX = Math.max(a.x, b.x),
        minY = Math.min(a.y, b.y),
        maxY = Math.max(a.y, b.y);
      for (const n of placed.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        if (maxX > n.x + 2 && minX < n.x + n.box.width - 2 && maxY > n.y + 2 && minY < n.y + n.box.height - 2) hits++;
      }
    }
  }
  return hits;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Fit the graph's width, never zoom above 1, centre it horizontally, and
 * start at the top. With a focus (a card, or the span of several), centre it
 * vertically instead, or start at its top when it's taller than the view,
 * without scrolling past either end of the chart.
 */
export function fitWidthViewport(
  graphW: number,
  containerW: number,
  padding = 32,
  center?: { container: { h: number }; graphH: number; focus: { y: number; h: number } },
): Viewport {
  const zoom = Math.min(1, Math.max(ZOOM_MIN, (containerW - padding * 2) / Math.max(graphW, 1)));
  const vp = { x: (containerW - graphW * zoom) / 2, y: padding, zoom };
  if (center) {
    const { container, graphH, focus } = center;
    const fits = focus.h * zoom <= container.h - padding * 2;
    const centred = fits ? container.h / 2 - (focus.y + focus.h / 2) * zoom : padding - focus.y * zoom;
    const lowest = Math.min(padding, container.h - graphH * zoom - padding);
    vp.y = Math.max(lowest, Math.min(padding, centred));
  }
  return vp;
}

/** How far the chart zooms out and in. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** One press of zoom in or out. */
export const ZOOM_STEP = 1.25;

/** Close enough to a limit to count as there: zoom steps don't land on it exactly. */
export function atZoomLimit(zoom: number, limit: number): boolean {
  return Math.abs(zoom - limit) < 0.001;
}

/** Zooms by `factor`, within the limits, keeping the point `at` (in view coordinates) where it is. */
export function zoomBy(vp: Viewport, factor: number, at: Point): Viewport {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, vp.zoom * factor));
  const s = zoom / vp.zoom;
  return { x: at.x - (at.x - vp.x) * s, y: at.y - (at.y - vp.y) * s, zoom };
}

/**
 * The normal reading view, from wherever the user is: the width fitted as a level
 * opens, keeping what was in the middle of the view in the middle.
 */
export function readingViewport(graph: { w: number; h: number }, view: { w: number; h: number }, vp: Viewport, padding = 32): Viewport {
  const middle = (view.h / 2 - vp.y) / vp.zoom;
  return fitWidthViewport(graph.w, view.w, padding, { container: { h: view.h }, graphH: graph.h, focus: { y: middle, h: 0 } });
}
