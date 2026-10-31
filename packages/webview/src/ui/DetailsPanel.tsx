// What a card can't show: the full description (where agents record their
// decisions), what flows in and out, a way to the YAML, and the simple edits.
import type { Level, VEdge, VNode } from '@idea-to-code/core';
import { useState } from 'react';
import { kindIcon, kindLabel } from '../chart/icons.js';
import { statusText } from '../status.js';
import { canSetStatus, connectEdit, connectTargets, disconnectEdit, removeEdit, renameEdit, statusEdit, type Edit } from './edits.js';
import { ProgressRing, progressText } from './ProgressRing.js';
import { TextForm } from './TextForm.js';

const KIND_TEXT: Record<VNode['kind'], string> = {
  feature: 'Feature',
  start: 'Start',
  end: 'End',
  step: 'Step',
  decision: 'Decision',
  component: 'Component',
  reference: 'Reference',
};

const STATUSES = ['todo', 'in_progress', 'done'] as const;

interface Props {
  node: VNode;
  level: Level;
  /** False in Restricted Mode. */
  canEdit: boolean;
  onEdit: (edit: Edit) => Promise<boolean>;
  onFirstStep: (node: VNode, label: string) => void;
  onClose: () => void;
  onOpen: (node: VNode) => void;
  onSource: (node: VNode) => void;
}

function EdgeRow({ peer, edge, onRemove }: { peer: string; edge: VEdge; onRemove?: (() => void) | undefined }) {
  return (
    <li>
      <span className="flow-peer">{peer}</span>
      {edge.label !== undefined && <span className="edge-label__branch">{edge.label}</span>}
      {edge.data !== undefined && <span className="flow-data">{edge.data}</span>}
      {onRemove && (
        <button
          type="button"
          className="icon-button flow-remove"
          onClick={onRemove}
          title={`Remove this connection`}
          aria-label={`Remove the connection with ${peer}`}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

export function DetailsPanel({ node, level, canEdit, onEdit, onFirstStep, onClose, onOpen, onSource }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [addingStep, setAddingStep] = useState(false);
  // Edges leaving a decision need a branch label, so picking a target asks for one.
  const [branchTo, setBranchTo] = useState<string | null>(null);
  const label = (id: string) => level.nodes.find((n) => n.id === id)?.label ?? id;
  const incoming = level.edges.filter((e) => e.to === node.id);
  const outgoing = level.edges.filter((e) => e.from === node.id);
  const target = node.opens ?? node.jumpsTo;
  const targets = canEdit ? connectTargets(node, level) : [];
  const disconnect = (from: string, to: string) =>
    canEdit
      ? () => {
          void onEdit(disconnectEdit(level, from, to));
        }
      : undefined;

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

      {renaming ? (
        <TextForm
          label="New name"
          initial={node.label}
          className="details__title-input"
          onSave={(text) => {
            setRenaming(false);
            void onEdit(renameEdit(node, level, text));
          }}
          onCancel={() => {
            setRenaming(false);
          }}
        />
      ) : canEdit ? (
        <h2 className="details__title">
          <button
            type="button"
            className="details__rename"
            title="Rename"
            onClick={() => {
              setRenaming(true);
            }}
          >
            {node.label}
            <span className="codicon codicon-edit" aria-hidden="true" />
          </button>
        </h2>
      ) : (
        <h2 className="details__title">{node.label}</h2>
      )}

      <div className="details__facts">
        {node.progress && (
          <span className="fact">
            <ProgressRing progress={node.progress} />
            {progressText(node.progress)}
          </span>
        )}
        {node.status && !canEdit && (
          <span className="fact">
            <span className={`status-mark status-mark--${node.status}`} aria-hidden="true" />
            {statusText(node.status)}
          </span>
        )}
        {node.planned && <span className="fact fact--muted">Not planned yet</span>}
        {node.broken && <span className="fact meta__broken">Can't be read</span>}
        {node.tech !== undefined && <span className="chip chip--mono">{node.tech}</span>}
        {node.kind === 'reference' && <span className="fact">→ {node.refLabel ?? 'unresolved'}</span>}
      </div>

      {canEdit && canSetStatus(node) && (
        <div className="status-choice" role="group" aria-label="Status">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className="status-choice__option"
              aria-pressed={(node.status ?? 'todo') === status}
              onClick={() => {
                if ((node.status ?? 'todo') !== status) void onEdit(statusEdit(node, level, status));
              }}
            >
              <span className={`status-mark status-mark--${status}`} aria-hidden="true" />
              {statusText(status)}
            </button>
          ))}
        </div>
      )}

      {node.problems && (
        <ul className="details__problems">
          {node.problems.map((problem) => (
            <li key={`${problem.severity}:${problem.message}`} className={`details__problem details__problem--${problem.severity}`}>
              <span className={`codicon codicon-${problem.severity}`} aria-hidden="true" />
              <span>{problem.message}</span>
            </li>
          ))}
        </ul>
      )}

      {node.description !== undefined ? (
        <p className="details__description">{node.description}</p>
      ) : (
        <p className="details__description details__description--empty">No description yet.</p>
      )}

      {(incoming.length > 0 || outgoing.length > 0 || targets.length > 0) && (
        <section className="details__flows">
          {incoming.length > 0 && (
            <>
              <h3>Comes from</h3>
              <ul>
                {incoming.map((edge) => (
                  <EdgeRow key={edge.id} peer={label(edge.from)} edge={edge} onRemove={disconnect(edge.from, edge.to)} />
                ))}
              </ul>
            </>
          )}
          {(outgoing.length > 0 || targets.length > 0) && <h3>Flows into</h3>}
          {outgoing.length > 0 && (
            <ul>
              {outgoing.map((edge) => (
                <EdgeRow key={edge.id} peer={label(edge.to)} edge={edge} onRemove={disconnect(edge.from, edge.to)} />
              ))}
            </ul>
          )}
          {branchTo !== null ? (
            <TextForm
              label={`Branch label towards ${label(branchTo)}`}
              placeholder={`Label towards ${label(branchTo)}, like “yes”`}
              className="details__branch"
              onSave={(text) => {
                setBranchTo(null);
                void onEdit(connectEdit(level, node.id, branchTo, text));
              }}
              onCancel={() => {
                setBranchTo(null);
              }}
            />
          ) : (
            targets.length > 0 && (
              <select
                className="details__connect"
                aria-label="Connect to"
                value=""
                onChange={(event) => {
                  const to = event.target.value;
                  if (to === '') return;
                  if (node.kind === 'decision') setBranchTo(to);
                  else void onEdit(connectEdit(level, node.id, to));
                }}
              >
                <option value="">Connect to…</option>
                {targets.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.label}
                  </option>
                ))}
              </select>
            )
          )}
        </section>
      )}

      {canEdit &&
        node.planned &&
        (addingStep ? (
          <TextForm
            label="First step"
            placeholder="First step…"
            onSave={(text) => {
              setAddingStep(false);
              onFirstStep(node, text);
            }}
            onCancel={() => {
              setAddingStep(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="button button--secondary details__first-step"
            onClick={() => {
              setAddingStep(true);
            }}
          >
            <span className="codicon codicon-add" aria-hidden="true" />
            Add first step
          </button>
        ))}

      <footer className="details__actions">
        {target !== undefined && (
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              onOpen(node);
            }}
          >
            {node.opens !== undefined ? 'Open flow' : `Go to ${node.refLabel ?? 'target'}`}
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
        {canEdit &&
          (confirming ? (
            <button
              type="button"
              className="button button--danger"
              onBlur={() => {
                setConfirming(false);
              }}
              autoFocus
              onClick={() => {
                setConfirming(false);
                void onEdit(removeEdit(node, level));
              }}
            >
              {node.opens !== undefined || node.kind === 'feature' ? 'Delete, with everything inside' : 'Really delete'}
            </button>
          ) : (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setConfirming(true);
              }}
            >
              <span className="codicon codicon-trash" aria-hidden="true" />
              Delete
            </button>
          ))}
      </footer>
    </aside>
  );
}
