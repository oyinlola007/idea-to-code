import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { loadFromTexts } from '../src/load.js';
import { applyOperation } from '../src/opDefinitions.js';
import type { OpFailure, OpSuccess } from '../src/operations.js';
import { errorsOf, indexProject, validateProject } from '../src/validate.js';
import { fixturePath } from './helpers.js';

const MAP = 'plan/map.yaml';
const BOOKINGS = 'plan/features/bookings.yaml';
const HANDOVER = 'plan/features/handover.yaml';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await readPlanTexts(fixturePath('toolshed'));
});

/** Applies an operation that must succeed and must leave the plan without errors. */
function ok(texts: Record<string, string>, name: string, input: unknown): OpSuccess {
  const result = applyOperation(texts, { name, input });
  if (!result.ok) throw new Error(`${name} failed: ${result.message}`);
  expect(errorsOf(validateProject(loadFromTexts(result.texts))), name).toEqual([]);
  return result;
}

/** Applies an operation that must fail. */
function fails(texts: Record<string, string>, name: string, input: unknown): OpFailure {
  const result = applyOperation(texts, { name, input });
  if (result.ok) throw new Error(`${name} should have failed`);
  return result;
}

function indexOf(texts: Record<string, string>) {
  return indexProject(loadFromTexts(texts));
}

function nodeIn(texts: Record<string, string>, id: string) {
  return indexOf(texts).nodes.get(id)?.node;
}

describe('features', () => {
  it('adds a feature with its file', () => {
    const r = ok(toolshed, 'add_feature', { label: 'Tool insurance', description: 'Cover for damage.' });
    expect(r.created).toEqual({ featureId: 'tool-insurance', flowId: 'tool-insurance' });
    expect(r.changed.sort()).toEqual([MAP, 'plan/features/tool-insurance.yaml'].sort());
    expect(r.texts['plan/features/tool-insurance.yaml']).toContain('feature: tool-insurance');
    expect(r.texts[MAP]).toContain('  - id: tool-insurance\n    label: Tool insurance\n    description: Cover for damage.\n');
  });

  it('adds a suffix when the slug is taken, and avoids reserved ids', () => {
    expect(ok(toolshed, 'add_feature', { label: 'Bookings' }).created.featureId).toBe('bookings-2');
    expect(ok(toolshed, 'add_feature', { label: 'Overview' }).created.featureId).toBe('overview-2');
  });

  it('renames without changing the id, and the main flow follows only if it had the old name', () => {
    const r = ok(toolshed, 'update_feature', { id: 'bookings', label: 'Reservations' });
    expect(r.changed.sort()).toEqual([MAP, BOOKINGS].sort());
    const index = indexOf(r.texts);
    expect(index.features.get('bookings')?.label).toBe('Reservations');
    expect(index.flows.get('bookings')?.flow.label).toBe('Reservations');

    // handover's flow is also named "Pickup and return"; bookings' child flows keep their own names.
    expect(index.flows.get('place-booking-flow')?.flow.label).toBe('Place booking');

    const custom = ok(toolshed, 'update_feature', { id: 'handover', description: 'New words.' });
    expect(custom.changed).toEqual([MAP]);
  });

  it('leaves a main flow with its own name alone', () => {
    const texts = {
      ...toolshed,
      [HANDOVER]: (toolshed[HANDOVER] ?? '').replace('    label: Pickup and return\n', '    label: Handing tools over\n'),
    };
    const r = ok(texts, 'update_feature', { id: 'handover', label: 'Handover' });
    expect(indexOf(r.texts).flows.get('handover')?.flow.label).toBe('Handing tools over');
    expect(r.changed).toEqual([MAP]);
  });

  it('removes a field with null', () => {
    const r = ok(toolshed, 'update_feature', { id: 'members', description: null });
    expect(r.texts[MAP]).not.toContain('Sign-up, profiles');
  });

  it('removes a feature with its file and connections, and reports them', () => {
    const r = ok(toolshed, 'remove_feature', { id: 'handover' });
    expect(r.deleted).toEqual([HANDOVER]);
    expect(r.changed).toEqual([MAP]);
    expect(r.texts[HANDOVER]).toBeUndefined();
    const map = loadFromTexts(r.texts).map?.data;
    expect(map?.features.map((f) => f.id)).not.toContain('handover');
    expect(map?.connections.some((c) => c.from === 'handover' || c.to === 'handover')).toBe(false);
    expect(r.warnings.join(' ')).toContain('bookings -> handover');
    expect(r.warnings.join(' ')).toContain('handover -> members');
    expect(r.warnings.join(' ')).toContain(HANDOVER);
  });

  it('refuses to remove a feature another flow references, naming the node', () => {
    const f = fails(toolshed, 'remove_feature', { id: 'reminders' });
    expect(f.code).toBe('rejected');
    expect(f.message).toContain('notify-member');
    expect(f.message).toContain('unknown-ref');
  });

  it('reports an unknown feature with the known ones', () => {
    const f = fails(toolshed, 'update_feature', { id: 'nope', label: 'X' });
    expect(f.code).toBe('not-found');
    expect(f.message).toContain('bookings');
  });
});

describe('components', () => {
  it('adds and updates a component, keeping its id', () => {
    const added = ok(toolshed, 'add_component', { label: 'Photo storage', kind: 'storage', tech: 'S3' });
    expect(added.created).toEqual({ componentId: 'photo-storage' });
    const updated = ok(added.texts, 'update_component', { id: 'photo-storage', label: 'Tool photos', tech: null, status: 'in_progress' });
    const c = indexOf(updated.texts).components.get('photo-storage');
    expect(c).toMatchObject({ id: 'photo-storage', label: 'Tool photos', status: 'in_progress' });
    expect(c?.tech).toBeUndefined();
  });

  it('refuses to remove a component a reference node points at, naming the node', () => {
    const f = fails(toolshed, 'remove_component', { id: 'payments-api' });
    expect(f.code).toBe('rejected');
    expect(f.message).toContain('"payments"');
  });

  it('removes an unreferenced component with its connections', () => {
    const added = ok(toolshed, 'add_component', { label: 'Cache', kind: 'cache' });
    const linked = ok(added.texts, 'connect_features', { from: 'catalogue', to: 'cache', data: 'tool list' });
    const r = ok(linked.texts, 'remove_component', { id: 'cache' });
    expect(loadFromTexts(r.texts).map?.data?.components.map((c) => c.id)).not.toContain('cache');
    expect(r.warnings.join(' ')).toContain('catalogue -> cache');
  });
});

describe('connections', () => {
  it('connects, updates and disconnects', () => {
    const a = ok(toolshed, 'connect_features', { from: 'catalogue', to: 'members', data: 'owner id' });
    expect(a.changed).toEqual([MAP]);
    const b = ok(a.texts, 'update_connection', { from: 'catalogue', to: 'members', data: 'owner profile', label: 'lookup' });
    expect(loadFromTexts(b.texts).map?.data?.connections.find((c) => c.from === 'catalogue' && c.to === 'members')).toMatchObject({
      data: 'owner profile',
      label: 'lookup',
    });
    const c = ok(b.texts, 'update_connection', { from: 'catalogue', to: 'members', label: null });
    expect(loadFromTexts(c.texts).map?.data?.connections.find((x) => x.to === 'members' && x.from === 'catalogue')?.label).toBeUndefined();
    const d = ok(c.texts, 'disconnect_features', { from: 'catalogue', to: 'members' });
    expect(loadFromTexts(d.texts).map?.data?.connections).toHaveLength(7);
  });

  it('refuses unknown endpoints, duplicates and missing connections', () => {
    expect(fails(toolshed, 'connect_features', { from: 'bookings', to: 'nowhere' }).message).toContain('connection-unknown-endpoint');
    expect(fails(toolshed, 'connect_features', { from: 'members', to: 'bookings' }).message).toContain('duplicate-edge');
    expect(fails(toolshed, 'disconnect_features', { from: 'catalogue', to: 'members' }).code).toBe('not-found');
  });
});

describe('nodes', () => {
  it('adds a node with a generated id, in block style', () => {
    const r = ok(toolshed, 'add_node', { flowId: 'take-deposit-flow', type: 'step', label: 'Send receipt' });
    expect(r.created).toEqual({ nodeId: 'send-receipt' });
    expect(r.changed).toEqual([BOOKINGS]);
    expect(r.texts[BOOKINGS]).toContain('      - id: send-receipt\n        type: step\n        label: Send receipt\n');
  });

  it('adds a suffix when the slug is taken', () => {
    expect(ok(toolshed, 'add_node', { flowId: 'bookings', type: 'step', label: 'Pick dates' }).created.nodeId).toBe('pick-dates-2');
  });

  it('derives an id for start and end nodes without a label', () => {
    const expanded = ok(toolshed, 'expand_node', { id: 'join-waitlist' });
    const flowId = expanded.created.flowId ?? '';
    expect(ok(expanded.texts, 'add_node', { flowId, type: 'start' }).created.nodeId).toBe('join-waitlist-flow-start');
  });

  it('follows inline style where the user wrote nodes inline, quoting when needed', () => {
    const texts = {
      [MAP]: 'project: T\nfeatures:\n  - { id: shop, label: Shop }\n',
      'plan/features/shop.yaml':
        'feature: shop\nflows:\n  main:\n    label: Shop\n    nodes:\n      - { id: browse, type: step, label: Browse }\n',
    };
    const r = ok(texts, 'add_node', { flowId: 'shop', type: 'step', label: 'Pay, then confirm' });
    expect(r.texts['plan/features/shop.yaml']).toContain('- { id: pay-then-confirm, type: step, label: "Pay, then confirm" }');
  });

  it("creates the file on a listed feature's first node", () => {
    const r = ok(toolshed, 'add_node', { flowId: 'reminders', type: 'step', label: 'Send text' });
    expect(r.created).toEqual({ nodeId: 'send-text', file: 'plan/features/reminders.yaml' });
    expect(r.changed).toEqual(['plan/features/reminders.yaml']);
    expect(indexOf(r.texts).flows.get('reminders')?.flow.label).toBe('Reminders');
  });

  it('asks for the fields a node type needs', () => {
    expect(fails(toolshed, 'add_node', { flowId: 'bookings', type: 'step' }).message).toContain('needs a label');
    expect(fails(toolshed, 'add_node', { flowId: 'bookings', type: 'component', label: 'X' }).message).toContain('needs a kind');
    expect(fails(toolshed, 'add_node', { flowId: 'bookings', type: 'reference', label: 'X' }).message).toContain('needs ref');
  });

  it('renames without changing the id, and clears fields with null', () => {
    const r = ok(toolshed, 'update_node', { id: 'pick-dates', label: 'Choose dates', status: null });
    expect(nodeIn(r.texts, 'pick-dates')).toEqual({ id: 'pick-dates', type: 'step', label: 'Choose dates' });
  });

  it('tells the agent what to do about unknown flows and nodes', () => {
    const flow = fails(toolshed, 'add_node', { flowId: 'take-deposit', type: 'step', label: 'X' });
    expect(flow.code).toBe('not-found');
    expect(flow.message).toMatch(/no flow "take-deposit".*Known flows: .*take-deposit-flow/);
    const node = fails(toolshed, 'set_status', { id: 'pick-date', status: 'done' });
    expect(node.message).toMatch(/no node "pick-date".*Similar ids: .*pick-dates/);
  });

  it('refuses status on a node type that cannot have one', () => {
    const f = fails(toolshed, 'update_node', { id: 'tool-available', status: 'done' });
    expect(f.code).toBe('rejected');
    expect(f.message).toContain('status-not-allowed');
  });

  it('sets status, and refuses it on a node whose progress is computed', () => {
    expect(nodeIn(ok(toolshed, 'set_status', { id: 'join-waitlist', status: 'done' }).texts, 'join-waitlist')).toMatchObject({
      status: 'done',
    });
    const f = fails(toolshed, 'set_status', { id: 'place-booking', status: 'done' });
    expect(f.code).toBe('not-allowed');
    expect(f.message).toContain('computed');
    expect(fails(toolshed, 'update_node', { id: 'place-booking', status: 'done' }).code).toBe('not-allowed');
  });
});

describe('expanding and removing', () => {
  it('expands a node into a child flow in the same file and removes its stored status', () => {
    const r = ok(toolshed, 'expand_node', { id: 'join-waitlist', label: 'Waitlist' });
    expect(r.created).toEqual({ flowId: 'join-waitlist-flow' });
    const index = indexOf(r.texts);
    expect(index.flows.get('join-waitlist-flow')).toMatchObject({ parentNodeId: 'join-waitlist', flow: { label: 'Waitlist' } });
    expect(index.nodes.get('join-waitlist')?.node).toEqual({
      id: 'join-waitlist',
      type: 'step',
      label: 'Join the waitlist',
      expands: 'join-waitlist-flow',
    });
  });

  it("writes a new child flow's first node as a block list", () => {
    const r = ok(toolshed, 'expand_node', { id: 'join-waitlist' });
    const n = ok(r.texts, 'add_node', { flowId: 'join-waitlist-flow', type: 'step', label: 'Save position' });
    expect(n.texts[BOOKINGS]).toMatch(/join-waitlist-flow:\n {4}label: Join the waitlist\n {4}nodes:\n {6}- id: save-position\n/);
  });

  it('refuses to expand twice or to expand a decision', () => {
    expect(fails(toolshed, 'expand_node', { id: 'place-booking' }).code).toBe('not-allowed');
    expect(fails(toolshed, 'expand_node', { id: 'tool-available' }).code).toBe('not-allowed');
  });

  it('removes a node with its edges and child flows, and reports them', () => {
    const r = ok(toolshed, 'remove_node', { id: 'place-booking' });
    const index = indexOf(r.texts);
    expect(index.nodes.has('place-booking')).toBe(false);
    expect(index.flows.has('place-booking-flow')).toBe(false);
    expect(index.flows.has('take-deposit-flow')).toBe(false);
    expect(index.flows.get('bookings')?.flow.edges.some((e) => e.from === 'place-booking' || e.to === 'place-booking')).toBe(false);
    expect(r.warnings.join(' ')).toContain('place-booking-flow, take-deposit-flow');
  });

  it('refuses a removal whose child flow is referenced elsewhere, naming the node', () => {
    const texts = {
      ...toolshed,
      [HANDOVER]:
        `${toolshed[HANDOVER] ?? ''}      - id: see-deposit\n        type: reference\n        label: See deposit\n        ref: take-deposit-flow\n`.replace(
          /(\n {4}edges:[\s\S]*?)( {6}- id: see-deposit[\s\S]*)$/,
          (_m, edges: string, node: string) => `\n${node}${edges.slice(1)}`,
        ),
    };
    expect(errorsOf(validateProject(loadFromTexts(texts)))).toEqual([]);
    const f = fails(texts, 'remove_node', { id: 'take-deposit' });
    expect(f.code).toBe('rejected');
    expect(f.message).toContain('see-deposit');
  });
});

describe('edges', () => {
  it('adds, updates and removes an edge', () => {
    const a = ok(toolshed, 'add_edge', { flowId: 'bookings', from: 'join-waitlist', to: 'bookings-end', data: 'spot freed' });
    const b = ok(a.texts, 'update_edge', { flowId: 'bookings', from: 'join-waitlist', to: 'bookings-end', label: 'later', data: null });
    expect(
      indexOf(b.texts)
        .flows.get('bookings')
        ?.flow.edges.find((e) => e.from === 'join-waitlist' && e.to === 'bookings-end'),
    ).toEqual({
      from: 'join-waitlist',
      to: 'bookings-end',
      label: 'later',
    });
    const c = ok(b.texts, 'remove_edge', { flowId: 'bookings', from: 'join-waitlist', to: 'bookings-end' });
    expect(
      indexOf(c.texts)
        .flows.get('bookings')
        ?.flow.edges.some((e) => e.from === 'join-waitlist' && e.to === 'bookings-end'),
    ).toBe(false);
  });

  it('refuses duplicates, self-loops, unknown nodes and missing edges', () => {
    expect(fails(toolshed, 'add_edge', { flowId: 'bookings', from: 'browse-tools', to: 'pick-dates' }).message).toContain('duplicate-edge');
    expect(fails(toolshed, 'add_edge', { flowId: 'bookings', from: 'pick-dates', to: 'pick-dates' }).message).toContain('self-loop');
    expect(fails(toolshed, 'add_edge', { flowId: 'bookings', from: 'pick-dates', to: 'nope' }).message).toContain('edge-unknown-node');
    expect(fails(toolshed, 'remove_edge', { flowId: 'bookings', from: 'pick-dates', to: 'browse-tools' }).code).toBe('not-found');
  });

  it('passes on new validator warnings, like an unlabelled decision branch', () => {
    const r = ok(toolshed, 'add_edge', { flowId: 'bookings', from: 'tool-available', to: 'bookings-end' });
    expect(r.warnings.join(' ')).toContain('decision-edge-unlabeled');
  });
});

describe('broken plans and bad requests', () => {
  const brokenHandover = () => ({ ...toolshed, [HANDOVER]: 'feature: handover\nflows: [unclosed\n' });

  it('refuses an edit to a broken file, saying where the problem is', () => {
    const f = fails(brokenHandover(), 'add_node', { flowId: 'handover', type: 'step', label: 'X' });
    expect(f.code).toBe('file-invalid');
    expect(f.message).toContain(`fix ${HANDOVER} first`);
    expect(f.message).toMatch(/handover\.yaml:\d+/);
  });

  it('mentions an unreadable file when something might be inside it', () => {
    const f = fails(brokenHandover(), 'set_status', { id: 'late-checker', status: 'done' });
    expect(f.code).toBe('not-found');
    expect(f.message).toContain("can't be read");
    expect(f.message).toContain(HANDOVER);
  });

  it('still edits healthy files while another file is broken', () => {
    const result = applyOperation(brokenHandover(), { name: 'set_status', input: { id: 'join-waitlist', status: 'done' } });
    expect(result).toMatchObject({ ok: true, changed: [BOOKINGS] });
  });

  it('refuses overview edits while the map is broken', () => {
    const f = fails({ ...toolshed, [MAP]: 'project: [oops\n' }, 'add_feature', { label: 'X' });
    expect(f.code).toBe('file-invalid');
    expect(f.message).toContain(MAP);
  });

  it('can remove a feature whose file is broken', () => {
    const r = applyOperation(brokenHandover(), { name: 'remove_feature', input: { id: 'handover' } });
    expect(r).toMatchObject({ ok: true, deleted: [HANDOVER] });
  });

  it('explains a missing map', () => {
    expect(fails({}, 'add_feature', { label: 'X' }).message).toContain('plan/map.yaml');
  });

  it('returns failures for bad requests instead of throwing', () => {
    expect(fails(toolshed, 'delete_everything', {})).toMatchObject({ code: 'unknown-operation' });
    expect(fails(toolshed, 'delete_everything', {}).message).toContain('add_node');
    expect(fails(toolshed, 'add_node', { flowId: 'bookings' }).code).toBe('invalid-input');
    expect(fails(toolshed, 'add_node', 'not an object').code).toBe('invalid-input');
    expect(fails(toolshed, 'set_status', { id: 'pick-dates', status: 'finished' }).code).toBe('invalid-input');
    expect(fails(toolshed, 'update_node', { id: 'pick-dates', label: null }).code).toBe('invalid-input');
    expect(fails(toolshed, 'update_node', { id: 'pick-dates', colour: 'red' }).code).toBe('invalid-input');
    expect(fails(toolshed, 'update_node', { id: 'pick-dates' }).message).toContain('nothing to update');
  });

  it('never changes the texts it was given', () => {
    const copy = structuredClone(toolshed);
    applyOperation(toolshed, { name: 'remove_feature', input: { id: 'handover' } });
    applyOperation(toolshed, { name: 'add_node', input: { flowId: 'bookings', type: 'step', label: 'X' } });
    expect(toolshed).toEqual(copy);
  });

  it('returns plain data that survives a JSON round trip', () => {
    const r = ok(toolshed, 'add_node', { flowId: 'bookings', type: 'step', label: 'X' });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe('comments', () => {
  const commentLines = (text = '') =>
    text
      .split('\n')
      .filter((l) => l.trim().startsWith('#'))
      .map((l) => l.trim());

  it('keeps every comment and leaves untouched lines alone across mixed edits', () => {
    let texts = toolshed;
    texts = ok(texts, 'set_status', { id: 'join-waitlist', status: 'in_progress' }).texts;
    texts = ok(texts, 'add_node', { flowId: 'take-deposit-flow', type: 'step', label: 'Send receipt' }).texts;
    texts = ok(texts, 'expand_node', { id: 'pick-dates' }).texts;
    texts = ok(texts, 'update_node', { id: 'browse-tools', label: 'Browse nearby tools' }).texts;
    texts = ok(texts, 'connect_features', { from: 'catalogue', to: 'members', data: 'owner id' }).texts;
    for (const path of Object.keys(toolshed)) expect(commentLines(texts[path]), path).toEqual(commentLines(toolshed[path]));

    const before = (toolshed[BOOKINGS] ?? '').split('\n');
    const after = new Set((texts[BOOKINGS] ?? '').split('\n'));
    expect(before.filter((l) => after.has(l)).length / before.length).toBeGreaterThan(0.9);
  });

  it('keeps a comment written on a node when another field of it changes', () => {
    const texts = {
      ...toolshed,
      [HANDOVER]: (toolshed[HANDOVER] ?? '').replace('      - id: late-checker\n', '      # Runs at 2am.\n      - id: late-checker\n'),
    };
    const r = ok(texts, 'set_status', { id: 'late-checker', status: 'done' });
    expect(r.texts[HANDOVER]).toContain('# Runs at 2am.');
  });
});
