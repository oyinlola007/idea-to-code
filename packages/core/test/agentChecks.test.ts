import { beforeAll, describe, expect, it } from 'vitest';
import { addChildFlow, generatedFeature, markDone } from '../scripts/agentChecks.js';
import { readPlanTexts } from '../scripts/readPlan.js';
import { loadFromTexts } from '../src/load.js';
import { applyOperation } from '../src/opDefinitions.js';
import { fixturePath } from './helpers.js';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await readPlanTexts(fixturePath('toolshed'));
});

function edit(...ops: [string, unknown][]) {
  let texts = toolshed;
  for (const [name, input] of ops) {
    const r = applyOperation(texts, { name, input });
    if (!r.ok) throw new Error(r.message);
    texts = r.texts;
  }
  return loadFromTexts(texts);
}

const before = () => loadFromTexts(toolshed);

describe('agent checks', () => {
  it('markDone passes only when just that node changed', () => {
    expect(markDone(before(), edit(['set_status', { id: 'record-deposit', status: 'done' }]), 'record-deposit').passed).toBe(true);
    expect(markDone(before(), before(), 'record-deposit').failures).toEqual(['node "record-deposit" is not done']);
    const extra = edit(['set_status', { id: 'record-deposit', status: 'done' }], ['set_status', { id: 'release-hold', status: 'done' }]);
    expect(markDone(before(), extra, 'record-deposit').failures).toEqual(['other nodes changed too']);
  });

  it('addChildFlow wants a connected flow of the right size', () => {
    const nodes = ['A', 'B', 'C', 'D'].map((l) => ({ key: l, type: 'step', label: `Step ${l}` }));
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'C', to: 'D' },
    ];
    const good = edit(['expand_node', { id: 'join-waitlist' }], ['fill_flow', { flowId: 'join-waitlist-flow', nodes, edges }]);
    expect(addChildFlow(before(), good, 'join-waitlist').passed).toBe(true);
    expect(addChildFlow(before(), before(), 'join-waitlist').passed).toBe(false);
    const loose = edit(['expand_node', { id: 'join-waitlist' }], ['fill_flow', { flowId: 'join-waitlist-flow', nodes }]);
    expect(addChildFlow(before(), loose, 'join-waitlist').failures.join(' ')).toContain('unconnected');
  });

  it('addChildFlow counts steps, not the start, end and decision nodes around them', () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `s${i}`, type: 'step', label: `Step ${i}` }));
    const flow = (n: number) => {
      const nodes = [{ key: 'b', type: 'start' }, ...steps(n), { key: 'd', type: 'decision', label: 'Free?' }, { key: 'e', type: 'end' }];
      const edges = nodes.slice(1).map((node, i) => ({ from: nodes[i]?.key ?? '', to: node.key }));
      return edit(['expand_node', { id: 'join-waitlist' }], ['fill_flow', { flowId: 'join-waitlist-flow', nodes, edges }]);
    };
    expect(addChildFlow(before(), flow(6), 'join-waitlist').passed).toBe(true);
    expect(addChildFlow(before(), flow(7), 'join-waitlist').failures).toEqual(['child flow has 7 steps, expected 4-6']);
    expect(addChildFlow(before(), flow(3), 'join-waitlist').failures).toEqual(['child flow has 3 steps, expected 4-6']);
  });

  it('generatedFeature catches a duplicate and a missing file', () => {
    const x = { featureId: 'reminders', minMainNodes: 1, requiredRef: 'sms-service', duplicatePattern: /remind/i };
    expect(generatedFeature(before(), before(), x).failures.join(' ')).toContain('no flows file');
    const dupe = edit(['add_feature', { label: 'Reminders' }]);
    expect(generatedFeature(before(), dupe, x).passed).toBe(false);
  });
});
