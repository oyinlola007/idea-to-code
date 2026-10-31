import { OVERVIEW, type Level, type VNode } from '@idea-to-code/core';
import { describe, expect, it } from 'vitest';
import { canSetStatus, connectEdit, connectTargets, disconnectEdit, removeEdit, renameEdit, statusEdit } from '../src/ui/edits.js';

const source = { file: 'f', line: 1 };
const feature: VNode = { id: 'a', kind: 'feature', label: 'A', source };
const other: VNode = { id: 'b', kind: 'feature', label: 'B', source };
const shared: VNode = { id: 'db', kind: 'component', label: 'DB', source };
const step: VNode = { id: 's', kind: 'step', label: 'S', source };
const next: VNode = { id: 'n', kind: 'step', label: 'N', source };
const parent: VNode = { id: 'p', kind: 'step', label: 'P', opens: 'x', source };

function level(id: string, nodes: VNode[], edges: Level['edges'] = []): Level {
  return { id, title: id, parent: null, crumbs: [], depth: 0, nodes, edges, progress: { done: 0, total: 0 }, source };
}
const overview = level(OVERVIEW, [feature, other, shared]);
const flow = level('flow', [step, next, parent]);

describe('which operation an action means', () => {
  it('renames by kind', () => {
    expect(renameEdit(feature, overview, 'X').name).toBe('update_feature');
    expect(renameEdit(shared, overview, 'X').name).toBe('update_component');
    expect(renameEdit(step, flow, 'X')).toEqual({ name: 'update_node', input: { id: 's', label: 'X' } });
    expect(renameEdit({ ...shared, id: 'local' }, flow, 'X').name).toBe('update_node');
  });

  it('sets status by kind', () => {
    expect(statusEdit(step, flow, 'done')).toEqual({ name: 'set_status', input: { id: 's', status: 'done' } });
    expect(statusEdit(shared, overview, 'done')).toEqual({ name: 'update_component', input: { id: 'db', status: 'done' } });
  });

  it('removes by kind', () => {
    expect(removeEdit(feature, overview).name).toBe('remove_feature');
    expect(removeEdit(shared, overview).name).toBe('remove_component');
    expect(removeEdit(step, flow).name).toBe('remove_node');
  });

  it('connects features on the overview and nodes in a flow', () => {
    expect(connectEdit(overview, 'a', 'b')).toEqual({ name: 'connect_features', input: { from: 'a', to: 'b' } });
    expect(connectEdit(flow, 's', 'n')).toEqual({ name: 'add_edge', input: { flowId: 'flow', from: 's', to: 'n' } });
    expect(connectEdit(flow, 's', 'n', 'yes')).toEqual({ name: 'add_edge', input: { flowId: 'flow', from: 's', to: 'n', label: 'yes' } });
    expect(disconnectEdit(overview, 'a', 'b').name).toBe('disconnect_features');
    expect(disconnectEdit(flow, 's', 'n')).toEqual({ name: 'remove_edge', input: { flowId: 'flow', from: 's', to: 'n' } });
  });
});

describe('what a card allows', () => {
  it('offers status only where it is stored', () => {
    expect(canSetStatus(step)).toBe(true);
    expect(canSetStatus(shared)).toBe(true);
    expect(canSetStatus(parent)).toBe(false);
    expect(canSetStatus(feature)).toBe(false);
    expect(canSetStatus({ ...step, kind: 'decision' })).toBe(false);
  });

  it('offers only cards it can still connect to', () => {
    expect(connectTargets(feature, overview).map((n) => n.id)).toEqual(['b']);
    expect(connectTargets(shared, overview)).toEqual([]);
    const linked = level('flow', [step, next, parent], [{ id: 'e', from: 's', to: 'n' }]);
    expect(connectTargets(step, linked).map((n) => n.id)).toEqual(['p']);
  });
});

describe('what Connect to offers', () => {
  const start: VNode = { id: 'start', kind: 'start', label: 'Start', source };
  const end: VNode = { id: 'end', kind: 'end', label: 'End', source };
  const withEnds = level('flow', [start, step, end]);

  it('never leads back into a start', () => {
    expect(connectTargets(step, withEnds).map((n) => n.id)).toEqual(['end']);
  });

  it('offers nothing from an end', () => {
    expect(connectTargets(end, withEnds)).toEqual([]);
  });

  it('lets a start lead into the rest', () => {
    expect(connectTargets(start, withEnds).map((n) => n.id)).toEqual(['s', 'end']);
  });
});
