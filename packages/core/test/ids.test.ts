import { describe, expect, it } from 'vitest';
import { allIds, slugify, uniqueId } from '../src/ids.js';
import { loadFromTexts } from '../src/load.js';

describe('slugify', () => {
  it('makes readable lowercase slugs', () => {
    expect(slugify('Pick dates')).toBe('pick-dates');
    expect(slugify('  Tool available?! ')).toBe('tool-available');
    expect(slugify('Crème brûlée')).toBe('creme-brulee');
  });

  it('keeps at most six words', () => {
    expect(slugify('one two three four five six seven eight')).toBe('one-two-three-four-five-six');
  });

  it('falls back when nothing is left', () => {
    expect(slugify('日本語')).toBe('item');
    expect(slugify('')).toBe('item');
  });
});

describe('uniqueId', () => {
  it('adds a suffix only when taken', () => {
    expect(uniqueId('a', new Set())).toBe('a');
    expect(uniqueId('a', new Set(['a']))).toBe('a-2');
    expect(uniqueId('a', new Set(['a', 'a-2']))).toBe('a-3');
  });
});

describe('allIds', () => {
  const project = loadFromTexts({
    'plan/map.yaml': 'project: P\nfeatures:\n  - id: f\n    label: F\ncomponents:\n  - id: db\n    label: DB\n    kind: database\n',
    'plan/features/f.yaml':
      'feature: f\nflows:\n  main:\n    label: F\n    nodes:\n      - id: n\n        type: step\n        label: N\n  child:\n    label: C\n',
  });

  it('collects every source of IDs', () => {
    for (const id of ['f', 'db', 'n', 'child']) expect(allIds(project).has(id), id).toBe(true);
  });

  it('reserves main and overview, so a generated ID can never collide with them', () => {
    const ids = allIds(project);
    expect(uniqueId(slugify('Overview'), ids)).toBe('overview-2');
    expect(uniqueId(slugify('Main'), ids)).toBe('main-2');
  });
});
