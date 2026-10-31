// What a card can't show: the full description (where agents record their
// decisions), what flows in and out, and a way to the YAML.
import type { Level, VNode } from '@idea-to-code/core';
import { kindIcon, kindLabel } from '../chart/icons.js';
import { statusText } from '../status.js';
import { ProgressRing, progressText } from './ProgressRing.js';

const KIND_TEXT: Record<VNode['kind'], string> = {
  feature: 'Feature',
  start: 'Start',
  end: 'End',
  step: 'Step',
  decision: 'Decision',
  component: 'Component',
  reference: 'Reference',
};

export function DetailsPanel({
  node,
  level,
  onClose,
  onOpen,
  onSource,
}: {
  node: VNode;
  level: Level;
  onClose: () => void;
  onOpen: (n: VNode) => void;
  onSource: (n: VNode) => void;
}) {
  const label = (id: string) => level.nodes.find((n) => n.id === id)?.label ?? id;
  const incoming = level.edges.filter((e) => e.to === node.id);
  const outgoing = level.edges.filter((e) => e.from === node.id);
  const target = node.opens ?? node.jumpsTo;
  return (
    <aside className="details" aria-label={`Details for ${node.label}`}>
      <header className="details__header">
        <span className="details__kind">
          {node.kind === 'component' && <span className={`codicon codicon-${kindIcon(node.componentKind)}`} aria-hidden="true" />}
          {node.kind === 'component' ? kindLabel(node.componentKind) : KIND_TEXT[node.kind]}
        </span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details" title="Close (Esc)">
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      <h2 className="details__title">{node.label}</h2>
      <div className="details__facts">
        {node.progress && (
          <span className="fact">
            <ProgressRing progress={node.progress} />
            {progressText(node.progress)}
          </span>
        )}
        {node.status && (
          <span className="fact">
            <span className={`status-mark status-mark--${node.status}`} aria-hidden="true" />
            {statusText(node.status)}
          </span>
        )}
        {node.planned && <span className="fact fact--muted">Not planned yet</span>}
        {node.tech && <span className="chip chip--mono">{node.tech}</span>}
        {node.kind === 'reference' && <span className="fact">→ {node.refLabel ?? 'unresolved'}</span>}
      </div>
      {node.description ? (
        <p className="details__description">{node.description}</p>
      ) : (
        <p className="details__description details__description--empty">No description yet.</p>
      )}
      {(incoming.length > 0 || outgoing.length > 0) && (
        <section className="details__flows">
          {incoming.length > 0 && (
            <>
              <h3>Comes from</h3>
              <ul>
                {incoming.map((e) => (
                  <li key={e.id}>
                    <span className="flow-peer">{label(e.from)}</span>
                    {e.label && <span className="edge-label__branch">{e.label}</span>}
                    {e.data && <span className="flow-data">{e.data}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {outgoing.length > 0 && (
            <>
              <h3>Flows into</h3>
              <ul>
                {outgoing.map((e) => (
                  <li key={e.id}>
                    <span className="flow-peer">{label(e.to)}</span>
                    {e.label && <span className="edge-label__branch">{e.label}</span>}
                    {e.data && <span className="flow-data">{e.data}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <footer className="details__actions">
        {target && (
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              onOpen(node);
            }}
          >
            {node.opens ? 'Open flow' : `Go to ${node.refLabel}`}
            <span className="codicon codicon-chevron-right" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            onSource(node);
          }}
        >
          <span className="codicon codicon-go-to-file" aria-hidden="true" />
          Open in YAML
        </button>
      </footer>
    </aside>
  );
}
