import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { loadFromTexts } from '../src/load.js';
import { applyOperation } from '../src/opDefinitions.js';
import { errorsOf, indexProject, validateProject } from '../src/validate.js';
import { fixturePath } from './helpers.js';

const REMINDERS = 'plan/features/reminders.yaml';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await readPlanTexts(fixturePath('toolshed'));
});

const FLOW = {
  flowId: 'reminders',
  nodes: [
    { key: 's', type: 'start' },
    { key: 'due', type: 'step', label: 'Find bookings due tomorrow', status: 'done' },
    { key: 'optin', type: 'decision', label: 'Texts allowed?' },
    { key: 'send', type: 'step', label: 'Send text' },
    { key: 'sms', type: 'reference', label: 'SMS service', ref: 'sms-service' },
    { key: 'e', type: 'end', label: 'Done for today' },
  ],
  edges: [
    { from: 's', to: 'due' },
    { from: 'due', to: 'optin', data: 'booking list' },
    { from: 'optin', to: 'send', label: 'yes' },
    { from: 'optin', to: 'e', label: 'no' },
    { from: 'send', to: 'sms', data: 'reminder text' },
    { from: 'sms', to: 'e' },
  ],
};

describe('fill_flow', () => {
  it("writes a whole flow in one call, creating a listed feature's file", () => {
    const r = applyOperation(toolshed, { name: 'fill_flow', input: FLOW });
    if (!r.ok) throw new Error(r.message);
    expect(r.changed).toEqual([REMINDERS]);
    expect(r.created).toMatchObject({ due: 'find-bookings-due-tomorrow', optin: 'texts-allowed', file: REMINDERS });
    expect(errorsOf(validateProject(loadFromTexts(r.texts)))).toEqual([]);
    const flow = indexProject(loadFromTexts(r.texts)).flows.get('reminders')?.flow;
    expect(flow?.nodes).toHaveLength(6);
    expect(flow?.edges).toHaveLength(6);
    expect(flow?.edges).toContainEqual({ from: 'texts-allowed', to: 'send-text', label: 'yes' });
  });

  it('writes block style', () => {
    const r = applyOperation(toolshed, { name: 'fill_flow', input: FLOW });
    if (!r.ok) throw new Error(r.message);
    expect(r.texts[REMINDERS]).toContain('      - id: send-text\n        type: step\n        label: Send text\n');
    expect(r.texts[REMINDERS]).toContain('      - from: texts-allowed\n        to: send-text\n        label: yes\n');
  });

  it('fills a new child flow from expand_node', () => {
    const expanded = applyOperation(toolshed, { name: 'expand_node', input: { id: 'join-waitlist' } });
    if (!expanded.ok) throw new Error(expanded.message);
    const r = applyOperation(expanded.texts, {
      name: 'fill_flow',
      input: {
        flowId: expanded.created.flowId,
        nodes: [
          { key: 'a', type: 'step', label: 'Save position' },
          { key: 'b', type: 'step', label: 'Notify when free' },
        ],
        edges: [{ from: 'a', to: 'b', data: 'position' }],
      },
    });
    if (!r.ok) throw new Error(r.message);
    expect(errorsOf(validateProject(loadFromTexts(r.texts)))).toEqual([]);
    expect(indexProject(loadFromTexts(r.texts)).flows.get('join-waitlist-flow')?.flow.nodes).toHaveLength(2);
  });

  it('appends to an existing flow, and edges can use existing node ids', () => {
    const r = applyOperation(toolshed, {
      name: 'fill_flow',
      input: {
        flowId: 'bookings',
        nodes: [{ key: 'notify', type: 'step', label: 'Notify owner' }],
        edges: [{ from: 'join-waitlist', to: 'notify' }],
      },
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.created).toEqual({ notify: 'notify-owner' });
    expect(indexProject(loadFromTexts(r.texts)).flows.get('bookings')?.flow.edges).toContainEqual({
      from: 'join-waitlist',
      to: 'notify-owner',
    });
  });

  it('can add only edges between existing nodes', () => {
    const r = applyOperation(toolshed, {
      name: 'fill_flow',
      input: { flowId: 'bookings', edges: [{ from: 'join-waitlist', to: 'bookings-end' }] },
    });
    expect(r.ok).toBe(true);
  });

  it('keeps ids unique within one call', () => {
    const r = applyOperation(toolshed, {
      name: 'fill_flow',
      input: {
        flowId: 'reminders',
        nodes: [
          { key: 'a', type: 'step', label: 'Send text' },
          { key: 'b', type: 'step', label: 'Send text' },
        ],
      },
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.created).toMatchObject({ a: 'send-text', b: 'send-text-2' });
  });

  it('refuses mistakes with the valid names, writing nothing', () => {
    const edge = applyOperation(toolshed, {
      name: 'fill_flow',
      input: { flowId: 'reminders', nodes: [{ key: 'a', type: 'step', label: 'A' }], edges: [{ from: 'a', to: 'b' }] },
    });
    expect(edge).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(!edge.ok && edge.message).toMatch(/"b".*Valid: a/);

    const dup = applyOperation(toolshed, {
      name: 'fill_flow',
      input: {
        flowId: 'reminders',
        nodes: [
          { key: 'a', type: 'step', label: 'A' },
          { key: 'a', type: 'step', label: 'B' },
        ],
      },
    });
    expect(dup).toMatchObject({ ok: false, code: 'invalid-input' });

    expect(applyOperation(toolshed, { name: 'fill_flow', input: { flowId: 'reminders' } })).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
    expect(
      applyOperation(toolshed, { name: 'fill_flow', input: { flowId: 'reminders', nodes: [{ key: 'a', type: 'step' }] } }),
    ).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
  });

  it('is all or nothing when the result would be invalid', () => {
    const r = applyOperation(toolshed, {
      name: 'fill_flow',
      input: {
        flowId: 'bookings',
        nodes: [
          { key: 'a', type: 'step', label: 'Good one' },
          { key: 'b', type: 'decision', label: 'Bad one', status: 'done' },
        ],
      },
    });
    expect(r).toMatchObject({ ok: false, code: 'rejected' });
    expect(!r.ok && r.message).toContain('status-not-allowed');
  });

  it('refuses an unknown flow', () => {
    expect(
      applyOperation(toolshed, { name: 'fill_flow', input: { flowId: 'nope', nodes: [{ key: 'a', type: 'step', label: 'A' }] } }),
    ).toMatchObject({
      ok: false,
      code: 'not-found',
    });
  });
});
