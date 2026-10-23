import { describe, expect, it } from 'vitest';
import { loadFromTexts, positionOf, projectTexts } from '../src/load.js';
import { validateProject } from '../src/validate.js';

const MAP = `project: P
features:
  - id: alpha
    label: Alpha
  - id: beta
    label: Beta
`;

describe('loader', () => {
  it('points positions at map keys and sequence items', () => {
    const project = loadFromTexts({ 'plan/map.yaml': MAP });
    const map = project.map!;
    expect(positionOf(map, ['features'])).toEqual({ line: 2, col: 1 });
    expect(positionOf(map, ['features', 1])).toEqual({ line: 5, col: 5 });
    expect(positionOf(map, ['features', 1, 'label']).line).toBe(6);
    // A path that doesn't exist falls back to its nearest existing ancestor.
    expect(positionOf(map, ['features', 1, 'nope']).line).toBe(5);
  });

  it('reports YAML syntax errors with a line and keeps no data for that file', () => {
    const project = loadFromTexts({ 'plan/map.yaml': 'project: P\nfeatures: [unclosed\n' });
    expect(project.map?.data).toBeNull();
    const issue = validateProject(project).find((i) => i.code === 'yaml-syntax');
    expect(issue?.file).toBe('plan/map.yaml');
    expect(issue?.line).toBeGreaterThan(0);
  });

  it('only reads plan files', () => {
    const project = loadFromTexts({
      'plan/map.yaml': MAP,
      'plan/features/alpha.yaml': 'feature: alpha\nflows:\n  main:\n    label: Alpha\n',
      'plan/features/notes.txt': 'not yaml',
      'src/features/beta.yaml': 'feature: beta\n',
    });
    expect(project.features.map((f) => f.path)).toEqual(['plan/features/alpha.yaml']);
  });

  it('returns the original texts unchanged', () => {
    const texts = { 'plan/map.yaml': MAP, 'plan/features/alpha.yaml': '# hi\nfeature: alpha\nflows:\n  main:\n    label: Alpha\n' };
    expect(projectTexts(loadFromTexts(texts))).toEqual(texts);
  });

  it('reports a missing map', () => {
    expect(validateProject(loadFromTexts({})).map((i) => i.code)).toEqual(['missing-map']);
  });
});
