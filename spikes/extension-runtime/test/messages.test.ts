import { describe, expect, it } from 'vitest';
import { HostToView, ViewToHost } from '../src/shared/messages.js';
import type { ViewModel } from '../src/shared/viewModel.js';

const model: ViewModel = {
  project: 'Demo',
  issues: [],
  levels: {
    overview: {
      id: 'overview',
      title: 'Demo',
      parent: null,
      crumbs: [{ id: 'overview', title: 'Demo' }],
      depth: 0,
      progress: { done: 0, total: 1 },
      source: { file: 'plan/map.yaml', line: 1 },
      edges: [],
      nodes: [{ id: 'a', kind: 'feature', label: 'A', opens: 'a', progress: { done: 0, total: 1 }, source: { file: 'plan/map.yaml', line: 3 } }],
    },
  },
};

describe('bridge messages', () => {
  it('accepts a valid model and keeps it intact', () => {
    const parsed = HostToView.parse({ type: 'model', model, start: 'overview' });
    expect(parsed).toEqual({ type: 'model', model, start: 'overview' });
  });

  it('rejects an unknown message type', () => {
    expect(HostToView.safeParse({ type: 'deleteEverything' }).success).toBe(false);
    expect(ViewToHost.safeParse({ type: 'eval', code: '1' }).success).toBe(false);
  });

  it('rejects openSource with a bad line', () => {
    expect(ViewToHost.safeParse({ type: 'openSource', file: 'plan/map.yaml', line: '3' }).success).toBe(false);
    expect(ViewToHost.safeParse({ type: 'openSource', file: 'plan/map.yaml', line: 0 }).success).toBe(false);
    expect(ViewToHost.safeParse({ type: 'openSource', file: 'plan/map.yaml', line: 3 }).success).toBe(true);
  });

  it('rejects extra keys on nodes', () => {
    const bad = structuredClone(model) as unknown as { levels: { overview: { nodes: Record<string, unknown>[] } } };
    bad.levels.overview.nodes[0]!.script = 'x';
    expect(HostToView.safeParse({ type: 'model', model: bad }).success).toBe(false);
  });
});
