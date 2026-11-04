// Where the chart goes after a change, worked out from real edits on the Toolshed fixture.
import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { loadFromTexts } from '../src/load.js';
import { applyOperation } from '../src/opDefinitions.js';
import { Reveal, revealChanges } from '../src/reveal.js';
import { fixturePath } from './helpers.js';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await readPlanTexts(fixturePath('toolshed'));
});

function revealAfter(...ops: [string, unknown][]) {
  let texts = toolshed;
  for (const [name, input] of ops) {
    const r = applyOperation(texts, { name, input });
    if (!r.ok) throw new Error(`${name}: ${r.message}`);
    texts = r.texts;
  }
  return revealChanges(loadFromTexts(toolshed), loadFromTexts(texts));
}

describe('revealChanges', () => {
  it('has nowhere to go when nothing changed', () => {
    expect(revealChanges(loadFromTexts(toolshed), loadFromTexts(toolshed))).toBeNull();
  });

  it('opens the exact level of a change deep down, with the changed card', () => {
    expect(revealAfter(['set_status', { id: 'record-deposit', status: 'done' }])).toEqual({
      level: 'take-deposit-flow',
      ids: ['record-deposit'],
    });
  });

  it('lists several changed cards on one level in the order they are drawn', () => {
    expect(
      revealAfter(['update_node', { id: 'join-waitlist', label: 'Wait for it' }], ['set_status', { id: 'browse-tools', status: 'todo' }]),
    ).toEqual({ level: 'bookings', ids: ['browse-tools', 'join-waitlist'] });
  });

  it('opens the highest level shared by changes on two levels, marking the card that leads down', () => {
    expect(
      revealAfter(
        ['set_status', { id: 'record-deposit', status: 'done' }],
        ['update_node', { id: 'confirm-booking', label: 'Confirm it' }],
      ),
    ).toEqual({ level: 'place-booking-flow', ids: ['take-deposit', 'confirm-booking'] });
  });

  it('goes to the overview when changes are in different features', () => {
    expect(
      revealAfter(['set_status', { id: 'record-deposit', status: 'done' }], ['update_component', { id: 'app-db', tech: 'SQLite' }]),
    ).toEqual({ level: 'overview', ids: ['bookings', 'app-db'] });
  });

  it('opens a new flow without ringing every card in it', () => {
    const reveal = revealAfter([
      'fill_flow',
      { flowId: 'reminders', nodes: [{ key: 'a', type: 'step', label: 'Text the borrower' }], edges: [] },
    ]);
    expect(reveal).toEqual({ level: 'reminders', ids: [] });
  });

  it('marks a new feature on the overview', () => {
    const reveal = revealAfter(['add_feature', { label: 'Fees' }]);
    expect(reveal).toEqual({ level: 'overview', ids: ['fees'] });
  });

  it('shows a removal at its level, marking the cards it was connected to', () => {
    expect(revealAfter(['remove_node', { id: 'join-waitlist' }])).toEqual({ level: 'bookings', ids: ['tool-available', 'waitlist-end'] });
  });

  it('parses as a bridge payload', () => {
    expect(Reveal.safeParse({ level: 'bookings', ids: ['a'] }).success).toBe(true);
    expect(Reveal.safeParse({ level: 'bookings', ids: ['a'], extra: 1 }).success).toBe(false);
  });
});
