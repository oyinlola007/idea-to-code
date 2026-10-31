// The plan viewer: a toolbar, the chart for the current level, the details panel
// and the problems banner. Moving around stays simple here; ITC-12 adds history,
// the breadcrumb and transitions. The host only supplies the model.
import { OVERVIEW, type AppState, type Level, type ViewModel, type VNode } from '@idea-to-code/core';
import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSaved, log, onHostMessage, save, send } from './bridge.js';
import { Chart, type ChartHandle, type Entry, type RenderInfo } from './chart/Chart.js';
import { createLayouter, type Layouter } from './layout/elkClient.js';
import { canvasMeasure } from './layout/measure.js';
import { approxMeasure, type Measure } from './layout/metrics.js';
import { canBack, canForward, currentLevel, initialNav, navReducer, restoreNav, type NavAction, type NavState } from './nav.js';
import './theme.css';
import { Breadcrumb } from './ui/Breadcrumb.js';
import { DetailsPanel } from './ui/DetailsPanel.js';
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
  const errors = model.issues.filter((issue) => issue.severity === 'error');
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
        <span className="codicon codicon-warning" aria-hidden="true" />
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
  onHistory: (dir: 'back' | 'forward') => void;
  onGo: (level: string) => void;
}

function Toolbar({ level, nav, onHistory, onGo }: ToolbarProps) {
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
      <Breadcrumb crumbs={level.crumbs} onGo={onGo} />
      <div className="toolbar__meta">
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

function firstMeasure(): Measure {
  try {
    return canvasMeasure();
  } catch {
    return approxMeasure;
  }
}

interface ViewerProps {
  trusted: boolean;
  model: ViewModel;
  version: number;
  nav: NavState;
  entry: Entry;
  onNav: (nav: (state: NavState) => NavState, entry?: Entry) => void;
}

function Viewer({ trusted, model, version, nav, entry, onNav }: ViewerProps) {
  const [layouter, setLayouter] = useState<Layouter | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [measure] = useState<Measure>(firstMeasure);
  const chart = useRef<ChartHandle>(null);
  const busy = useRef(false);

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
      onNav((state) => navReducer(model)(state, action), nextEntry);
    },
    [model, onNav],
  );

  const levelId = currentLevel(nav);
  const level = model.levels[levelId] ?? model.levels[OVERVIEW];
  const selectedNode = level?.nodes.find((node) => node.id === nav.selected) ?? null;
  const parent = level?.parent ?? null;

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
      if (event.key === 'Escape') {
        event.preventDefault();
        if (nav.details || nav.selected !== null) dispatch({ type: 'escape' });
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
  }, [nav, parent, selectedNode, dispatch, goOut, open, history]);

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
      dispatch({ type: 'select', id });
    },
    [dispatch],
  );
  const onOpen = useCallback(
    (node: VNode) => {
      void open(node);
    },
    [open],
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
      <main className="stage">
        <Chart
          ref={chart}
          level={level}
          version={version}
          layouter={layouter}
          measure={measure}
          selected={selectedNode?.id ?? null}
          panelOpen={nav.details}
          entry={entry}
          onSelect={onSelect}
          onOpen={onOpen}
          onRendered={onRendered}
          onError={onError}
        />
        {nav.details && selectedNode && (
          <DetailsPanel
            node={selectedNode}
            level={level}
            onClose={() => {
              dispatch({ type: 'closeDetails' });
            }}
            onOpen={onOpen}
            onSource={(node) => {
              send({ type: 'open-source', file: node.source.file, line: Math.max(node.source.line, 1) });
            }}
          />
        )}
      </main>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  // The host sends state on every refresh; only a real change to the plan lays the chart out again.
  const [shown, setShown] = useState<{ model: ViewModel; json: string; version: number } | null>(null);
  // Held here because the host can ask for a level before the viewer has mounted.
  const [nav, setNav] = useState<NavState>(() => restoreNav(loadSaved()) ?? initialNav());
  const [entry, setEntry] = useState<Entry>({ kind: 'fade' });

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
      setState(message.state);
      if (message.state.kind !== 'plan') return;
      const { model } = message.state;
      const json = JSON.stringify(model);
      if (json === current?.json) return;
      const before = current?.model;
      current = { model, json };
      setShown((old) => ({ model, json, version: (old?.version ?? 0) + 1 }));
      setEntry({ kind: 'fade' });
      // A level or card can disappear when the plan changes.
      setNav((s) => navReducer(model, before)(s, { type: 'reconcile' }));
    });
    send({ type: 'ready' });
    return stop;
  }, []);

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
        <Viewer trusted={state.trusted} model={shown.model} version={shown.version} nav={nav} entry={entry} onNav={onNav} />
      ) : (
        <NoPlan trusted={state.trusted} />
      )}
    </ReactFlowProvider>
  );
}
