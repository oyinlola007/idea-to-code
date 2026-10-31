// Layout geometry, free of the DOM: the ELK graph for a level, positioned
// nodes and edge polylines back out, rounded edge paths, where labels sit,
// and the viewport rule (fit the width, never zoom in, start at the top).
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import type { Level } from '@idea-to-code/core';
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
  'elk.padding': '[top=8,left=8,bottom=8,right=8]',
};

export function toElkGraph(
  level: Level,
  measure: Measure,
): { graph: ElkNode; boxes: Map<string, NodeBox>; labels: Map<string, EdgeLabelBox | null> } {
  const boxes = new Map<string, NodeBox>();
  const children = level.nodes.map((n) => {
    const box = nodeBox(n, measure);
    boxes.set(n.id, box);
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
  const placed = { width: Math.ceil(result.width ?? 0), height: Math.ceil(result.height ?? 0), nodes, edges };
  placeLabels(placed);
  return placed;
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
 * start at the top. With a focus card (coming back up one level), centre that
 * card vertically instead, without scrolling past either end of the chart.
 */
export function fitWidthViewport(
  graphW: number,
  containerW: number,
  padding = 32,
  center?: { container: { h: number }; graphH: number; focus: { y: number; h: number } },
): Viewport {
  const zoom = Math.min(1, Math.max(0.25, (containerW - padding * 2) / Math.max(graphW, 1)));
  const vp = { x: (containerW - graphW * zoom) / 2, y: padding, zoom };
  if (center) {
    const { container, graphH, focus } = center;
    const centred = container.h / 2 - (focus.y + focus.h / 2) * zoom;
    const lowest = Math.min(padding, container.h - graphH * zoom - padding);
    vp.y = Math.max(lowest, Math.min(padding, centred));
  }
  return vp;
}
