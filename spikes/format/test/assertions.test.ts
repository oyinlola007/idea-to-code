import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { addChildFlow, generatedFeature, markDone } from '../harness/assertions.js';
import { readPlanTexts, type Project } from '../src/load.js';
import { PlanWorkspace } from '../src/ops.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/career-app', import.meta.url));
let texts: Record<string, string>;
let before: Project;

beforeAll(async () => {
  texts = await readPlanTexts(FIXTURE);
  before = new PlanWorkspace(texts).project;
});

describe('task assertions', () => {
  it('markDone passes for exactly that change and fails for extra edits', () => {
    const ws = new PlanWorkspace(texts);
    ws.setStatus({ id: 'archive-job', status: 'done' });
    expect(markDone(before, ws.project, 'archive-job').passed).toBe(true);
    ws.updateNode({ id: 'save-job', label: 'Changed' });
    expect(markDone(before, ws.project, 'archive-job').failures).toContain('other nodes changed too');
  });

  it('addChildFlow checks size and connectivity', () => {
    const ws = new PlanWorkspace(texts);
    ws.expandNode({ id: 'submit-application' });
    const labels = ['Open job page', 'Fill the form', 'Attach CV', 'Send'];
    for (const label of labels) ws.addNode({ flowId: 'submit-application-flow', type: 'step', label });
    expect(addChildFlow(before, ws.project, 'submit-application').failures.join()).toMatch(/unconnected/);
    const ids = ['open-job-page', 'fill-the-form', 'attach-cv', 'send'];
    for (let i = 0; i < ids.length - 1; i++) ws.addEdge({ flowId: 'submit-application-flow', from: ids[i]!, to: ids[i + 1]! });
    expect(addChildFlow(before, ws.project, 'submit-application')).toMatchObject({ passed: true });
  });

  it('generatedFeature accepts a filled-in listed feature and rejects duplicates', () => {
    const ws = new PlanWorkspace(texts);
    const steps = ['Collect experiences', 'Draft STAR stories', 'Pick interview', 'Match questions', 'Mock interview'];
    for (const label of steps) expect(ws.addNode({ flowId: 'interview-prep', type: 'step', label }).ok).toBe(true);
    ws.addNode({ flowId: 'interview-prep', type: 'reference', label: 'LLM API', ref: 'llm-api' });
    const ids = ['collect-experiences', 'draft-star-stories', 'pick-interview', 'match-questions', 'mock-interview'];
    for (let i = 0; i < ids.length - 1; i++) ws.addEdge({ flowId: 'interview-prep', from: ids[i]!, to: ids[i + 1]! });
    ws.addEdge({ flowId: 'interview-prep', from: 'draft-star-stories', to: 'llm-api-2' });
    ws.expandNode({ id: 'mock-interview' });
    ws.addNode({ flowId: 'mock-interview-flow', type: 'step', label: 'Ask a question' });
    const x = { featureId: 'interview-prep', requireLlm: true, duplicatePattern: /interview/i };
    expect(generatedFeature(before, ws.project, x)).toMatchObject({ passed: true });
    ws.addFeature({ label: 'Interview preparation' });
    expect(generatedFeature(before, ws.project, x).failures.join()).toMatch(/duplicate feature/);
  });
});
