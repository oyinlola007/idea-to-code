import { buildViewModel, loadFromTexts, type ViewModel } from '@idea-to-code/core';
import ELK from 'elkjs/lib/elk.bundled.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  edgesThroughNodes,
  atZoomLimit,
  fitWidthViewport,
  fromElk,
  readingViewport,
  labelClearance,
  labelCollisions,
  labelCrossings,
  labelPoint,
  roundedPath,
  toElkGraph,
  type Placed,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  zoomBy,
} from '../src/layout/geometry.js';
import { approxMeasure, edgeLabelBox, nodeBox, wrap } from '../src/layout/metrics.js';

const files = import.meta.glob<string>('../../core/test/fixtures/toolshed/plan/**/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const texts = Object.fromEntries(Object.entries(files).map(([path, text]) => [path.replace(/^.*toolshed\//, ''), text]));

const elk = new ELK();
let model: ViewModel;
const placed = new Map<string, Placed>();

beforeAll(async () => {
  model = buildViewModel(loadFromTexts(texts));
  for (const level of Object.values(model.levels)) {
    const { graph, boxes, labels } = toElkGraph(level, approxMeasure);
    placed.set(level.id, fromElk(await elk.layout(graph), boxes, labels, level));
  }
});

const source = { file: 'f', line: 1 };

describe('Toolshed layout', () => {
  it('has every level', () => {
    expect(placed.size).toBe(Object.keys(model.levels).length);
    expect(placed.size).toBeGreaterThan(3);
  });

  it('fits every level within 960px at zoom 1', () => {
    for (const [id, p] of placed) expect(p.width, `${id} is ${String(p.width)}px wide`).toBeLessThanOrEqual(960);
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
      expect(
        p.edges.filter((e) => e.labelCost > 0).map((e) => e.id),
        id,
      ).toEqual([]);
    }
  });

  it('puts the first listed feature at the top of the overview', () => {
    const overview = placed.get('overview');
    const top = Math.min(...(overview?.nodes.map((n) => n.y) ?? []));
    const first = model.levels.overview?.nodes[0]?.id;
    expect(overview?.nodes.find((n) => n.id === first)?.y).toBe(top);
  });

  it('gives every edge a polyline and keeps its label', () => {
    for (const p of placed.values()) for (const e of p.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);
    const overview = placed.get('overview');
    expect(overview?.edges.length).toBeGreaterThan(0);
    expect(overview?.edges.every((e) => e.label?.data !== undefined)).toBe(true);
  });
});

describe('geometry helpers', () => {
  const L = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
  ];

  it('rounds the corner of an L-shaped edge with one arc', () => {
    const d = roundedPath(L);
    expect(d.match(/A/g)).toHaveLength(1);
    expect(d.startsWith('M0,0')).toBe(true);
    expect(d.endsWith('L100,100')).toBe(true);
    expect(roundedPath([])).toBe('');
  });

  it('clamps the corner radius on short segments', () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 6 },
          { x: 50, y: 6 },
        ],
        10,
      ),
    ).toContain('A3,3');
  });

  it('puts the label point on the longest segment', () => {
    expect(
      labelPoint([
        { x: 0, y: 0 },
        { x: 0, y: 20 },
        { x: 200, y: 20 },
        { x: 200, y: 40 },
      ]),
    ).toEqual({ x: 100, y: 20 });
  });

  it('never zooms above 1 and aligns to the top', () => {
    expect(fitWidthViewport(400, 960)).toEqual({ x: 280, y: 32, zoom: 1 });
    const narrow = fitWidthViewport(900, 600);
    expect(narrow.zoom).toBeCloseTo((600 - 64) / 900);
    expect(narrow.y).toBe(32);
  });

  it('centres a focus that fits, and starts at the top of one that does not', () => {
    const chart = { container: { h: 600 }, graphH: 3000 };
    expect(fitWidthViewport(400, 960, 32, { ...chart, focus: { y: 1000, h: 200 } }).y).toBe(300 - 1100);
    expect(fitWidthViewport(400, 960, 32, { ...chart, focus: { y: 1000, h: 900 } }).y).toBe(32 - 1000);
  });
});

describe('metrics', () => {
  it('wraps to at most the line limit with an ellipsis', () => {
    const lines = wrap('one two three four five six seven eight nine ten eleven twelve', 'label', 60, 2, approxMeasure);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
  });

  it('sizes pills to their text and cards to their lines', () => {
    expect(nodeBox({ id: 's', kind: 'start', label: 'Start', source }, approxMeasure).width).toBe(104);
    const long = nodeBox(
      { id: 'n', kind: 'step', label: 'Check the tool is free and the member is in good standing for those dates', source },
      approxMeasure,
    );
    const short = nodeBox({ id: 'n', kind: 'step', label: 'Pick dates', source }, approxMeasure);
    expect(long.title.length).toBeGreaterThan(1);
    expect(long.height).toBeGreaterThan(short.height);
  });

  it('stacks a label and a data chip', () => {
    const both = edgeLabelBox({ id: 'e', from: 'a', to: 'b', label: 'yes', data: 'booking' }, approxMeasure);
    const one = edgeLabelBox({ id: 'e', from: 'a', to: 'b', label: 'yes' }, approxMeasure);
    expect(both?.height).toBeGreaterThan(one?.height ?? 0);
    expect(edgeLabelBox({ id: 'e', from: 'a', to: 'b' }, approxMeasure)).toBeNull();
  });
});

describe('zoom buttons', () => {
  const vp = { x: 100, y: 50, zoom: 1 };

  it('steps by a quarter, keeping the point it zooms around in place', () => {
    const at = { x: 400, y: 300 };
    const zoomed = zoomBy(vp, ZOOM_STEP, at);
    expect(zoomed.zoom).toBeCloseTo(1.25);
    // The graph point under `at` is still under it.
    expect((at.x - zoomed.x) / zoomed.zoom).toBeCloseTo((at.x - vp.x) / vp.zoom);
    expect((at.y - zoomed.y) / zoomed.zoom).toBeCloseTo((at.y - vp.y) / vp.zoom);
    expect(zoomBy(zoomed, 1 / ZOOM_STEP, at)).toMatchObject({ x: expect.closeTo(100) as number, y: expect.closeTo(50) as number, zoom: 1 });
  });

  it('stops at the limits, and knows when it is there', () => {
    let z = vp;
    for (let i = 0; i < 20; i++) z = zoomBy(z, ZOOM_STEP, { x: 0, y: 0 });
    expect(z.zoom).toBe(ZOOM_MAX);
    for (let i = 0; i < 40; i++) z = zoomBy(z, 1 / ZOOM_STEP, { x: 0, y: 0 });
    expect(z.zoom).toBe(ZOOM_MIN);
    expect(atZoomLimit(ZOOM_MIN, ZOOM_MIN)).toBe(true);
    expect(atZoomLimit(0.2501, ZOOM_MIN)).toBe(true);
    expect(atZoomLimit(0.3125, ZOOM_MIN)).toBe(false);
  });

  it('fits back to the reading view of a short flow: the width fitted, from the top', () => {
    const view = { w: 960, h: 800 };
    expect(readingViewport({ w: 400, h: 500 }, view, { x: -300, y: -900, zoom: 2 })).toEqual(fitWidthViewport(400, 960));
  });

  it('keeps your place in a tall flow, without going past either end', () => {
    const view = { w: 960, h: 800 };
    const graph = { w: 400, h: 4000 };
    // Zoomed in at 2x with graph y=2000 in the middle of the view.
    const fitted = readingViewport(graph, view, { x: 0, y: 400 - 2000 * 2, zoom: 2 });
    expect(fitted.zoom).toBe(1);
    expect((400 - fitted.y) / fitted.zoom).toBeCloseTo(2000);
    // Near the end, it stops at the last card instead of showing empty space.
    const end = readingViewport(graph, view, { x: 0, y: 400 - 3990 * 2, zoom: 2 });
    expect(end.y).toBe(800 - 4000 - 32);
  });
});
