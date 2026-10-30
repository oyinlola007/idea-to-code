import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { diffProjects } from '../src/diff.js';
import { summarizeDiff } from '../src/diffSummary.js';
import { loadFromTexts } from '../src/load.js';
import { applyOperation } from '../src/opDefinitions.js';
import { fixturePath } from './helpers.js';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await readPlanTexts(fixturePath('toolshed'));
});

function summary(...ops: [string, unknown][]): string {
  let texts = toolshed;
  for (const [name, input] of ops) {
    const r = applyOperation(texts, { name, input });
    if (!r.ok) throw new Error(`${name}: ${r.message}`);
    texts = r.texts;
  }
  return summarizeDiff(diffProjects(loadFromTexts(toolshed), loadFromTexts(texts)));
}

describe('summarizeDiff', () => {
  it('says when nothing changed', () => {
    expect(summary()).toBe('No changes');
  });

  it('names status changes and renames', () => {
    expect(summary(['set_status', { id: 'join-waitlist', status: 'in_progress' }])).toBe("'Join the waitlist' → in progress");
    expect(summary(['update_node', { id: 'pick-dates', label: 'Choose dates' }])).toBe("Renamed 'Pick dates' to 'Choose dates'");
    expect(summary(['update_feature', { id: 'members', label: 'People' }])).toBe("Renamed 'Members and trust' to 'People'");
  });

  it('combines counts per level with named changes', () => {
    expect(
      summary(
        ['add_node', { flowId: 'bookings', type: 'step', label: 'One' }],
        ['add_node', { flowId: 'bookings', type: 'step', label: 'Two' }],
        ['update_node', { id: 'browse-tools', description: 'Nearby first.' }],
        ['set_status', { id: 'pick-dates', status: 'todo' }],
      ),
    ).toBe("'Pick dates' → todo; 2 nodes added, 1 node changed in Bookings");
  });

  it('counts connections, in the overview and in flows', () => {
    expect(summary(['connect_features', { from: 'catalogue', to: 'members' }])).toBe('1 connection added in Toolshed');
    expect(summary(['remove_edge', { flowId: 'bookings', from: 'browse-tools', to: 'pick-dates' }])).toBe(
      '1 connection removed in Bookings',
    );
  });

  it('says a new feature once, without listing its empty flow', () => {
    expect(summary(['add_feature', { label: 'Insurance' }])).toBe("Added feature 'Insurance'");
  });

  it('summarises a removed feature or flow without counting its contents', () => {
    expect(summary(['remove_feature', { id: 'handover' }])).toBe("Removed feature 'Pickup and return'; 2 connections removed in Toolshed");
    expect(summary(['remove_node', { id: 'take-deposit' }])).toContain("Removed flow 'Take deposit'");
    expect(summary(['remove_node', { id: 'take-deposit' }])).not.toContain('in Take deposit');
  });

  it('describes a new flow filled in one go', () => {
    expect(
      summary([
        'fill_flow',
        {
          flowId: 'reminders',
          nodes: [
            { key: 'a', type: 'step', label: 'Send text' },
            { key: 'b', type: 'step', label: 'Log it' },
          ],
          edges: [{ from: 'a', to: 'b' }],
        },
      ]),
    ).toBe("Added flow 'Reminders' with 2 nodes");
  });

  it('says when a file could not be compared', () => {
    const broken = loadFromTexts({ ...toolshed, 'plan/features/handover.yaml': 'flows: [oops\n' });
    expect(summarizeDiff(diffProjects(loadFromTexts(toolshed), broken))).toBe(
      "couldn't compare plan/features/handover.yaml, which can't be read",
    );
  });

  it('stays short however large the change', () => {
    const ops: [string, unknown][] = [
      'browse-tools',
      'pick-dates',
      'join-waitlist',
      'hold-tool',
      'confirm-booking',
      'create-payment',
      'record-deposit',
      'release-hold',
    ].map((id) => ['update_node', { id, label: `New ${id}` }]);
    const text = summary(...ops);
    expect(text.split('; ')).toHaveLength(7);
    expect(text.endsWith('and 2 more changes')).toBe(true);
  });
});
