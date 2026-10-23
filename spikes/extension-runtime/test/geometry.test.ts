import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '../../format/src/load.js';
import { buildViewModel } from '../src/host/viewModel.js';
import type { ViewModel } from '../src/shared/viewModel.js';
import { edgesThroughNodes, labelClearance, labelCollisions, labelCrossings, fitWidthViewport, fromElk, labelPoint, roundedPath, toElkGraph, type Placed } from '../webview/src/layout/geometry.js';
import { approxMeasure, edgeLabelBox, nodeBox, wrap } from '../webview/src/layout/metrics.js';

const Elk = createRequire(import.meta.url)('elkjs/lib/elk.bundled.js') as new () => { layout(g: ElkNode): Promise<ElkNode> };
const elk = new Elk();
const FIXTURE = fileURLToPath(new URL('../../format/fixtures/career-app', import.meta.url));

let vm: ViewModel;
const placed = new Map<string, Placed>();
beforeAll(async () => {
  vm = buildViewModel(await loadProject(FIXTURE));
  for (const level of Object.values(vm.levels)) {
    const { graph, boxes, labels } = toElkGraph(level, approxMeasure);
    placed.set(level.id, fromElk(await elk.layout(graph), boxes, labels, level));
  }
});

describe('career-app layout', () => {
  it('fits every level within 960px at zoom 1', () => {
    const widths = Object.fromEntries([...placed].map(([id, p]) => [id, p.width]));
    for (const [id, w] of Object.entries(widths)) expect(w, `${id} is ${w}px wide`).toBeLessThanOrEqual(960);
  });

  it('routes no edge through a node', () => {
    for (const [id, p] of placed) expect(edgesThroughNodes(p), id).toBe(0);
  });

  it('places no label over a node or another label', () => {
    for (const [id, p] of placed) expect(labelCollisions(p), id).toBe(0);
  });

  it('keeps every label clear of the cards, so arrowheads stay visible', () => {
    for (const [id, p] of placed) expect(labelClearance(p), id).toBeGreaterThanOrEqual(12);
  });

  it('puts every label on a straight run of its own line, with no other line beneath it', () => {
    for (const [id, p] of placed) {
      expect(labelCrossings(p), id).toBe(0);
      expect(p.edges.filter((e) => e.labelCost > 0).map((e) => e.id), id).toEqual([]);
    }
  });

  it('puts the first listed feature at the top of the overview', () => {
    const o = placed.get('overview')!;
    const top = Math.min(...o.nodes.map((n) => n.y));
    expect(o.nodes.find((n) => n.id === 'career-profile')!.y).toBe(top);
  });

  it('gives every edge a polyline and keeps label boxes', () => {
    const job = placed.get('overview')!;
    expect(job.edges).toHaveLength(8);
    for (const e of job.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);
    expect(job.edges.filter((e) => e.label?.data).length).toBe(8);
  });
});

describe('geometry helpers', () => {
  it('rounds the corner of an L-shaped edge with one arc', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }]);
    expect(d.match(/A/g)).toHaveLength(1);
    expect(d.startsWith('M0,0')).toBe(true);
    expect(d.endsWith('L100,100')).toBe(true);
  });

  it('clamps the corner radius on short segments', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 50, y: 6 }], 10);
    expect(d).toContain('A3,3');
  });

  it('puts the label point on the longest segment', () => {
    expect(labelPoint([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 200, y: 20 }, { x: 200, y: 40 }])).toEqual({ x: 100, y: 20 });
  });

  it('centres the card we came back to, without leaving space above or below the chart', () => {
    const node = { x: 0, y: 1200, w: 200, h: 80 };
    const vp = fitWidthViewport(400, 960, 32, { container: { h: 800 }, graphH: 2000, focus: node });
    expect((node.y + node.h / 2) * vp.zoom + vp.y).toBeCloseTo(400);
    const nearTop = fitWidthViewport(400, 960, 32, { container: { h: 800 }, graphH: 2000, focus: { ...node, y: 40 } });
    expect(nearTop.y).toBe(32);
    const nearEnd = fitWidthViewport(400, 960, 32, { container: { h: 800 }, graphH: 2000, focus: { ...node, y: 1950 } });
    expect(nearEnd.y).toBe(800 - 2000 - 32);
  });

  it('never zooms above 1 and aligns to the top', () => {
    expect(fitWidthViewport(400, 960)).toEqual({ x: 280, y: 32, zoom: 1 });
    const narrow = fitWidthViewport(900, 600);
    expect(narrow.zoom).toBeCloseTo((600 - 64) / 900);
    expect(narrow.y).toBe(32);
  });
});

describe('metrics', () => {
  it('wraps to at most the line limit with an ellipsis', () => {
    const lines = wrap('one two three four five six seven eight nine ten eleven twelve', 'label', 60, 2, approxMeasure);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });

  it('sizes pills to their text and cards to their lines', () => {
    const start = nodeBox({ id: 's', kind: 'start', label: 'Start', source: { file: 'f', line: 1 } }, approxMeasure);
    expect(start.width).toBe(104);
    const long = nodeBox({ id: 'n', kind: 'step', label: 'Match profile experiences to requirements and more words here', source: { file: 'f', line: 1 } }, approxMeasure);
    const short = nodeBox({ id: 'n', kind: 'step', label: 'Search jobs', source: { file: 'f', line: 1 } }, approxMeasure);
    expect(long.title.length).toBeGreaterThan(1);
    expect(long.height).toBeGreaterThan(short.height);
  });

  it('stacks a label and a data chip', () => {
    const both = edgeLabelBox({ id: 'e', from: 'a', to: 'b', label: 'yes', data: 'job record' }, approxMeasure)!;
    const one = edgeLabelBox({ id: 'e', from: 'a', to: 'b', label: 'yes' }, approxMeasure)!;
    expect(both.height).toBeGreaterThan(one.height);
    expect(edgeLabelBox({ id: 'e', from: 'a', to: 'b' }, approxMeasure)).toBeNull();
  });
});
