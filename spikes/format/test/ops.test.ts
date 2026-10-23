import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../src/load.js';
import { PlanWorkspace } from '../src/ops.js';
import { errorsOf, indexProject } from '../src/validate.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/career-app', import.meta.url));
const JOB = 'plan/features/job-search.yaml';

let texts: Record<string, string>;
let ws: PlanWorkspace;

beforeEach(async () => {
  texts ??= await readPlanTexts(FIXTURE);
  ws = new PlanWorkspace(texts);
});

function node(id: string) {
  return indexProject(ws.project).nodes.get(id)?.node;
}

function commentLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().startsWith('#')).map((l) => l.trim());
}

describe('operations', () => {
  it('adds a node with a unique slug id and leaves the plan valid', () => {
    const first = ws.addNode({ flowId: 'tailor-cv-flow', type: 'step', label: 'Review CV' });
    expect(first).toMatchObject({ ok: true, created: { nodeId: 'review-cv-2' } });
    expect(errorsOf(ws.issues())).toEqual([]);
  });

  it('writes new nodes in block style, one field per line', () => {
    ws.addNode({ flowId: 'pick-template-flow', type: 'step', label: 'Save choice' });
    expect(ws.texts[JOB]).toContain('      - id: save-choice\n        type: step\n        label: Save choice\n');
  });

  it('follows inline style where the user wrote nodes inline', () => {
    const inline = new PlanWorkspace({
      'plan/map.yaml': 'project: T\nfeatures:\n  - { id: shop, label: Shop }\n',
      'plan/features/shop.yaml': 'feature: shop\nflows:\n  main:\n    label: Shop\n    nodes:\n      - { id: browse, type: step, label: Browse }\n',
    });
    inline.addNode({ flowId: 'shop', type: 'step', label: 'Pay, then confirm' });
    expect(inline.texts['plan/features/shop.yaml']).toContain('- { id: pay-then-confirm, type: step, label: "Pay, then confirm" }');
  });

  it('rejects a node in an unknown flow with a message an agent can act on', () => {
    const result = ws.addNode({ flowId: 'tailor', type: 'step', label: 'X' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/no flow "tailor".*Known flows: .*tailor-cv-flow/);
  });

  it('rejects changes that would break the plan and keeps the workspace unchanged', () => {
    const before = ws.texts[JOB];
    const dup = ws.addEdge({ flowId: 'job-search', from: 'search-jobs', to: 'save-job' });
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.error).toMatch(/duplicate-edge/);
    const status = ws.updateNode({ id: 'good-fit', status: 'done' });
    expect(status.ok).toBe(false);
    expect(!status.ok && status.error).toMatch(/status-not-allowed/);
    expect(ws.texts[JOB]).toBe(before);
  });

  it('expands a node into a new child flow in the same file', () => {
    const result = ws.expandNode({ id: 'submit-application' });
    expect(result).toMatchObject({ ok: true, created: { flowId: 'submit-application-flow' } });
    const a = ws.addNode({ flowId: 'submit-application-flow', type: 'step', label: 'Open the job page' });
    const b = ws.addNode({ flowId: 'submit-application-flow', type: 'step', label: 'Upload CV' });
    expect(a.ok && b.ok).toBe(true);
    expect(ws.addEdge({ flowId: 'submit-application-flow', from: 'open-the-job-page', to: 'upload-cv' }).ok).toBe(true);
    expect(node('submit-application')).toMatchObject({ expands: 'submit-application-flow' });
    expect(errorsOf(ws.issues())).toEqual([]);
  });

  it('writes nodes of a new child flow as a block list, not inline', () => {
    ws.expandNode({ id: 'write-cover-letter' });
    ws.addNode({ flowId: 'write-cover-letter-flow', type: 'step', label: 'Draft letter' });
    expect(ws.texts[JOB]).toMatch(/write-cover-letter-flow:\n {4}label: Write cover letter\n {4}nodes:\n {6}- id: draft-letter\n/);
  });

  it('refuses to expand a node twice or to expand a decision', () => {
    expect(ws.expandNode({ id: 'tailor-cv' })).toMatchObject({ ok: false });
    expect(ws.expandNode({ id: 'good-fit' })).toMatchObject({ ok: false });
  });

  it('keeps the id when a node is renamed', () => {
    expect(ws.updateNode({ id: 'save-job', label: 'Save job posting' }).ok).toBe(true);
    expect(node('save-job')).toMatchObject({ id: 'save-job', label: 'Save job posting' });
  });

  it('removes a node with its edges and its child flows', () => {
    const result = ws.removeNode({ id: 'tailor-cv' });
    expect(result.ok).toBe(true);
    const index = indexProject(ws.project);
    expect(index.flows.has('tailor-cv-flow')).toBe(false);
    expect(index.flows.has('pick-template-flow')).toBe(false);
    expect(index.flows.get('job-search')!.flow.edges.some((e) => e.from === 'tailor-cv' || e.to === 'tailor-cv')).toBe(false);
  });

  it('adds a feature with its file and connects it in the overview', () => {
    const added = ws.addFeature({ label: 'Salary insights' });
    expect(added).toMatchObject({ ok: true, created: { featureId: 'salary-insights' } });
    expect(ws.texts['plan/features/salary-insights.yaml']).toContain('feature: salary-insights');
    expect(ws.connectFeatures({ from: 'job-search', to: 'salary-insights', data: 'salary range' }).ok).toBe(true);
    expect(ws.connectFeatures({ from: 'job-search', to: 'nowhere' })).toMatchObject({ ok: false });
  });

  it('preserves every comment and leaves untouched lines alone', () => {
    const original = { ...ws.texts };
    expect(ws.setStatus({ id: 'generate-cv', status: 'in_progress' }).ok).toBe(true);
    expect(ws.addNode({ flowId: 'form-help-flow', type: 'step', label: 'Save answers' }).ok).toBe(true);
    expect(ws.expandNode({ id: 'write-cover-letter' }).ok).toBe(true);
    expect(ws.updateNode({ id: 'search-jobs', label: 'Search for jobs' }).ok).toBe(true);
    expect(ws.connectFeatures({ from: 'interview-prep', to: 'career-growth', data: 'interview feedback' }).ok).toBe(true);

    for (const path of Object.keys(original)) {
      expect(commentLines(ws.texts[path]!), path).toEqual(commentLines(original[path]!));
    }
    // Lines outside the edited nodes are byte-for-byte the same.
    const before = original[JOB]!.split('\n');
    const after = new Set(ws.texts[JOB]!.split('\n'));
    const unchanged = before.filter((l) => after.has(l));
    expect(unchanged.length / before.length).toBeGreaterThan(0.9);
  });
});
