// The plan viewer: a toolbar, the chart for the current level, the details panel
// and the problems banner. Moving around stays simple here; ITC-12 adds history,
// the breadcrumb and transitions. The host only supplies the model.
import { OVERVIEW, type AppState, type EditResult, type HistoryView, type Level, type ViewModel, type VNode } from '@idea-to-code/core';
import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { finishEdit, loadSaved, log, onHostMessage, save, send, sendEdit, sendRestore, sendUndo } from './bridge.js';
import { Chart, type ChartHandle, type Entry, type RenderInfo } from './chart/Chart.js';
import { createLayouter, type Layouter } from './layout/elkClient.js';
import { canvasMeasure } from './layout/measure.js';
import { approxMeasure, type Measure } from './layout/metrics.js';
import { canBack, canForward, currentLevel, initialNav, navReducer, restoreNav, type NavAction, type NavState } from './nav.js';
import './theme.css';
import { Breadcrumb } from './ui/Breadcrumb.js';
import { DetailsPanel } from './ui/DetailsPanel.js';
import type { Edit } from './ui/edits.js';
import { HistoryPanel } from './ui/HistoryPanel.js';
import { TextForm } from './ui/TextForm.js';
import { ProgressRing, progressText } from './ui/ProgressRing.js';

function NoPlan({ trusted }: { trusted: boolean }) {
  return (
    <div className="state">
      <span className="codicon codicon-type-hierarchy" aria-hidden="true" />
      <p>No plan in this workspace yet.</p>
      {trusted ? (
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            send({ type: 'init-plan' });
          }}
        >
          Initialize plan
        </button>
      ) : (
        <p>Trust this folder to create a plan. Restricted Mode is view-only.</p>
      )}
    </div>
  );
}

function Problems({ model }: { model: ViewModel }) {
  const [open, setOpen] = useState(false);
  const errors = model.issues;
  if (errors.length === 0) return null;
  return (
    <div className={`issues${open ? ' issues--open' : ''}`} role="status">
      <button
        type="button"
        className="issues__summary"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        <span
          className={`codicon codicon-${errors.some((issue) => issue.severity === 'error') ? 'error' : 'warning'}`}
          aria-hidden="true"
        />
        {errors.length === 1 ? '1 problem in the plan files' : `${String(errors.length)} problems in the plan files`}. The rest of the plan
        still shows.
        <span className={`codicon codicon-chevron-${open ? 'up' : 'down'}`} aria-hidden="true" />
      </button>
      {open && (
        <ul>
          {errors.map((issue) => (
            <li key={`${issue.file}:${String(issue.line)}:${issue.code}:${issue.message}`}>
              <button
                type="button"
                className="issues__item"
                onClick={() => {
                  send({ type: 'open-source', file: issue.file, line: Math.max(issue.line, 1) });
                }}
              >
                <span className={`codicon codicon-${issue.severity}`} aria-hidden="true" />
                <span className="issues__where">
                  {issue.file.replace(/^plan\//, '')}:{issue.line}
                </span>
                {issue.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ToolbarProps {
  level: Level;
  nav: NavState;
  canEdit: boolean;
  onHistory: (dir: 'back' | 'forward') => void;
  onGo: (level: string) => void;
  onAdd: (type: 'feature' | 'step' | 'decision', label: string) => void;
  history: HistoryView | null;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onUndo: () => void;
}

/** Adds a feature on the overview, or a step or decision inside a flow. */
function AddButton({ level, onAdd }: { level: Level; onAdd: ToolbarProps['onAdd'] }) {
  const [adding, setAdding] = useState<'feature' | 'step' | 'decision' | 'choose' | null>(null);
  const isOverview = level.id === OVERVIEW;
  if (adding === null) {
    return (
      <button
        type="button"
        className="icon-button"
        title={isOverview ? 'Add a feature' : 'Add a step or decision'}
        aria-label={isOverview ? 'Add a feature' : 'Add a step or decision'}
        onClick={() => {
          setAdding(isOverview ? 'feature' : 'choose');
        }}
      >
        <span className="codicon codicon-add" aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className="add-form">
      {adding === 'choose' ? (
        <div className="add-form__choice" role="group" aria-label="What to add">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setAdding('step');
            }}
          >
            Step
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setAdding('decision');
            }}
          >
            Decision
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel"
            onClick={() => {
              setAdding(null);
            }}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <TextForm
          label={`Name of the new ${adding}`}
          placeholder={adding === 'feature' ? 'New feature…' : adding === 'step' ? 'New step…' : 'New decision…'}
          onSave={(text) => {
            setAdding(null);
            onAdd(adding, text);
          }}
          onCancel={() => {
            setAdding(null);
          }}
        />
      )}
    </div>
  );
}

function Toolbar({ level, nav, canEdit, onHistory, onGo, onAdd, history, historyOpen, onToggleHistory, onUndo }: ToolbarProps) {
  const { done, total } = level.progress;
  return (
    <header className="toolbar">
      <div className="toolbar__history">
        <button
          type="button"
          className="icon-button"
          disabled={!canBack(nav)}
          onClick={() => {
            onHistory('back');
          }}
          title="Back (Alt+←)"
          aria-label="Back"
        >
          <span className="codicon codicon-arrow-left" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={!canForward(nav)}
          onClick={() => {
            onHistory('forward');
          }}
          title="Forward (Alt+→)"
          aria-label="Forward"
        >
          <span className="codicon codicon-arrow-right" aria-hidden="true" />
        </button>
      </div>
      <Breadcrumb key={level.id} crumbs={level.crumbs} onGo={onGo} />
      <div className="toolbar__meta">
        {canEdit && <AddButton key={level.id} level={level} onAdd={onAdd} />}
        {history && (
          <>
            <button
              type="button"
              className="icon-button"
              disabled={history.undo === null}
              title={history.undo === null ? 'Nothing to undo' : `Undo: ${history.undo.summary} (${history.undo.who})`}
              aria-label="Undo"
              onClick={onUndo}
            >
              <span className="codicon codicon-discard" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              title="History"
              aria-label="History"
              aria-pressed={historyOpen}
              onClick={onToggleHistory}
            >
              <span className="codicon codicon-history" aria-hidden="true" />
            </button>
          </>
        )}
        {level.depth > 0 && (
          <span className="depth" title={`${String(level.depth)} level${level.depth > 1 ? 's' : ''} below the overview`}>
            Level {level.depth}
          </span>
        )}
        <span className="toolbar__progress" title={progressText(level.progress)}>
          <ProgressRing progress={level.progress} size={14} />
          {total > 0 ? `${String(done)}/${String(total)}` : '—'}
        </span>
      </div>
    </header>
  );
}

function emptyText(model: ViewModel, level: Level, canEdit: boolean): string {
  if (level.id !== OVERVIEW) return canEdit ? 'This flow has no steps yet. Use + to add one.' : 'This flow has no steps yet.';
  if (model.issues.some((issue) => issue.file === 'plan/map.yaml' && issue.severity === 'error'))
    return "plan/map.yaml can't be read. Fix the problem above to see the plan.";
  return canEdit ? 'No features yet. Use + to add one, or ask your coding agent to plan the first.' : 'No features yet.';
}

function firstMeasure(): Measure {
  try {
    return canvasMeasure();
  } catch {
    return approxMeasure;
  }
}

interface ViewerProps {
  trusted: boolean;
  /** The built-in agent is working: edits wait, navigation doesn't. */
  agentBusy: boolean;
  model: ViewModel;
  version: number;
  nav: NavState;
  entry: Entry;
  onNav: (nav: (state: NavState) => NavState, entry?: Entry) => void;
  /** The newest plan, which an edit's answer can reach before this has rendered it. */
  latestModel: () => ViewModel | null;
  history: HistoryView | null;
  historyPanel: HistoryRequest | null;
  onHistoryPanel: (panel: HistoryRequest | null) => void;
}

function Viewer({
  trusted,
  agentBusy,
  model,
  version,
  nav,
  entry,
  onNav,
  latestModel,
  history: planHistory,
  historyPanel,
  onHistoryPanel,
}: ViewerProps) {
  const [layouter, setLayouter] = useState<Layouter | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [measure] = useState<Measure>(firstMeasure);
  const chart = useRef<ChartHandle>(null);
  const busy = useRef(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    createLayouter((mode, error) => {
      log('warn', `ELK ${mode} mode failed: ${error}`);
    })
      .then(setLayouter)
      .catch((err: unknown) => {
        setFatal(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const dispatch = useCallback(
    (action: NavAction, nextEntry?: Entry) => {
      onNav((state) => navReducer(latestModel() ?? model)(state, action), nextEntry);
    },
    [model, latestModel, onNav],
  );

  const levelId = currentLevel(nav);
  const level = model.levels[levelId] ?? model.levels[OVERVIEW];
  const selectedNode = level?.nodes.find((node) => node.id === nav.selected) ?? null;
  const parent = level?.parent ?? null;

  const report = useCallback(async (pending: Promise<EditResult>) => {
    setEditError(null);
    const result = await pending;
    if (!result.ok) setEditError(result.message ?? "That change couldn't be made.");
    return result;
  }, []);

  const runEdit = useCallback((edit: Edit) => report(sendEdit(edit.name, edit.input)), [report]);

  const undoing = useRef(false);
  const undo = useCallback(async () => {
    // A second press before the first lands would be refused as "the plan just changed".
    if (planHistory?.undo == null || undoing.current) return;
    undoing.current = true;
    try {
      await report(sendUndo(planHistory.undo.latest));
    } finally {
      undoing.current = false;
    }
  }, [planHistory, report]);

  const onEdit = useCallback(async (edit: Edit) => (await runEdit(edit)).ok, [runEdit]);

  /** Plays a leaving animation once, ignoring clicks while it runs. */
  const whileLeaving = useCallback(async (kind: 'in' | 'out', nodeId?: string) => {
    if (busy.current) return false;
    busy.current = true;
    try {
      await chart.current?.leave(kind, nodeId);
    } finally {
      busy.current = false;
    }
    return true;
  }, []);

  const open = useCallback(
    async (node: VNode) => {
      const target = node.opens ?? node.jumpsTo;
      // Already there: nothing would bring back a chart that faded out.
      if (target === undefined || target === levelId || !(await whileLeaving('in', node.id))) return;
      dispatch({ type: 'open', level: target }, { kind: 'in' });
    },
    [dispatch, levelId, whileLeaving],
  );

  /** The card in `above` that leads to `below`, when it's exactly one level up. */
  const cardLeadingTo = useCallback(
    (above: string, below: string): string | undefined => {
      if (model.levels[below]?.parent !== above) return undefined;
      return model.levels[above]?.nodes.find((node) => node.opens === below || node.jumpsTo === below)?.id;
    },
    [model],
  );

  /** Goes out to any level above. One level up centres the card we came from; bigger jumps start at the top. */
  const goOut = useCallback(
    async (target: string) => {
      const focus = cardLeadingTo(target, levelId);
      if (!(await whileLeaving('out'))) return;
      dispatch({ type: 'open', level: target }, { kind: 'out', ...(focus === undefined ? {} : { focus }) });
    },
    [cardLeadingTo, levelId, dispatch, whileLeaving],
  );

  const history = useCallback(
    async (dir: 'back' | 'forward') => {
      const target = nav.history[nav.cursor + (dir === 'back' ? -1 : 1)];
      if (target === undefined) return;
      // Back to the level directly above behaves like going up: centre the card we left.
      const focus = dir === 'back' ? cardLeadingTo(target, levelId) : undefined;
      if (focus === undefined) {
        dispatch({ type: dir }, { kind: 'fade' });
      } else if (await whileLeaving('out')) {
        dispatch({ type: dir }, { kind: 'out', focus });
      }
    },
    [nav, cardLeadingTo, levelId, dispatch, whileLeaving],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Typing in a form or choosing from a list isn't navigating.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === 'z') {
        event.preventDefault();
        void undo();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (historyPanel) onHistoryPanel(null);
        else if (nav.details || nav.selected !== null) dispatch({ type: 'escape' });
        else if (parent !== null) void goOut(parent);
      } else if (event.key === 'Enter' && selectedNode && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        void open(selectedNode);
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        void history('back');
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        void history('forward');
      } else if (event.key === 'Backspace' && parent !== null) {
        event.preventDefault();
        void goOut(parent);
      }
    };
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3) void history('back');
      if (event.button === 4) void history('forward');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [nav, parent, selectedNode, dispatch, goOut, open, history, undo, historyPanel, onHistoryPanel]);

  const onRendered = useCallback(
    (info: RenderInfo) => {
      if (layouter) send({ type: 'chart-rendered', ...info, workerMode: layouter.mode });
    },
    [layouter],
  );
  const onError = useCallback((message: string) => {
    log('error', message);
  }, []);
  const onSelect = useCallback(
    (id: string | null) => {
      // A card's details share their spot with the other panels; clicking a card asks for the details.
      // The background closes the details first and keeps the card highlighted, as their close button does.
      if (id === null) {
        dispatch({ type: 'clickAway' });
        return;
      }
      onHistoryPanel(null);
      dispatch({ type: 'select', id });
    },
    [dispatch, onHistoryPanel],
  );
  const onOpen = useCallback(
    (node: VNode) => {
      void open(node);
    },
    [open],
  );

  const onAdd = useCallback(
    async (type: 'feature' | 'step' | 'decision', label: string) => {
      if (type === 'feature') {
        await runEdit({ name: 'add_feature', input: { label } });
        return;
      }
      // Added with a card selected, it comes after that card. A decision's branches need a label, so those are connected by hand.
      const after = selectedNode?.kind === 'decision' ? undefined : selectedNode?.id;
      const result = await runEdit({ name: 'add_node', input: { flowId: levelId, type, label } });
      const created = result.created?.nodeId;
      if (result.ok && after !== undefined && created !== undefined)
        await runEdit({ name: 'add_edge', input: { flowId: levelId, from: after, to: created } });
    },
    [levelId, runEdit, selectedNode],
  );

  const onFirstStep = useCallback(
    async (node: VNode, label: string) => {
      const result = await runEdit({ name: 'fill_flow', input: { flowId: node.id, nodes: [{ key: 'first', type: 'step', label }] } });
      if (result.ok) dispatch({ type: 'open', level: node.id }, { kind: 'in' });
    },
    [dispatch, runEdit],
  );

  if (fatal !== null) {
    return (
      <div className="state state--error">
        <span className="codicon codicon-error" aria-hidden="true" />
        <p>The chart couldn't start: {fatal}</p>
      </div>
    );
  }
  if (!level || !layouter) {
    return (
      <div className="state" aria-busy="true">
        <span className="state__spinner" aria-hidden="true" />
        <p>Loading plan…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar
        level={level}
        nav={nav}
        canEdit={trusted && !agentBusy}
        history={planHistory}
        historyOpen={historyPanel !== null}
        onToggleHistory={() => {
          onHistoryPanel(historyPanel ? null : {});
        }}
        onUndo={() => {
          void undo();
        }}
        onAdd={(type, label) => {
          void onAdd(type, label);
        }}
        onHistory={(dir) => {
          void history(dir);
        }}
        onGo={(target) => {
          void goOut(target);
        }}
      />
      {!trusted && (
        <p className="level-description">
          Restricted Mode: view-only, and no history is recorded. Trust this folder to turn everything on.
        </p>
      )}
      {level.description !== undefined && <p className="level-description">{level.description}</p>}
      <Problems model={model} />
      {editError !== null && (
        <div className="edit-error" role="alert">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{editError}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss"
            onClick={() => {
              setEditError(null);
            }}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      )}
      <main className="stage">
        <Chart
          ref={chart}
          level={level}
          version={version}
          layouter={layouter}
          measure={measure}
          selected={selectedNode?.id ?? null}
          panelOpen={nav.details || historyPanel !== null}
          emptyText={emptyText(model, level, trusted)}
          entry={entry}
          onSelect={onSelect}
          onOpen={onOpen}
          onRendered={onRendered}
          onError={onError}
        />
        {historyPanel && planHistory && (
          <HistoryPanel
            history={planHistory}
            focusSession={historyPanel.session}
            onRestore={(snapshotId) => {
              void report(sendRestore(snapshotId));
            }}
            onClose={() => {
              onHistoryPanel(null);
            }}
          />
        )}
        {!historyPanel && nav.details && selectedNode && (
          <DetailsPanel
            key={selectedNode.id}
            node={selectedNode}
            level={level}
            canEdit={trusted && !agentBusy}
            onEdit={onEdit}
            onFirstStep={(node, label) => {
              void onFirstStep(node, label);
            }}
            onClose={() => {
              dispatch({ type: 'closeDetails' });
            }}
            onOpen={onOpen}
            onSource={(node) => {
              send({ type: 'open-source', file: node.source.file, line: Math.max(node.source.line, 1) });
            }}
            onOpenCode={(path) => {
              send({ type: 'open-code', path });
            }}
            onLinkCode={(node) => {
              send({ type: 'link-code', nodeId: node.id });
            }}
          />
        )}
      </main>
    </div>
  );
}

/** The history panel is open, on this session if one was asked for. */
interface HistoryRequest {
  session?: string;
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  // The host sends state on every refresh; only a real change to the plan lays the chart out again.
  const [shown, setShown] = useState<{ model: ViewModel; json: string; version: number } | null>(null);
  // Held here because the host can ask for a level before the viewer has mounted.
  const [nav, setNav] = useState<NavState>(() => restoreNav(loadSaved()) ?? initialNav());
  const [entry, setEntry] = useState<Entry>({ kind: 'fade' });
  const [historyPanel, setHistoryPanel] = useState<HistoryRequest | null>(null);
  const openHistory = useCallback((panel: HistoryRequest | null) => {
    setHistoryPanel(panel);
  }, []);

  const latest = useRef<ViewModel | null>(null);
  const latestModel = useCallback(() => latest.current, []);

  useEffect(() => {
    let current: { model: ViewModel; json: string } | undefined;
    const stop = onHostMessage((message) => {
      if (message.type === 'show-level') {
        const model = current?.model;
        if (!model) return;
        setEntry({ kind: 'in' });
        setNav((s) => navReducer(model)(s, { type: 'open', level: message.level }));
        return;
      }
      if (message.type === 'reveal') {
        const model = current?.model;
        const { level, ids } = message.reveal;
        if (!model?.levels[level]) return;
        setEntry({ kind: 'reveal', ids });
        setNav((s) => navReducer(model)(s, { type: 'open', level }));
        return;
      }
      if (message.type === 'edit-result') {
        finishEdit(message.requestId, message.result);
        return;
      }
      if (message.type === 'show-history') {
        openHistory(message.session === undefined ? {} : { session: message.session });
        return;
      }
      // The chat's and the model settings' messages are for the sidebar page.
      if (message.type !== 'state') return;
      setState(message.state);
      if (message.state.kind !== 'plan') return;
      const { model } = message.state;
      const json = JSON.stringify(model);
      if (json === current?.json) return;
      const before = current?.model;
      current = { model, json };
      latest.current = model;
      setShown((old) => ({ model, json, version: (old?.version ?? 0) + 1 }));
      setEntry({ kind: 'keep' });
      // A level or card can disappear when the plan changes.
      setNav((s) => navReducer(model, before)(s, { type: 'reconcile' }));
    });
    send({ type: 'ready' });
    return stop;
  }, [openHistory]);

  useEffect(() => {
    if (!state) return;
    const plan = state.kind === 'plan' ? state.plan : undefined;
    send({ type: 'rendered', kind: state.kind, features: plan?.features.length ?? 0, problems: plan?.problems.length ?? 0 });
  }, [state]);

  const hasPlan = state?.kind === 'plan' && shown !== null;
  const levelId = currentLevel(nav);

  useEffect(() => {
    if (!hasPlan) return;
    save({ history: nav.history, cursor: nav.cursor, selected: nav.selected });
    send({ type: 'level', level: levelId });
  }, [hasPlan, nav, levelId]);

  const onNav = useCallback((update: (s: NavState) => NavState, next?: Entry) => {
    if (next) setEntry(next);
    setNav(update);
  }, []);

  if (!state) return null;
  return (
    <ReactFlowProvider>
      {state.kind === 'plan' && shown ? (
        <Viewer
          trusted={state.trusted}
          agentBusy={state.agentBusy === true}
          model={shown.model}
          version={shown.version}
          nav={nav}
          entry={entry}
          onNav={onNav}
          latestModel={latestModel}
          history={state.history}
          historyPanel={historyPanel}
          onHistoryPanel={openHistory}
        />
      ) : (
        <NoPlan trusted={state.trusted} />
      )}
    </ReactFlowProvider>
  );
}
