import { applyOperation, type Reveal } from '@idea-to-code/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutsideEdits } from '../src/outsideEdits.js';
import { toolshedTexts } from './chat/helpers.js';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await toolshedTexts();
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function edit(texts: Record<string, string>, name: string, input: unknown): Record<string, string> {
  const result = applyOperation(texts, { name, input });
  if (!result.ok) throw new Error(result.message);
  return result.texts;
}

function watch() {
  const reveals: Reveal[] = [];
  const edits = new OutsideEdits((reveal) => reveals.push(reveal), 1000);
  return { edits, reveals };
}

describe('changes from outside the editor', () => {
  it('points out a burst of an agent’s changes once it pauses, as one change', () => {
    const { edits, reveals } = watch();
    edits.seen(toolshed, false);
    const first = edit(toolshed, 'set_status', { id: 'record-deposit', status: 'done' });
    edits.seen(first, false);
    vi.advanceTimersByTime(600);
    edits.seen(edit(first, 'update_node', { id: 'confirm-booking', label: 'Confirm it' }), false);
    vi.advanceTimersByTime(900);
    expect(reveals).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(reveals).toEqual([{ level: 'place-booking-flow', ids: ['take-deposit', 'confirm-booking'] }]);
  });

  it('never points out the user’s own changes, and drops a burst they interrupt', () => {
    const { edits, reveals } = watch();
    edits.seen(toolshed, false);
    const outside = edit(toolshed, 'set_status', { id: 'record-deposit', status: 'done' });
    edits.seen(outside, false);
    edits.seen(edit(outside, 'set_status', { id: 'pick-dates', status: 'todo' }), true);
    vi.advanceTimersByTime(5000);
    expect(reveals).toEqual([]);
  });

  it('ignores the first look at a plan, a refresh with nothing new, and a burst that undoes itself', () => {
    const { edits, reveals } = watch();
    edits.seen(toolshed, false);
    edits.seen({ ...toolshed }, false);
    edits.seen(edit(toolshed, 'set_status', { id: 'record-deposit', status: 'done' }), false);
    edits.seen(toolshed, false);
    vi.advanceTimersByTime(5000);
    expect(reveals).toEqual([]);
  });

  it('starts again for another plan', () => {
    const { edits, reveals } = watch();
    edits.seen(toolshed, false);
    edits.seen(edit(toolshed, 'set_status', { id: 'record-deposit', status: 'done' }), false);
    edits.reset();
    vi.advanceTimersByTime(5000);
    edits.seen(toolshed, false);
    vi.advanceTimersByTime(5000);
    expect(reveals).toEqual([]);
  });
});
