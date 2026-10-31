// Every change to the plan, by who, grouped by session, with a way back to any of them.
import type { HistoryEntry, HistoryView } from '@idea-to-code/core';
import { useEffect, useRef, useState } from 'react';
import { whenText } from './time.js';

interface Props {
  history: HistoryView;
  /** A session to scroll to, when opened from the sidebar. */
  focusSession: string | undefined;
  onRestore: (snapshotId: string) => void;
  onClose: () => void;
}

function restoreHeading(entry: HistoryEntry): string | null {
  if (entry.source !== 'restore') return null;
  if (entry.undo === true) return 'Undid a change';
  return entry.restoredFromAt === undefined ? 'Restored an earlier version' : `Restored the version from ${whenText(entry.restoredFromAt)}`;
}

function Entry({ entry, latest, onRestore }: { entry: HistoryEntry; latest: boolean; onRestore: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const heading = restoreHeading(entry);
  return (
    <li className="history__entry">
      {heading !== null && <p className="history__restored">{heading}</p>}
      <p className="history__what">{entry.summary}</p>
      <div className="history__meta">
        <span>
          {entry.who} · {whenText(entry.at)}
        </span>
        {latest && <span className="history__now">Latest</span>}
        {!entry.current && !confirming && (
          <button
            type="button"
            className="history__restore"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Restore to this point
          </button>
        )}
      </div>
      {confirming && (
        <div className="history__confirm">
          <p>The plan goes back to how it was here. Later changes stay in history, so you can undo this.</p>
          <div>
            <button
              type="button"
              className="button button--primary"
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
              className="button button--secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
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
      <header className="details__header">
        <span className="details__kind">
          <span className="codicon codicon-history" aria-hidden="true" />
          History
        </span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close history" title="Close (Esc)">
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      {history.problem !== undefined && <p className="history__note">{history.problem}</p>}
      {history.problem === undefined && history.sessions.length === 0 && (
        <p className="history__note">No changes yet. They appear here as the plan changes.</p>
      )}
      {history.sessions.map((session) => (
        <section
          key={session.id}
          ref={session.id === focusSession ? focused : undefined}
          className={`history__session${session.id === focusSession ? ' history__session--focus' : ''}`}
        >
          <h3>
            <span>{session.title}</span>
            <span className="history__opened">{whenText(session.openedAt)}</span>
          </h3>
          <ol>
            {session.entries.map((entry) => (
              <Entry
                key={entry.id}
                entry={entry}
                latest={entry.id === newest}
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
