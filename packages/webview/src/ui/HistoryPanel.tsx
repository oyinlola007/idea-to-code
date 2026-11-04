// Every change to the plan, grouped by session, newest first, with a way back to any
// version. Each change is one row: what changed, then who and when.
import type { HistoryEntry, HistoryView } from '@idea-to-code/core';
import { useEffect, useRef, useState } from 'react';
import { whenText } from './time.js';

interface Props {
  history: HistoryView;
  /** A session to scroll to, e.g. from the chat. */
  focusSession: string | undefined;
  onRestore: (snapshotId: string) => void;
  onClose: () => void;
}

/** A restore says what it brought back; anything else says what changed. */
function what(entry: HistoryEntry): string {
  if (entry.source !== 'restore') return entry.summary;
  if (entry.undo === true) return 'Undid a change';
  return entry.restoredFromAt === undefined ? 'Restored an earlier version' : `Restored the version from ${whenText(entry.restoredFromAt)}`;
}

function Row({ entry, sessionTitle, onRestore }: { entry: HistoryEntry; sessionTitle: string; onRestore: () => void }) {
  const [confirming, setConfirming] = useState(false);
  // Who made it is already the session's title, unless this row is someone else's.
  const meta = entry.who === sessionTitle ? whenText(entry.at) : `${entry.who} · ${whenText(entry.at)}`;
  return (
    <li className="history__row">
      <div className="history__text">
        <p className="history__what">{what(entry)}</p>
        {confirming ? (
          <div className="history__line">
            <span>Go back to this version?</span>
            <button
              type="button"
              className="history__action history__action--strong"
              autoFocus
              onClick={() => {
                setConfirming(false);
                onRestore();
              }}
            >
              Restore
            </button>
            <button
              type="button"
              className="history__action"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="history__line">
            <span>{meta}</span>
            {!entry.current && (
              <button
                type="button"
                className="history__action history__restore"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Restore
              </button>
            )}
          </div>
        )}
      </div>
      {entry.current && (
        <span
          className="codicon codicon-check history__current"
          role="img"
          aria-label="The plan matches this version"
          title="The plan matches this version"
        />
      )}
    </li>
  );
}

export function HistoryPanel({ history, focusSession, onRestore, onClose }: Props) {
  const focused = useRef<HTMLElement>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'start' });
  }, [focusSession]);
  const newest = history.sessions[0]?.entries[0]?.id;

  // Show the result of a restore, which lands at the top. Other changes leave the list where it is.
  const panel = useRef<HTMLElement>(null);
  const restoring = useRef(false);
  useEffect(() => {
    if (!restoring.current) return;
    restoring.current = false;
    panel.current?.scrollTo({ top: 0 });
  }, [newest]);

  return (
    <aside ref={panel} className="details history" aria-label="History">
      <header className="history__header">
        <h2>History</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close history" title="Close (Esc)">
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      {history.problem !== undefined && <p className="history__note">{history.problem}</p>}
      {history.problem === undefined && history.sessions.length === 0 && <p className="history__note">No changes yet.</p>}
      {history.sessions.map((session) => (
        <section
          key={session.id}
          ref={session.id === focusSession ? focused : undefined}
          className={`history__group${session.id === focusSession ? ' history__group--focus' : ''}`}
          aria-label={session.title}
        >
          <h3>
            {session.title}
            <span> · {whenText(session.openedAt)}</span>
          </h3>
          <ol>
            {session.entries.map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                sessionTitle={session.title}
                onRestore={() => {
                  restoring.current = true;
                  onRestore(entry.id);
                }}
              />
            ))}
          </ol>
        </section>
      ))}
      {history.older > 0 && (
        <p className="history__note">
          {history.older} older {history.older === 1 ? 'change is' : 'changes are'} kept but not listed.
        </p>
      )}
    </aside>
  );
}
