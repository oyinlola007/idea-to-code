// Real edits, made with the operations on the Toolshed fixture, then compared.
import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { diffProjects, type Change } from '../src/diff.js';
import { loadFromTexts } from '../src/load.js';
import { applyOperation } from '../src/opDefinitions.js';
import { fixturePath } from './helpers.js';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await readPlanTexts(fixturePath('toolshed'));
});

function edit(...ops: [string, unknown][]): Record<string, string> {
  let texts = toolshed;
  for (const [name, input] of ops) {
    const r = applyOperation(texts, { name, input });
    if (!r.ok) throw new Error(`${name}: ${r.message}`);
    texts = r.texts;
  }
  return texts;
}

const diffAfter = (...ops: [string, unknown][]) => diffProjects(loadFromTexts(toolshed), loadFromTexts(edit(...ops)));
const kinds = (changes: Change[]) => changes.map((c) => c.kind);

describe('diffProjects', () => {
  it('finds nothing between identical versions', () => {
    expect(diffProjects(loadFromTexts(toolshed), loadFromTexts(toolshed))).toEqual({ changes: [], unreadable: [] });
  });

  it('treats a renamed label as a change, not a delete plus an add', () => {
    const { changes } = diffAfter(['update_node', { id: 'pick-dates', label: 'Choose dates' }]);
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'node-changed',
        id: 'pick-dates',
        label: 'Choose dates',
        fields: [{ field: 'label', from: 'Pick dates', to: 'Choose dates' }],
      }),
    ]);
  });

  it('reports every changed field of a node', () => {
    const { changes } = diffAfter(['update_node', { id: 'handover-api', label: 'API', tech: 'Go', description: 'Scans.' }]);
    expect(changes[0]).toMatchObject({
      kind: 'node-changed',
      fields: [
        { field: 'label', from: 'Handover API', to: 'API' },
        { field: 'description', from: null, to: 'Scans.' },
        { field: 'tech', from: 'Node.js', to: 'Go' },
      ],
    });
  });

  it('finds added and removed nodes, with where they are', () => {
    const added = diffAfter(['add_node', { flowId: 'take-deposit-flow', type: 'step', label: 'Send receipt' }]).changes[0];
    expect(added).toMatchObject({
      kind: 'node-added',
      id: 'send-receipt',
      nodeType: 'step',
      level: 'take-deposit-flow',
      levelLabel: 'Take deposit',
      path: ['overview', 'bookings', 'place-booking-flow', 'take-deposit-flow'],
    });
    const removed = diffAfter(['remove_node', { id: 'join-waitlist' }]).changes;
    expect(kinds(removed).sort()).toEqual(['edge-removed', 'edge-removed', 'node-removed']);
    expect(removed.find((c) => c.kind === 'node-removed')).toMatchObject({ id: 'join-waitlist', level: 'bookings' });
  });

  it('finds status changes on their own, and treats no status as to do', () => {
    expect(diffAfter(['set_status', { id: 'join-waitlist', status: 'done' }]).changes).toEqual([
      expect.objectContaining({ kind: 'status-changed', id: 'join-waitlist', label: 'Join the waitlist', from: 'todo', to: 'done' }),
    ]);
    const noStatus = (toolshed['plan/features/bookings.yaml'] ?? '').replace(
      '        label: Join the waitlist\n        status: todo\n',
      '        label: Join the waitlist\n',
    );
    const after = loadFromTexts({ ...toolshed, 'plan/features/bookings.yaml': noStatus });
    expect(diffProjects(loadFromTexts(toolshed), after).changes).toEqual([]);
  });

  it('reports a status change on a shared component at the overview', () => {
    expect(diffAfter(['update_component', { id: 'payments-api', status: 'in_progress' }]).changes).toEqual([
      expect.objectContaining({ kind: 'status-changed', id: 'payments-api', level: 'overview', path: ['overview'], to: 'in_progress' }),
    ]);
  });

  it('shows expanding a node as a new flow, without a status change', () => {
    const { changes } = diffAfter(['expand_node', { id: 'join-waitlist' }]);
    expect(kinds(changes).sort()).toEqual(['flow-added', 'node-changed']);
    expect(changes.find((c) => c.kind === 'node-changed')).toMatchObject({
      fields: [{ field: 'expands', from: null, to: 'join-waitlist-flow' }],
    });
  });

  it('lists the contents of a new or removed flow, so a diff can mark them', () => {
    const { changes } = diffAfter(['remove_node', { id: 'take-deposit' }]);
    expect(changes.find((c) => c.kind === 'flow-removed')).toMatchObject({
      id: 'take-deposit-flow',
      nodes: 8,
      path: ['overview', 'bookings', 'place-booking-flow', 'take-deposit-flow'],
    });
    expect(changes.filter((c) => c.kind === 'node-removed')).toHaveLength(9);
  });

  it('finds a node moved to another flow, even with another field changed', () => {
    const before = toolshed['plan/features/bookings.yaml'] ?? '';
    const moved = before
      .replace('      - id: hold-tool\n        type: step\n        label: Hold the tool for the dates\n        status: done\n', '')
      .replace(
        '      - from: place-booking-start\n        to: hold-tool\n',
        '      - from: place-booking-start\n        to: take-deposit\n',
      )
      .replace('      - from: hold-tool\n        to: take-deposit\n        data: hold id\n', '')
      .replace(
        '      - id: create-payment\n',
        '      - id: hold-tool\n        type: step\n        label: Hold it\n        status: done\n      - id: create-payment\n',
      );
    const { changes } = diffProjects(loadFromTexts(toolshed), loadFromTexts({ ...toolshed, 'plan/features/bookings.yaml': moved }));
    expect(changes.find((c) => c.kind === 'node-moved')).toMatchObject({
      id: 'hold-tool',
      fromFlow: 'place-booking-flow',
      toFlow: 'take-deposit-flow',
      toFlowLabel: 'Take deposit',
      level: 'take-deposit-flow',
    });
    expect(changes.find((c) => c.kind === 'node-changed')).toMatchObject({ id: 'hold-tool', fields: [{ field: 'label' }] });
    expect(changes.some((c) => c.kind === 'node-removed' || c.kind === 'node-added')).toBe(false);
  });

  it('finds edge changes', () => {
    const { changes } = diffAfter(
      ['add_edge', { flowId: 'bookings', from: 'join-waitlist', to: 'bookings-end' }],
      ['update_edge', { flowId: 'bookings', from: 'browse-tools', to: 'pick-dates', data: 'tool id' }],
      ['remove_edge', { flowId: 'bookings', from: 'join-waitlist', to: 'waitlist-end' }],
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'edge-added', from: 'join-waitlist', to: 'bookings-end', level: 'bookings' }),
        expect.objectContaining({
          kind: 'edge-changed',
          from: 'browse-tools',
          fields: [{ field: 'data', from: 'chosen tool', to: 'tool id' }],
        }),
        expect.objectContaining({ kind: 'edge-removed', from: 'join-waitlist', to: 'waitlist-end' }),
      ]),
    );
  });

  it('finds features, components and connections at the overview', () => {
    const { changes } = diffAfter(
      ['add_feature', { label: 'Insurance' }],
      ['update_feature', { id: 'members', label: 'People' }],
      ['add_component', { label: 'Cache', kind: 'cache' }],
      ['update_component', { id: 'sms-service', tech: 'Vonage' }],
      ['connect_features', { from: 'catalogue', to: 'members', data: 'owner id' }],
      ['update_connection', { from: 'members', to: 'bookings', data: 'trust' }],
      ['disconnect_features', { from: 'bookings', to: 'reminders' }],
    );
    expect(kinds(changes)).toEqual(
      expect.arrayContaining([
        'feature-added',
        'feature-changed',
        'component-added',
        'component-changed',
        'connection-added',
        'connection-changed',
        'connection-removed',
        'flow-added',
      ]),
    );
    expect(changes.filter((c) => c.kind.startsWith('feature')).every((c) => c.level === 'overview')).toBe(true);
  });

  it('finds a removed feature with its flows, nodes and connections', () => {
    const { changes } = diffAfter(['remove_feature', { id: 'handover' }]);
    expect(changes.find((c) => c.kind === 'feature-removed')).toMatchObject({ id: 'handover', label: 'Pickup and return' });
    expect(changes.find((c) => c.kind === 'flow-removed')).toMatchObject({ id: 'handover' });
    expect(changes.filter((c) => c.kind === 'node-removed')).toHaveLength(6);
    expect(changes.filter((c) => c.kind === 'connection-removed')).toHaveLength(2);
  });

  it('never reports the contents of an unreadable file as deleted', () => {
    const broken = { ...toolshed, 'plan/features/handover.yaml': 'feature: handover\nflows: [unclosed\n' };
    const d = diffProjects(loadFromTexts(toolshed), loadFromTexts(broken));
    expect(d.unreadable).toEqual(['plan/features/handover.yaml']);
    expect(d.changes).toEqual([]);
    expect(diffProjects(loadFromTexts(broken), loadFromTexts(toolshed))).toEqual({
      changes: [],
      unreadable: ['plan/features/handover.yaml'],
    });
  });

  it('still compares the readable files alongside an unreadable one', () => {
    const edited = edit(['set_status', { id: 'join-waitlist', status: 'done' }]);
    const d = diffProjects(loadFromTexts(toolshed), loadFromTexts({ ...edited, 'plan/features/handover.yaml': 'flows: [oops\n' }));
    expect(kinds(d.changes)).toEqual(['status-changed']);
  });

  it('skips the overview when map.yaml is unreadable', () => {
    const d = diffProjects(loadFromTexts(toolshed), loadFromTexts({ ...toolshed, 'plan/map.yaml': 'project: [oops\n' }));
    expect(d.unreadable).toEqual(['plan/map.yaml']);
    expect(d.changes).toEqual([]);
  });

  it('can compare with nothing, for the first version of a plan', () => {
    const d = diffProjects(loadFromTexts({}), loadFromTexts(toolshed));
    expect(kinds(d.changes)).toContain('flow-added');
    expect(d.changes.some((c) => c.kind.endsWith('removed'))).toBe(false);
  });

  it('is plain data', () => {
    const d = diffAfter(['update_node', { id: 'pick-dates', label: 'Choose dates' }]);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});
