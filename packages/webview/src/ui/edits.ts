// Which plan edit each action on a card means. Pure, so the mapping is tested
// without a browser: features, shared components and flow nodes use different operations.
import { OVERVIEW, type Level, type UiOperation, type VNode } from '@idea-to-code/core';

export interface Edit {
  name: UiOperation;
  input: unknown;
}

const isShared = (node: VNode, level: Level) => level.id === OVERVIEW && node.kind === 'component';

export function renameEdit(node: VNode, level: Level, label: string): Edit {
  if (node.kind === 'feature') return { name: 'update_feature', input: { id: node.id, label } };
  if (isShared(node, level)) return { name: 'update_component', input: { id: node.id, label } };
  return { name: 'update_node', input: { id: node.id, label } };
}

export function statusEdit(node: VNode, level: Level, status: NonNullable<VNode['status']>): Edit {
  if (isShared(node, level)) return { name: 'update_component', input: { id: node.id, status } };
  return { name: 'set_status', input: { id: node.id, status } };
}

export function removeEdit(node: VNode, level: Level): Edit {
  if (node.kind === 'feature') return { name: 'remove_feature', input: { id: node.id } };
  if (isShared(node, level)) return { name: 'remove_component', input: { id: node.id } };
  return { name: 'remove_node', input: { id: node.id } };
}

export function connectEdit(level: Level, from: string, to: string, label?: string): Edit {
  const branch = label === undefined ? {} : { label };
  if (level.id === OVERVIEW) return { name: 'connect_features', input: { from, to, ...branch } };
  return { name: 'add_edge', input: { flowId: level.id, from, to, ...branch } };
}

export function disconnectEdit(level: Level, from: string, to: string): Edit {
  if (level.id === OVERVIEW) return { name: 'disconnect_features', input: { from, to } };
  return { name: 'remove_edge', input: { flowId: level.id, from, to } };
}

/** Only steps and components without a child flow carry their own status. */
export function canSetStatus(node: VNode): boolean {
  return (node.kind === 'step' || node.kind === 'component') && node.opens === undefined;
}

/** Cards this one could flow into that it doesn't already. On the overview only features connect. */
export function connectTargets(node: VNode, level: Level): VNode[] {
  if (level.id === OVERVIEW && node.kind !== 'feature') return [];
  const linked = new Set(level.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to));
  return level.nodes.filter(
    (other) => other.id !== node.id && !linked.has(other.id) && (level.id !== OVERVIEW || other.kind === 'feature'),
  );
}
