import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { AppState, HostMessage, summarizePlan, WebviewMessage } from '../src/bridge.js';
import { newPlanMap } from '../src/guide.js';
import { errorsOf, validateProject } from '../src/validate.js';
import { loadFromTexts } from '../src/load.js';
import { buildViewModel } from '../src/viewModel.js';
import { fixturePath } from './helpers.js';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await readPlanTexts(fixturePath('toolshed'));
});

describe('summarizePlan', () => {
  it('summarizes Toolshed with computed progress', () => {
    const plan = summarizePlan(toolshed);
    expect(plan.project).toBe('Toolshed');
    expect(plan.features.map((f) => f.id)).toEqual(['members', 'catalogue', 'bookings', 'handover', 'reminders']);
    expect(plan.features.find((f) => f.id === 'reminders')).toMatchObject({ planned: true, done: 0, total: 0 });
    expect(plan.features.find((f) => f.id === 'bookings')?.planned).toBe(false);
    expect({ done: plan.done, total: plan.total }).toEqual({ done: 7, total: 15 });
    expect(plan.problems).toEqual([]);
  });

  it('reports a broken map as a problem instead of throwing', () => {
    const plan = summarizePlan({ 'plan/map.yaml': 'project: [unclosed' });
    expect(plan.project).toBeNull();
    expect(plan.features).toEqual([]);
    expect(plan.problems[0]).toMatchObject({ file: 'plan/map.yaml', severity: 'error' });
  });

  it('produces state the bridge accepts', () => {
    const model = buildViewModel(loadFromTexts(toolshed));
    const message = { type: 'state', state: { kind: 'plan', trusted: true, folder: 'toolshed', plan: summarizePlan(toolshed), model } };
    expect(HostMessage.safeParse(message).success).toBe(true);
  });
});

describe('newPlanMap', () => {
  it('is a valid plan, and quotes a name YAML would misread', () => {
    for (const name of ['My App', 'yes', 'a: b # c', '123']) {
      const text = newPlanMap(name);
      const project = loadFromTexts({ 'plan/map.yaml': text });
      expect(errorsOf(validateProject(project)), name).toEqual([]);
      expect(project.map?.data?.project, name).toBe(name);
    }
  });
});

describe('bridge messages', () => {
  it('accepts what the webview sends', () => {
    for (const m of [
      { type: 'ready' },
      { type: 'log', level: 'error', message: 'boot: failed' },
      { type: 'rendered', kind: 'plan', features: 5, problems: 3 },
      { type: 'level', level: 'bookings' },
      { type: 'init-plan' },
      { type: 'open-source', file: 'plan/map.yaml', line: 3 },
    ]) {
      expect(WebviewMessage.safeParse(m).success, m.type).toBe(true);
    }
  });

  it('rejects anything else, in both directions', () => {
    for (const m of [
      null,
      'ready',
      {},
      { type: 'nope' },
      { type: 'ready', extra: 1 },
      { type: 'log', level: 'debug', message: 'x' },
      { type: 'chart-rendered', level: 'overview', nodes: 1, width: 1, height: 1, layoutMs: 1, workerMode: 'url' },
      { type: 'log', level: 'info', message: 'x'.repeat(2001) },
      { type: 'open-source', file: 'plan/map.yaml', line: 0 },
      { type: 'open-source', file: 'plan/map.yaml' },
    ]) {
      expect(WebviewMessage.safeParse(m).success, JSON.stringify(m)).toBe(false);
    }
    for (const m of [{}, { type: 'state' }, { type: 'state', state: { kind: 'plan', trusted: true } }]) {
      expect(HostMessage.safeParse(m).success, JSON.stringify(m)).toBe(false);
    }
    expect(AppState.safeParse({ kind: 'no-plan', trusted: 'yes' }).success).toBe(false);
  });
});
