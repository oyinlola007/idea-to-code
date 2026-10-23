// The committed fixture plan: it must stay valid and keep covering every part
// of the format (all node types, three levels, a system design, a loop).
import { beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '../src/load.js';
import { errorsOf, indexProject, validateProject } from '../src/validate.js';
import { loadFixture } from './helpers.js';

let project: Project;
beforeAll(async () => {
  project = await loadFixture('toolshed');
});

describe('Toolshed fixture', () => {
  it('has no errors and only the expected warnings', () => {
    const issues = validateProject(project);
    expect(errorsOf(issues)).toEqual([]);
    expect(issues.map((i) => `${i.code}@${i.line}`)).toEqual([
      'feature-without-flows@7',
      'feature-without-flows@10',
      'feature-without-flows@19',
    ]);
  });

  it('indexes every flow with its parent node', () => {
    const index = indexProject(project);
    expect([...index.flows.keys()].sort()).toEqual(['bookings', 'handover', 'place-booking-flow', 'take-deposit-flow']);
    expect(index.flows.get('place-booking-flow')?.parentNodeId).toBe('place-booking');
    expect(index.flows.get('take-deposit-flow')?.parentNodeId).toBe('take-deposit');
    expect(index.flows.get('bookings')?.parentNodeId).toBeUndefined();
  });

  it('uses every node type', () => {
    const types = new Set([...indexProject(project).nodes.values()].map((n) => n.node.type));
    expect([...types].sort()).toEqual(['component', 'decision', 'end', 'reference', 'start', 'step']);
  });

  it('allows a loop between features in the overview', () => {
    const connections = project.map?.data?.connections ?? [];
    const next = new Map(connections.map((c) => [c.from, c.to]));
    // members -> bookings -> handover -> members
    expect(next.get('members')).toBe('bookings');
    expect(connections.some((c) => c.from === 'bookings' && c.to === 'handover')).toBe(true);
    expect(next.get('handover')).toBe('members');
    expect(validateProject(project).some((i) => i.code === 'cycle')).toBe(false);
  });

  it('resolves references to a planned feature and to top-level components', () => {
    const index = indexProject(project);
    const refs = [...index.nodes.values()].flatMap((n) => (n.node.type === 'reference' ? [n.node.ref] : []));
    expect(refs.sort()).toEqual(['app-db', 'payments-api', 'reminders', 'sms-service']);
    expect(validateProject(project).some((i) => i.code === 'unknown-ref')).toBe(false);
  });
});
