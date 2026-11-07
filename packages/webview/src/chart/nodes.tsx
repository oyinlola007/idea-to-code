// One card per node kind. Each renders the lines that were measured for
// layout (NodeBox), so the box ELK placed is exactly the box drawn.
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { memo, type ReactNode } from 'react';
import type { Status, VNode } from '@idea-to-code/core';
import type { NodeBox } from '../layout/metrics.js';
import { ProgressRing, progressText } from '../ui/ProgressRing.js';
import { statusText } from '../status.js';
import { kindIcon, kindLabel } from './icons.js';

export interface PlanNodeData extends Record<string, unknown> {
  node: VNode;
  box: NodeBox;
  dimmed: boolean;
  /** Ringed for a moment: the card we came back to, or one the agent changed. */
  ring: 'arrived' | 'revealed' | null;
  onOpen: (node: VNode) => void;
}
export type PlanFlowNode = Node<PlanNodeData, 'plan'>;

function Codicon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`codicon codicon-${name} ${className}`} aria-hidden="true" />;
}

function StatusMark({ status }: { status: Status }) {
  // Shape as well as colour, so status never relies on colour alone.
  return <span className={`status-mark status-mark--${status}`} aria-hidden="true" />;
}

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="handle" />
    </>
  );
}

function OpenButton({ node, onOpen, label }: { node: VNode; onOpen: (n: VNode) => void; label: string }) {
  return (
    <button
      type="button"
      className="card__open nodrag"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(node);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
    >
      <Codicon name="chevron-right" />
    </button>
  );
}

function Lines({ lines, className }: { lines: string[]; className: string }) {
  return (
    <div className={className}>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

/** Linked to code: a quiet mark, in the warning colour when a link is broken. The panel holds the links. */
function CodeBadge({ code }: { code: NonNullable<VNode['code']> }) {
  const missing = code.filter((c) => c.missing === true).length;
  const label =
    missing > 0 ? `${String(missing)} of ${String(code.length)} code links broken` : `Linked to ${code.map((c) => c.path).join(', ')}`;
  return (
    <span className={`meta__code${missing > 0 ? ' meta__code--missing' : ''}`} title={label} aria-label={label} role="img">
      <Codicon name="code" />
    </span>
  );
}

function Meta({ node, onOpen }: { node: VNode; onOpen: (n: VNode) => void }) {
  let content: ReactNode = null;
  if (node.opens && node.progress) {
    content = (
      <>
        <ProgressRing progress={node.progress} />
        <span>{progressText(node.progress)}</span>
      </>
    );
  } else if (node.broken) {
    content = <span className="meta__broken">Can't be read</span>;
  } else if (node.planned) {
    content = <span className="meta__muted">Not planned yet</span>;
  } else if (node.kind === 'reference') {
    content = (
      <span className={`meta__ref${node.jumpsTo ? ' meta__ref--link' : ''}`}>
        <Codicon name={node.jumpsTo ? 'link' : node.componentKind ? kindIcon(node.componentKind) : 'link'} />
        {refText(node)}
      </span>
    );
  } else if (node.status) {
    content = (
      <>
        <StatusMark status={node.status} />
        <span>{statusText(node.status)}</span>
      </>
    );
  }
  const tech = node.kind !== 'reference' && node.tech ? <span className="chip chip--mono">{node.tech}</span> : null;
  // A card that opens a flow takes no code links (the steps inside do), so it never shows both marks.
  const code = node.code && node.code.length > 0 && node.opens === undefined ? <CodeBadge code={node.code} /> : null;
  const target = node.opens ?? node.jumpsTo;
  return (
    <div className="card__meta">
      <div className="meta__main">{content}</div>
      {tech}
      {code}
      {target && <OpenButton node={node} onOpen={onOpen} label={node.opens ? `Open “${node.label}”` : `Go to “${node.refLabel}”`} />}
    </div>
  );
}

/** What a reference points at; its target's name, unless the card already says it. */
function refText(node: VNode): string {
  if (!node.refLabel) return 'Unresolved reference';
  if (node.refLabel.toLowerCase() !== node.label.toLowerCase()) return node.refLabel;
  if (node.componentKind) return `Shared ${kindLabel(node.componentKind)}`;
  return node.jumpsTo ? 'Go to flow' : 'Planned feature';
}

/** The most serious problem on a card, if any. */
function worst(node: VNode): 'error' | 'warning' | undefined {
  return node.problems?.find((p) => p.severity === 'error')?.severity ?? node.problems?.[0]?.severity;
}

function ProblemBadge({ node }: { node: VNode }) {
  const severity = worst(node);
  if (!severity) return null;
  const messages = node.problems?.map((p) => p.message).join('\n') ?? '';
  return (
    <span
      className={`card__problem card__problem--${severity}`}
      title={messages}
      role="img"
      aria-label={severity === 'error' ? 'Has a problem' : 'Has a warning'}
    >
      <Codicon name={severity === 'error' ? 'error' : 'warning'} />
    </span>
  );
}

function cardClass(node: VNode, selected: boolean, data: PlanNodeData, extra = '') {
  return [
    'card',
    `card--${node.kind}`,
    node.opens ? 'card--expandable' : '',
    node.planned ? 'card--planned' : '',
    worst(node) ? `card--has-${worst(node) ?? ''}` : '',
    node.status ? `card--${node.status}` : '',
    selected ? 'is-selected' : '',
    data.dimmed ? 'is-dimmed' : '',
    data.ring ? `is-${data.ring}` : '',
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

export const PlanNode = memo(function PlanNode({ data, selected }: NodeProps<PlanFlowNode>) {
  const { node, box, onOpen } = data;
  const size = { width: box.width, height: box.height };

  if (node.kind === 'start' || node.kind === 'end') {
    return (
      <div className={cardClass(node, selected, data, 'pill')} style={size}>
        <Handles />
        <ProblemBadge node={node} />
        <span className={`pill__dot pill__dot--${node.kind}`} aria-hidden="true" />
        <span className="pill__label">{box.title[0]}</span>
      </div>
    );
  }

  return (
    <div className={cardClass(node, selected, data)} style={size}>
      <Handles />
      <ProblemBadge node={node} />
      {node.kind === 'component' && (
        <div className="card__kind">
          <Codicon name={kindIcon(node.componentKind)} />
          <span>{kindLabel(node.componentKind)}</span>
        </div>
      )}
      <div className="card__title-row">
        {node.kind === 'decision' && <span className="decision-mark" aria-hidden="true" />}
        <Lines lines={box.title} className={node.kind === 'feature' ? 'card__title card__title--feature' : 'card__title'} />
      </div>
      {box.body.length > 0 && <Lines lines={box.body} className="card__body" />}
      {box.hasMeta && <Meta node={node} onOpen={onOpen} />}
    </div>
  );
});

export const nodeTypes = { plan: PlanNode };
