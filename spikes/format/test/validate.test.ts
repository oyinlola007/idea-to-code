import { describe, expect, it } from 'vitest';
import { loadFromTexts } from '../src/load.js';
import { errorsOf, flowProgress, indexProject, validateProject } from '../src/validate.js';

const MAP = `project: Test
features:
  - id: shop
    label: Shop
  - id: later
    label: Later feature
`;

function feature(body: string): string {
  return `feature: shop\nflows:\n${body}`;
}

const VALID_SHOP = feature(`  main:
    label: Shop
    nodes:
      - { id: browse, type: step, label: Browse, status: done }
      - { id: in-stock, type: decision, label: In stock? }
      - { id: checkout, type: step, label: Checkout, expands: checkout-flow }
    edges:
      - { from: browse, to: in-stock }
      - { from: in-stock, to: checkout, label: "yes" }
  checkout-flow:
    label: Checkout
    nodes:
      - { id: pay, type: step, label: Pay, status: done }
      - { id: confirm, type: step, label: Confirm }
    edges:
      - { from: pay, to: confirm }
`);

function issuesFor(files: Record<string, string>) {
  return validateProject(loadFromTexts(files));
}

function only(code: string, files: Record<string, string>) {
  const found = issuesFor(files).filter((i) => i.code === code);
  expect(found, `expected a "${code}" issue`).toHaveLength(1);
  return found[0]!;
}

describe('validator', () => {
  it('accepts a valid plan, warning only about the feature without flows', () => {
    const issues = issuesFor({ 'plan/map.yaml': MAP, 'plan/features/shop.yaml': VALID_SHOP });
    expect(errorsOf(issues)).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(['feature-without-flows']);
    expect(issues[0]!.line).toBe(5);
  });

  const cases: Array<{ name: string; code: string; line: number; shop?: string; map?: string; extra?: Record<string, string> }> = [
    {
      name: 'YAML syntax error',
      code: 'yaml-syntax',
      line: 6,
      shop: feature(`  main:\n    label: Shop\n    nodes: [ { id: a, type: step, label: A }\n`),
    },
    {
      name: 'unknown node type',
      code: 'schema',
      line: 6,
      shop: feature(`  main:\n    label: Shop\n    nodes:\n      - { id: a, type: task, label: A }\n`),
    },
    {
      name: 'typo in a key',
      code: 'unknown-key',
      line: 6,
      shop: feature(`  main:\n    label: Shop\n    nodes:\n      - { id: a, type: step, label: A, stauts: done }\n`),
    },
    {
      name: 'status on a decision',
      code: 'status-not-allowed',
      line: 6,
      shop: feature(`  main:\n    label: Shop\n    nodes:\n      - { id: a, type: decision, label: A?, status: done }\n`),
    },
    {
      name: 'duplicate id across flows',
      code: 'duplicate-id',
      line: 12,
      shop: feature(`  main:
    label: Shop
    nodes:
      - { id: a, type: step, label: A, expands: sub }
    edges: []
  sub:
    label: Sub
    nodes:
      - { id: b, type: step, label: B }
    edges: []
      - { id: a, type: step, label: A again }
`).replace('    edges: []\n      - { id: a', '      - { id: a'),
    },
    {
      name: 'expands a flow that does not exist',
      code: 'unknown-expands',
      line: 6,
      shop: feature(`  main:\n    label: Shop\n    nodes:\n      - { id: a, type: step, label: A, expands: nowhere }\n`),
    },
    {
      name: 'flow expanded twice',
      code: 'flow-multi-parent',
      line: 9,
      shop: feature(`  main:
    label: Shop
    nodes:
      - { id: a, type: step, label: A, expands: sub }
      - { id: b, type: step, label: B, expands: sub }
    edges: [ { from: a, to: b } ]
  sub:
    label: Sub
    nodes: [ { id: c, type: step, label: C } ]
`),
    },
    {
      name: 'cycle between child flows',
      code: 'cycle',
      line: 6,
      shop: feature(`  main:
    label: Shop
    nodes: [ { id: a, type: step, label: A } ]
  one:
    label: One
    nodes: [ { id: b, type: step, label: B, expands: two } ]
  two:
    label: Two
    nodes: [ { id: c, type: step, label: C, expands: one } ]
`),
    },
    {
      name: 'edge to a node in another flow',
      code: 'edge-unknown-node',
      line: 7,
      shop: feature(`  main:
    label: Shop
    nodes: [ { id: a, type: step, label: A } ]
    edges:
      - { from: a, to: ghost }
`),
    },
    {
      name: 'duplicate edge',
      code: 'duplicate-edge',
      line: 8,
      shop: feature(`  main:
    label: Shop
    nodes: [ { id: a, type: step, label: A }, { id: b, type: step, label: B } ]
    edges:
      - { from: a, to: b }
      - { from: a, to: b }
`),
    },
    {
      name: 'reference to an unknown flow',
      code: 'unknown-ref',
      line: 6,
      shop: feature(`  main:\n    label: Shop\n    nodes:\n      - { id: r, type: reference, label: R, ref: nope }\n`),
    },
    {
      name: 'feature file not listed in the map',
      code: 'file-not-in-map',
      line: 1,
      extra: { 'plan/features/ghost.yaml': 'feature: ghost\nflows:\n  main:\n    label: Ghost\n' },
    },
    {
      name: 'feature file name does not match',
      code: 'feature-file-mismatch',
      line: 1,
      extra: { 'plan/features/later-feature.yaml': 'feature: later\nflows:\n  main:\n    label: Later\n' },
    },
    {
      name: 'missing main flow',
      code: 'missing-main',
      line: 2,
      shop: feature(`  other:\n    label: Other\n`),
    },
    {
      name: 'connection to an unknown feature',
      code: 'connection-unknown-endpoint',
      line: 8,
      map: `${MAP}connections:\n  - { from: shop, to: nowhere, data: order }\n`,
    },
  ];

  for (const c of cases) {
    it(`reports ${c.code}: ${c.name}`, () => {
      const files = { 'plan/map.yaml': c.map ?? MAP, 'plan/features/shop.yaml': c.shop ?? VALID_SHOP, ...c.extra };
      const issue = only(c.code, files);
      expect(issue.severity).toBe('error');
      expect(issue.line).toBe(c.line);
    });
  }

  it('warns about decision edges without labels and orphan flows', () => {
    const shop = feature(`  main:
    label: Shop
    nodes: [ { id: d, type: decision, label: D? }, { id: a, type: step, label: A } ]
    edges: [ { from: d, to: a } ]
  unused:
    label: Unused
`);
    const codes = issuesFor({ 'plan/map.yaml': MAP, 'plan/features/shop.yaml': shop }).map((i) => i.code);
    expect(codes).toContain('decision-edge-unlabeled');
    expect(codes).toContain('orphan-flow');
  });

  it('accepts start and end nodes without a label', () => {
    const shop = feature(`  main:
    label: Shop
    nodes:
      - { id: s, type: start }
      - { id: a, type: step, label: A }
      - { id: e, type: end }
    edges: [ { from: s, to: a }, { from: a, to: e } ]
`);
    expect(errorsOf(issuesFor({ 'plan/map.yaml': MAP, 'plan/features/shop.yaml': shop }))).toEqual([]);
  });

  it('explains the unquoted-comma mistake in inline style', () => {
    const shop = feature(`  main:\n    label: Shop\n    nodes:\n      - { id: a, type: step, label: Collect CV, cover letter }\n`);
    const issue = only('unknown-key', { 'plan/map.yaml': MAP, 'plan/features/shop.yaml': shop });
    expect(issue.message).toMatch(/comma inside an unquoted value/);
  });

  it('keeps loading valid files when another file is broken', () => {
    const project = loadFromTexts({
      'plan/map.yaml': MAP,
      'plan/features/shop.yaml': VALID_SHOP,
      'plan/features/later.yaml': 'feature: later\nflows: [oops',
    });
    expect(project.features.find((f) => f.path.endsWith('shop.yaml'))?.data).not.toBeNull();
    expect(project.features.find((f) => f.path.endsWith('later.yaml'))?.data).toBeNull();
  });

  it('rolls progress up through child flows', () => {
    const index = indexProject(loadFromTexts({ 'plan/map.yaml': MAP, 'plan/features/shop.yaml': VALID_SHOP }));
    // browse (done) + checkout-flow's pay (done) and confirm (todo); the decision does not count.
    expect(flowProgress(index, 'shop')).toEqual({ done: 2, total: 3 });
    expect(flowProgress(index, 'checkout-flow')).toEqual({ done: 1, total: 2 });
  });
});
