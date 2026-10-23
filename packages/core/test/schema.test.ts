import { describe, expect, it } from 'vitest';
import { loadFromTexts } from '../src/load.js';
import { Node, nodeLabel, Slug } from '../src/schema.js';
import { validateProject } from '../src/validate.js';

const MAP = 'project: P\nfeatures:\n  - id: f\n    label: F\n';

function codesFor(nodeYaml: string): string[] {
  const feature = `feature: f\nflows:\n  main:\n    label: F\n    nodes:\n      - ${nodeYaml}\n`;
  return validateProject(loadFromTexts({ 'plan/map.yaml': MAP, 'plan/features/f.yaml': feature })).map((i) => i.code);
}

describe('schema', () => {
  it('parses every node type', () => {
    const nodes = [
      { id: 's', type: 'start' },
      { id: 'e', type: 'end', label: 'Done' },
      { id: 'st', type: 'step', label: 'Step', status: 'in_progress', expands: 'child' },
      { id: 'd', type: 'decision', label: 'OK?' },
      { id: 'c', type: 'component', label: 'DB', kind: 'database', tech: 'SQLite', status: 'done' },
      { id: 'r', type: 'reference', label: 'Ref', ref: 'other' },
    ];
    for (const n of nodes) expect(Node.safeParse(n).success, n.type).toBe(true);
  });

  it('rejects status and expands on node types that cannot have them', () => {
    expect(codesFor('{ id: d, type: decision, label: D, status: done }')).toContain('status-not-allowed');
    expect(codesFor('{ id: r, type: reference, label: R, ref: f, status: todo }')).toContain('status-not-allowed');
    expect(codesFor('{ id: s, type: start, status: done }')).toContain('status-not-allowed');
    expect(codesFor('{ id: d, type: decision, label: D, expands: x }')).toContain('expands-not-allowed');
  });

  it('rejects unknown keys and bad values', () => {
    expect(codesFor('{ id: a, type: step, label: A, colour: red }')).toContain('unknown-key');
    expect(codesFor('{ id: a, type: step, label: A, status: finished }')).toContain('schema');
    expect(codesFor('{ id: a, type: widget, label: A }')).toContain('schema');
  });

  it('accepts only lowercase hyphenated ids', () => {
    for (const ok of ['a', 'tool-1', 'take-deposit-flow']) expect(Slug.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['A', 'tool_1', '-x', 'x-', 'two  words', '']) expect(Slug.safeParse(bad).success, bad).toBe(false);
  });

  it('labels start and end nodes when the label is left out', () => {
    expect(nodeLabel({ id: 's', type: 'start' })).toBe('Start');
    expect(nodeLabel({ id: 'e', type: 'end' })).toBe('End');
    expect(nodeLabel({ id: 'e', type: 'end', label: 'Booked' })).toBe('Booked');
  });
});
