import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../src/load.js';
import { getFlow, getOutline, listFeatures, mapView } from '../src/outline.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/career-app', import.meta.url));

describe('agent context views', () => {
  it('outlines every feature, child flow, component and connection without node details', async () => {
    const outline = getOutline(await loadProject(FIXTURE));
    expect(outline).toMatchSnapshot();
    expect(outline).not.toContain('parse-job');
  });

  it('shows the full flow with its path from the overview', async () => {
    const flow = getFlow(await loadProject(FIXTURE), 'pick-template-flow');
    expect(flow).toContain('Path: Overview › Job search and tailored applications › Tailor CV › Pick CV template');
    expect(flow).toContain('- uses-ats -> suggest-simple (yes)');
  });

  it('builds the per-turn map view with the current level', async () => {
    const view = mapView(await loadProject(FIXTURE), 'tailor-cv-flow');
    expect(view).toMatchSnapshot();
    expect(view.trim().split('\n').at(-1)).toBe('Current level: Overview › Job search and tailored applications › Tailor CV');
  });

  it('lists features with progress', async () => {
    expect(listFeatures(await loadProject(FIXTURE))).toContain('- job-search: Job search and tailored applications (4/18 done)');
  });
});
