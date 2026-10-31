// What each kind of card shows, rendered by the real components.
import type { VNode } from '@idea-to-code/core';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanNode, type PlanFlowNode } from '../src/chart/nodes.js';
import { Breadcrumb } from '../src/ui/Breadcrumb.js';
import { kindIcon, kindLabel } from '../src/chart/icons.js';
import { approxMeasure, nodeBox } from '../src/layout/metrics.js';
import { progressText } from '../src/ui/ProgressRing.js';

const source = { file: 'plan/features/bookings.yaml', line: 3 };

function card(node: VNode): string {
  const data = { node, box: nodeBox(node, approxMeasure), dimmed: false, arrived: false, onOpen: () => undefined };
  const props = { id: node.id, data, selected: false } as unknown as NodeProps<PlanFlowNode>;
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <PlanNode {...props} />
    </ReactFlowProvider>,
  );
}

describe('cards', () => {
  it('step: label and status, as a mark as well as words', () => {
    const html = card({ id: 'a', kind: 'step', label: 'Pick dates', status: 'done', source });
    expect(html).toContain('Pick dates');
    expect(html).toContain('status-mark--done');
    expect(html).toContain('Done');
    expect(html).toContain('card--done');
  });

  it('decision: a diamond before the label', () => {
    const html = card({ id: 'a', kind: 'decision', label: 'Tool available?', source });
    expect(html).toContain('decision-mark');
    expect(html).toContain('Tool available?');
  });

  it('start and end: pills, with or without a label', () => {
    expect(card({ id: 'a', kind: 'start', label: 'Start', source })).toContain('pill__dot--start');
    expect(card({ id: 'a', kind: 'end', label: 'Booked', source })).toContain('Booked');
  });

  it('component: icon, kind and tech', () => {
    const html = card({ id: 'a', kind: 'component', label: 'App database', componentKind: 'database', tech: 'Postgres', source });
    expect(html).toContain('codicon-database');
    expect(html).toContain('database');
    expect(html).toContain('Postgres');
  });

  it('expandable: stacked look, ring and count, an open button, and no status of its own', () => {
    const html = card({ id: 'a', kind: 'step', label: 'Place booking', opens: 'flow', progress: { done: 2, total: 5 }, source });
    expect(html).toContain('card--expandable');
    expect(html).toContain('ring');
    expect(html).toContain('2 of 5 done');
    expect(html).toContain('card__open');
    expect(html).not.toContain('status-mark');
  });

  it('feature: description, and planned features say so', () => {
    const html = card({
      id: 'a',
      kind: 'feature',
      label: 'Bookings',
      description: 'Pick a tool.',
      opens: 'a',
      progress: { done: 1, total: 2 },
      source,
    });
    expect(html).toContain('Pick a tool.');
    const planned = card({ id: 'b', kind: 'feature', label: 'Reminders', planned: true, source });
    expect(planned).toContain('card--planned');
    expect(planned).toContain('Not planned yet');
    expect(planned).not.toContain('card__open');
  });

  it('reference: says what it points at, and links when it can jump', () => {
    const linked = card({ id: 'a', kind: 'reference', label: 'Notify member', refLabel: 'Reminders', jumpsTo: 'reminders', source });
    expect(linked).toContain('meta__ref--link');
    expect(linked).toContain('Reminders');
    const shared = card({
      id: 'b',
      kind: 'reference',
      label: 'Payments API',
      refLabel: 'Payments API',
      componentKind: 'external-api',
      source,
    });
    expect(shared).toContain('Shared external api');
    expect(card({ id: 'c', kind: 'reference', label: 'Lost', source })).toContain('Unresolved reference');
  });
});

describe('breadcrumb', () => {
  const crumb = (id: string) => ({ id, title: `Title ${id}` });
  const render = (ids: string[]) => renderToStaticMarkup(<Breadcrumb crumbs={ids.map(crumb)} onGo={() => undefined} />);

  it('links every level above the current one, starting at the overview', () => {
    const html = render(['overview', 'a', 'b']);
    expect(html.match(/crumbs__link/g)).toHaveLength(2);
    expect(html).toContain('aria-current="page"');
    expect(html.indexOf('Title overview')).toBeLessThan(html.indexOf('Title a'));
    expect(html.indexOf('Title a')).toBeLessThan(html.indexOf('Title b'));
  });

  it('has no links on the overview itself', () => {
    expect(render(['overview'])).not.toContain('crumbs__link');
  });

  it('collapses the middle of a long path but keeps the overview reachable', () => {
    const html = render(['overview', 'a', 'b', 'c', 'd']);
    expect(html).toContain('…');
    expect(html).toContain('title="Title a › Title b"');
    expect(html).toContain('Title overview');
    expect(html).toContain('Title c');
    expect(html).toContain('Title d');
  });
});

describe('icons', () => {
  it('knows common kinds and falls back to a generic box', () => {
    expect(kindIcon('database')).toBe('database');
    expect(kindIcon('External-API')).toBe('globe');
    expect(kindIcon('flux-capacitor')).toBe('package');
    expect(kindIcon(undefined)).toBe('package');
    expect(kindLabel('external-api')).toBe('external api');
  });
});

describe('progressText', () => {
  it('reads naturally', () => {
    expect(progressText({ done: 0, total: 0 })).toBe('No steps yet');
    expect(progressText({ done: 2, total: 5 })).toBe('2 of 5 done');
    expect(progressText({ done: 5, total: 5 })).toBe('All 5 done');
  });
});
