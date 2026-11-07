// What each kind of card shows, rendered by the real components.
import type { Level, VNode } from '@idea-to-code/core';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanNode, type PlanFlowNode } from '../src/chart/nodes.js';
import { CrumbTrail } from '../src/ui/Breadcrumb.js';
import { crumbsToHide } from '../src/ui/crumbLayout.js';
import { kindIcon, kindLabel } from '../src/chart/icons.js';
import { approxMeasure, nodeBox } from '../src/layout/metrics.js';
import { progressText } from '../src/ui/ProgressRing.js';
import { ZoomButtons } from '../src/chart/ZoomControls.js';
import { DetailsPanel } from '../src/ui/DetailsPanel.js';

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

describe('problem marks', () => {
  it('marks a card with an error, with the message on hover', () => {
    const html = card({ id: 'a', kind: 'reference', label: 'Lost', problems: [{ severity: 'error', message: 'unknown ref' }], source });
    expect(html).toContain('card--has-error');
    expect(html).toContain('codicon-error');
    expect(html).toContain('title="unknown ref"');
  });

  it('shows the worse of several problems', () => {
    const html = card({
      id: 'a',
      kind: 'step',
      label: 'A',
      problems: [
        { severity: 'warning', message: 'w' },
        { severity: 'error', message: 'e' },
      ],
      source,
    });
    expect(html).toContain('card--has-error');
    expect(html).not.toContain('card--has-warning');
  });

  it('a warning looks different from an error', () => {
    const html = card({ id: 'a', kind: 'step', label: 'A', problems: [{ severity: 'warning', message: 'w' }], source });
    expect(html).toContain('card--has-warning');
    expect(html).toContain('codicon-warning');
  });

  it('says a broken feature can not be read, not that it is unplanned', () => {
    const html = card({ id: 'a', kind: 'feature', label: 'B', broken: true, problems: [{ severity: 'error', message: 'bad' }], source });
    expect(html).toContain('Can&#x27;t be read');
    expect(html).not.toContain('Not planned yet');
    expect(html).not.toContain('card__open');
  });

  it('leaves healthy cards unmarked', () => {
    const html = card({ id: 'a', kind: 'step', label: 'A', status: 'todo', source });
    expect(html).not.toContain('card--has-');
    expect(html).not.toContain('card__problem');
  });
});

describe('breadcrumb', () => {
  const crumb = (id: string) => ({ id, title: `Title ${id}` });
  const render = (ids: string[], hide = 0) =>
    renderToStaticMarkup(<CrumbTrail crumbs={ids.map(crumb)} hide={hide} onGo={() => undefined} />);

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

  it('shows every level however deep, while nothing needs hiding', () => {
    const html = render(['overview', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(html).not.toContain('crumbs__more');
    for (const id of ['overview', 'a', 'b', 'c', 'd', 'e', 'f']) expect(html).toContain(`Title ${id}`);
  });

  it('moves hidden levels behind a button, keeping the main map and the nearest levels', () => {
    const html = render(['overview', 'a', 'b', 'c', 'd'], 2);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-label="Show 2 more levels"');
    expect(html).toContain('title="Title a › Title b"');
    expect(html).toContain('>Title overview<');
    expect(html).toContain('>Title c<');
    expect(html).toContain('Title d</span>');
  });
});

describe('crumbsToHide', () => {
  it('hides nothing while the whole path fits, however deep', () => {
    expect(crumbsToHide([100, 100, 100, 100, 100, 100], 600, 30)).toBe(0);
    expect(crumbsToHide([], 100, 30)).toBe(0);
  });

  it('hides from just after the main map, only as many as needed, allowing for the menu button', () => {
    expect(crumbsToHide([100, 100, 100, 100, 100], 499, 30)).toBe(1);
    expect(crumbsToHide([100, 100, 100, 100, 100], 430, 30)).toBe(1);
    expect(crumbsToHide([100, 100, 100, 100, 100], 429, 30)).toBe(2);
  });

  it('counts each level by its real width', () => {
    expect(crumbsToHide([100, 20, 300, 100], 500, 30)).toBe(2);
  });

  it('always keeps the main map and the current level, however narrow', () => {
    expect(crumbsToHide([100, 100, 100, 100], 10, 30)).toBe(2);
    expect(crumbsToHide([100, 100], 10, 30)).toBe(0);
    expect(crumbsToHide([100], 10, 30)).toBe(0);
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

describe('zoom buttons', () => {
  const buttons = (zoom: number) =>
    renderToStaticMarkup(
      <ReactFlowProvider>
        <ZoomButtons zoom={zoom} onZoom={() => undefined} onFit={() => undefined} />
      </ReactFlowProvider>,
    );

  it('are labelled for screen readers and tooltips', () => {
    const html = buttons(1);
    for (const label of ['Zoom out', 'Zoom in', 'Fit']) expect(html).toContain(`title="${label}" aria-label="${label}"`);
    expect(html).not.toContain('disabled');
  });

  it('turn off zooming further at each limit, never Fit', () => {
    expect(buttons(0.25).match(/disabled/g)).toHaveLength(1);
    expect(buttons(0.25)).toMatch(/aria-label="Zoom out" disabled/);
    expect(buttons(2)).toMatch(/aria-label="Zoom in" disabled/);
  });
});

describe('code links', () => {
  const step = (code?: VNode['code']): VNode => ({
    id: 's',
    kind: 'step',
    label: 'Pick dates',
    status: 'done',
    source,
    ...(code ? { code } : {}),
  });

  it('marks a linked card quietly, and in the warning colour when a link is broken', () => {
    expect(card(step())).not.toContain('meta__code');
    const linked = card(step([{ path: 'src/dates.ts' }]));
    expect(linked).toContain('class="meta__code"');
    expect(linked).toContain('Linked to src/dates.ts');
    const broken = card(step([{ path: 'src/dates.ts' }, { path: 'src/gone.ts', missing: true }]));
    expect(broken).toContain('meta__code meta__code--missing');
    expect(broken).toContain('1 of 2 code links broken');
  });

  it('gives a linked card without a status a row for its badge', () => {
    const plain: VNode = { id: 's', kind: 'step', label: 'Pick dates', source };
    expect(nodeBox(plain, approxMeasure).hasMeta).toBe(false);
    expect(nodeBox({ ...plain, code: [{ path: 'src/a.ts' }] }, approxMeasure).hasMeta).toBe(true);
  });

  const level: Level = {
    id: 'bookings',
    title: 'Bookings',
    parent: 'overview',
    crumbs: [],
    depth: 1,
    nodes: [],
    edges: [],
    progress: { done: 0, total: 0 },
    source,
  };
  const panel = (node: VNode, canEdit: boolean) =>
    renderToStaticMarkup(
      <DetailsPanel
        node={node}
        level={{ ...level, nodes: [node] }}
        canEdit={canEdit}
        onEdit={() => Promise.resolve(true)}
        onFirstStep={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
        onSource={() => undefined}
        onOpenCode={() => undefined}
        onLinkCode={() => undefined}
      />,
    );

  it('lists the links in the details, each one opening, with unlink and link only when editing', () => {
    const node = step([{ path: 'src/dates.ts' }, { path: 'src/gone.ts', missing: true }]);
    const editing = panel(node, true);
    expect(editing).toContain('<h3>Code</h3>');
    expect(editing).toContain('title="Open src/dates.ts"');
    expect(editing).toContain('code-link code-link--missing');
    expect(editing).toContain('aria-label="Unlink src/gone.ts"');
    expect(editing).toContain('Link a file…');
    const viewing = panel(node, false);
    expect(viewing).not.toContain('Unlink');
    expect(viewing).not.toContain('Link a file');
  });

  it('never marks a card that opens a flow, and offers no linking there, while listing old links to remove', () => {
    const parent: VNode = { ...step([{ path: 'src/payments' }]), opens: 'pay-flow', progress: { done: 1, total: 3 } };
    expect(card(parent)).not.toContain('meta__code');
    const html = panel(parent, true);
    expect(html).not.toContain('Link a file');
    expect(html).toContain('aria-label="Unlink src/payments"');
    const unlinked: VNode = { id: 's', kind: 'step', label: 'Pick dates', source, opens: 'pay-flow', progress: { done: 1, total: 3 } };
    expect(panel(unlinked, true)).not.toContain('<h3>Code</h3>');
  });

  it('shows no Code section where it can’t apply, or when there is nothing to show', () => {
    expect(panel({ id: 'd', kind: 'decision', label: 'Free?', source }, true)).not.toContain('<h3>Code</h3>');
    expect(panel(step(), false)).not.toContain('<h3>Code</h3>');
    expect(panel(step(), true)).toContain('Link a file…');
  });
});

describe('room for the warning', () => {
  it('wraps a title with a problem short of the badge at its end', () => {
    const label = 'Record the deposit and email the receipt to the borrower straight away';
    const plain: VNode = { id: 's', kind: 'step', label, source };
    const flagged: VNode = { ...plain, problems: [{ severity: 'warning', message: 'x' }] };
    const widest = (n: VNode) => Math.max(...nodeBox(n, approxMeasure).title.map((line) => approxMeasure(line, 'label')));
    expect(widest(flagged)).toBeLessThanOrEqual(nodeBox(flagged, approxMeasure).width - 28 - 20);
    expect(widest(plain)).toBeGreaterThan(widest(flagged));
  });
});
