// The plan viewer: a toolbar, the chart for the current level, the details panel
// and the problems banner. Moving around stays simple here; ITC-12 adds history,
// the breadcrumb and transitions. The host only supplies the model.
import { OVERVIEW, type AppState, type Level, type ViewModel, type VNode } from '@idea-to-code/core';
import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useState } from 'react';
import { loadView, log, onHostMessage, saveView, send, type SavedView } from './bridge.js';
import { Chart, type RenderInfo } from './chart/Chart.js';
import { createLayouter, type Layouter } from './layout/elkClient.js';
import { canvasMeasure } from './layout/measure.js';
import { approxMeasure, type Measure } from './layout/metrics.js';
import './theme.css';
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

function Toolbar({ level, onUp }: { level: Level; onUp: () => void }) {
  return (
    <header className="toolbar">
      {level.parent !== null && (
        <button type="button" className="icon-button" onClick={onUp} title="Up a level (Esc)" aria-label="Up a level">
          <span className="codicon codicon-arrow-up" aria-hidden="true" />
        </button>
      )}
      <span className="toolbar__title">{level.title}</span>
      <div className="toolbar__meta">
        <span className="toolbar__progress" title={progressText(level.progress)}>
          <ProgressRing progress={level.progress} size={14} />
          {level.progress.total > 0 ? `${String(level.progress.done)}/${String(level.progress.total)}` : '—'}
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
  view: SavedView;
  onView: (view: SavedView) => void;
}

function Viewer({ trusted, model, version, view, onView }: ViewerProps) {
  const { level: levelId, selected } = view;
  const setSelected = useCallback(
    (id: string | null) => {
      onView({ level: levelId, selected: id });
    },
    [levelId, onView],
  );
  const [layouter, setLayouter] = useState<Layouter | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [measure] = useState<Measure>(firstMeasure);

  useEffect(() => {
    createLayouter((mode, error) => {
      log('warn', `ELK ${mode} mode failed: ${error}`);
    })
      .then(setLayouter)
      .catch((err: unknown) => {
        setFatal(err instanceof Error ? err.message : String(err));
      });
  }, []);

  // A level can disappear when the plan changes.
  const level = model.levels[levelId] ?? model.levels[OVERVIEW];
  const shownId = level?.id ?? OVERVIEW;
  const selectedNode = level?.nodes.find((node) => node.id === selected) ?? null;

  useEffect(() => {
    saveView({ level: shownId, selected: selectedNode?.id ?? null });
  }, [shownId, selectedNode]);

  const open = useCallback(
    (node: VNode) => {
      const target = node.opens ?? node.jumpsTo;
      if (target !== undefined) onView({ level: target, selected: null });
    },
    [onView],
  );

  const parent = level?.parent ?? null;
  const goUp = useCallback(() => {
    if (parent !== null) onView({ level: parent, selected: null });
  }, [parent, onView]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (selectedNode) setSelected(null);
        else goUp();
      } else if (event.key === 'Enter' && selectedNode && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        open(selectedNode);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [selectedNode, goUp, open, setSelected]);

  const onRendered = useCallback(
    (info: RenderInfo) => {
      if (layouter) send({ type: 'chart-rendered', ...info, workerMode: layouter.mode });
    },
    [layouter],
  );
  const onError = useCallback((message: string) => {
    log('error', message);
  }, []);

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
      <Toolbar level={level} onUp={goUp} />
      {!trusted && (
        <p className="level-description">
          Restricted Mode: view-only, and no history is recorded. Trust this folder to turn everything on.
        </p>
      )}
      {level.description !== undefined && <p className="level-description">{level.description}</p>}
      <Problems model={model} />
      <main className="stage">
        <Chart
          level={level}
          version={version}
          layouter={layouter}
          measure={measure}
          selected={selectedNode?.id ?? null}
          panelOpen={selectedNode !== null}
          onSelect={setSelected}
          onOpen={open}
          onRendered={onRendered}
          onError={onError}
        />
        {selectedNode && (
          <DetailsPanel
            node={selectedNode}
            level={level}
            onClose={() => {
              setSelected(null);
            }}
            onOpen={open}
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
  const [view, setView] = useState<SavedView>(() => loadView() ?? { level: OVERVIEW, selected: null });

  useEffect(() => {
    const stop = onHostMessage((message) => {
      if (message.type === 'show-level') {
        setView({ level: message.level, selected: null });
        return;
      }
      setState(message.state);
      if (message.state.kind !== 'plan') return;
      const { model } = message.state;
      const json = JSON.stringify(model);
      setShown((old) => (old?.json === json ? old : { model, json, version: (old?.version ?? 0) + 1 }));
    });
    send({ type: 'ready' });
    return stop;
  }, []);

  useEffect(() => {
    if (!state) return;
    const plan = state.kind === 'plan' ? state.plan : undefined;
    send({ type: 'rendered', kind: state.kind, features: plan?.features.length ?? 0, problems: plan?.problems.length ?? 0 });
  }, [state]);

  if (!state) return null;
  return (
    <ReactFlowProvider>
      {state.kind === 'plan' && shown ? (
        <Viewer trusted={state.trusted} model={shown.model} version={shown.version} view={view} onView={setView} />
      ) : (
        <NoPlan trusted={state.trusted} />
      )}
    </ReactFlowProvider>
  );
}
