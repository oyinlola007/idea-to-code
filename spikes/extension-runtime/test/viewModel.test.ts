import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFromTexts, loadProject, readPlanTexts } from '../../format/src/load.js';
import { buildViewModel } from '../src/host/viewModel.js';
import type { ViewModel } from '../src/shared/viewModel.js';

const FIXTURE = fileURLToPath(new URL('../../format/fixtures/career-app', import.meta.url));

let vm: ViewModel;
beforeAll(async () => {
  vm = buildViewModel(await loadProject(FIXTURE));
});

const node = (level: string, id: string) => vm.levels[level]!.nodes.find((n) => n.id === id)!;

describe('buildViewModel on the career app', () => {
  it('has the overview plus one level per flow', () => {
    expect(Object.keys(vm.levels).sort()).toEqual(
      ['overview', 'job-search', 'tailor-cv-flow', 'pick-template-flow', 'form-help-flow', 'email-integration', 'connect-flow', 'classify-flow'].sort(),
    );
    expect(vm.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('builds the overview from features, components and connections', () => {
    const o = vm.levels.overview!;
    expect(o.nodes.filter((n) => n.kind === 'feature')).toHaveLength(6);
    expect(o.nodes.filter((n) => n.kind === 'component').map((n) => n.id)).toEqual(['app-database', 'llm-api']);
    expect(o.edges).toHaveLength(8);
    expect(o.parent).toBeNull();
    expect(node('overview', 'job-search').opens).toBe('job-search');
    expect(node('overview', 'interview-prep').planned).toBe(true);
    expect(node('overview', 'interview-prep').opens).toBeUndefined();
    expect(node('overview', 'llm-api')).toMatchObject({ componentKind: 'external-api', tech: 'Claude API' });
  });

  it('links expandable steps to their child flow with computed progress', () => {
    const tailor = node('job-search', 'tailor-cv');
    expect(tailor.opens).toBe('tailor-cv-flow');
    expect(tailor.progress?.total).toBeGreaterThan(0);
    expect(tailor.status).toBeUndefined();
    expect(node('tailor-cv-flow', 'parse-job').status).toBe('done');
  });

  it('gives each level its parent, crumbs and depth', () => {
    const deep = vm.levels['pick-template-flow']!;
    expect(deep.crumbs.map((c) => c.id)).toEqual(['overview', 'job-search', 'tailor-cv-flow', 'pick-template-flow']);
    expect(deep.crumbs[0]!.title).toBe('Career Manager');
    expect(deep.depth).toBe(3);
    expect(deep.parent).toBe('tailor-cv-flow');
    expect(vm.levels['job-search']!.parent).toBe('overview');
  });

  it('resolves references to components and features', () => {
    const llm = node('tailor-cv-flow', 'cv-llm');
    expect(llm).toMatchObject({ kind: 'reference', refLabel: 'LLM API', componentKind: 'external-api' });
    expect(llm.jumpsTo).toBeUndefined();
    const tracker = vm.levels['job-search']!.nodes.find((n) => n.kind === 'reference' && n.refLabel === 'Application tracker');
    expect(tracker?.jumpsTo).toBeUndefined();
  });

  it('points every node at its YAML line', () => {
    const tailor = node('job-search', 'tailor-cv');
    expect(tailor.source.file).toBe('plan/features/job-search.yaml');
    expect(tailor.source.line).toBe(25);
    expect(node('overview', 'job-search').source).toEqual({ file: 'plan/map.yaml', line: 10 });
  });
});

describe('buildViewModel on a broken plan', () => {
  it('keeps the valid levels and reports the error with a line', async () => {
    const texts = await readPlanTexts(FIXTURE);
    texts['plan/features/email-integration.yaml'] = 'feature: email-integration\nflows:\n  main: [unclosed\n';
    const broken = buildViewModel(loadFromTexts(texts));
    expect(broken.levels['job-search']).toBeDefined();
    expect(broken.levels['email-integration']).toBeUndefined();
    expect(broken.levels.overview!.nodes.find((n) => n.id === 'email-integration')?.planned).toBe(true);
    const error = broken.issues.find((i) => i.severity === 'error' && i.file === 'plan/features/email-integration.yaml');
    expect(error?.line).toBeGreaterThan(0);
  });
});
