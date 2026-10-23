// The plan viewer: toolbar (history, breadcrumb, depth, progress), the chart
// for the current level, the details panel and the problems banner. All
// navigation goes through the nav reducer; the host only supplies the model.
import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostToView, WorkerSetting } from '../../src/shared/messages';
import { OVERVIEW, type LevelId, type ViewModel, type VNode } from '../../src/shared/viewModel';
import { loadState, log, onMessage, saveState, send } from './bridge';
import { Chart, type ChartHandle, type Entry, type RenderInfo } from './chart/Chart';
import { createLayouter, type Layouter } from './layout/elkClient';
import { canvasMeasure } from './layout/measure';
import { approxMeasure, type Measure } from './layout/metrics';
import { canBack, canForward, currentLevel, initialNav, navReducer, type NavAction, type NavState } from './nav';
import { Breadcrumb } from './ui/Breadcrumb';
import { DetailsPanel } from './ui/DetailsPanel';
import { ProgressRing, progressText } from './ui/ProgressRing';

declare global {
  interface Window {
    __select?: string | null;
  }
}

function themeVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  const style = document.documentElement.style;
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith('--vscode-')) vars[name] = style.getPropertyValue(name).trim();
  }
  return vars;
}

function Viewer() {
  const [model, setModel] = useState<ViewModel | null>(null);
  const [version, setVersion] = useState(0);
  const [config, setConfig] = useState<{ workerMode: WorkerSetting; workerUrl: string } | null>(null);
  const [layouter, setLayouter] = useState<Layouter | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [nav, setNav] = useState<NavState>(() => initialNav());
  const [issuesOpen, setIssuesOpen] = useState(false);
  const models = useRef<{ now: ViewModel | null; before: ViewModel | undefined }>({ now: null, before: undefined });
  const chart = useRef<ChartHandle>(null);
  const entry = useRef<Entry>({ kind: 'fade' });
  const busy = useRef(false);
  const [measure, setMeasure] = useState<Measure>(() => approxMeasure);
  // Read before anything is saved: this is what restores a tab VS Code reloaded.
  const restored = useRef(loadState());

  const dispatch = useCallback((a: NavAction) => {
    const m = models.current.now;
    if (m) setNav((s) => navReducer(m, models.current.before)(s, a));
  }, []);

  useEffect(
    () =>
      onMessage((msg: HostToView) => {
        switch (msg.type) {
          case 'config':
            setConfig({ workerMode: msg.workerMode, workerUrl: msg.workerUrl });
            break;
          case 'model': {
            const first = models.current.now === null;
            models.current = { now: msg.model, before: models.current.now ?? undefined };
            setModel(msg.model);
            setVersion((v) => v + 1);
            if (first) {
              const saved = restored.current;
              const start = saved ? saved : { ...initialNav(OVERVIEW), ...(msg.start && msg.start !== OVERVIEW ? { history: [OVERVIEW, msg.start], cursor: 1 } : {}) };
              setNav(navReducer(msg.model)({ ...initialNav(), ...start, details: start.selected != null }, { type: 'reconcile' }));
            } else {
              entry.current = { kind: 'fade' };
              dispatch({ type: 'reconcile' });
            }
            break;
          }
          case 'navigate':
            entry.current = { kind: 'in' };
            dispatch({ type: 'open', level: msg.level });
            break;
          case 'dumpTheme':
            send({ type: 'themeVars', bodyClass: document.body.className, vars: themeVars() });
            break;
        }
      }),
    [dispatch],
  );

  useEffect(() => {
    send({ type: 'ready' });
  }, []);

  useEffect(() => {
    if (!config) return;
    try {
      setMeasure(() => canvasMeasure());
    } catch {
      log('warn', 'canvas text measuring unavailable; using estimates');
    }
    createLayouter(config.workerMode, config.workerUrl, (mode, error) => send({ type: 'workerFailed', mode, error }))
      .then(setLayouter)
      .catch((err: Error) => setFatal(err.message));
  }, [config]);

  useEffect(() => {
    if (!models.current.now) return;
    saveState({ history: nav.history, cursor: nav.cursor, selected: nav.selected });
    send({ type: 'level', level: currentLevel(nav) });
  }, [nav]);

  // Harness: preselect a node once (for "details" screenshots).
  useEffect(() => {
    if (model && window.__select) {
      dispatch({ type: 'select', id: window.__select });
      window.__select = null;
    }
  }, [model, dispatch]);

  const levelId = currentLevel(nav);
  const level = model?.levels[levelId] ?? model?.levels[OVERVIEW];
  const selectedNode = level?.nodes.find((n) => n.id === nav.selected) ?? null;
  const errors = useMemo(() => model?.issues.filter((i) => i.severity === 'error') ?? [], [model]);

  const openNode = useCallback(
    async (node: VNode) => {
      const target = node.opens ?? node.jumpsTo;
      if (!target || busy.current) return;
      busy.current = true;
      try {
        await chart.current?.leave('in', node.id);
        entry.current = { kind: 'in' };
        dispatch({ type: 'open', level: target });
      } finally {
        busy.current = false;
      }
    },
    [dispatch],
  );

  /** The card in `parent` that leads to `child`, when `parent` is exactly one level up. */
  const cardLeadingTo = useCallback((parent: LevelId, child: LevelId): string | undefined => {
    const m = models.current.now;
    if (!m || m.levels[child]?.parent !== parent) return undefined;
    return m.levels[parent]?.nodes.find((n) => n.opens === child || n.jumpsTo === child)?.id;
  }, []);

  /** Go out to an ancestor. One level up centres the card we came from; bigger jumps start at the top. */
  const goOut = useCallback(
    async (target: LevelId) => {
      if (!models.current.now || busy.current) return;
      const focus = cardLeadingTo(target, currentLevel(nav));
      busy.current = true;
      try {
        await chart.current?.leave('out');
        entry.current = { kind: 'out', ...(focus ? { focus } : {}) };
        dispatch({ type: 'open', level: target });
      } finally {
        busy.current = false;
      }
    },
    [dispatch, nav, cardLeadingTo],
  );

  const escape = useCallback(() => {
    if (nav.details || nav.selected) return dispatch({ type: 'escape' });
    const parent = level?.parent;
    if (parent) void goOut(parent);
  }, [nav, level, dispatch, goOut]);

  const history = useCallback(
    async (dir: 'back' | 'forward') => {
      if (busy.current) return;
      const target = nav.history[nav.cursor + (dir === 'back' ? -1 : 1)];
      if (target === undefined) return;
      // Back to the level directly above behaves like going up: centre the card we left.
      const focus = dir === 'back' ? cardLeadingTo(target, currentLevel(nav)) : undefined;
      if (focus) {
        busy.current = true;
        try {
          await chart.current?.leave('out');
        } finally {
          busy.current = false;
        }
        entry.current = { kind: 'out', focus };
      } else {
        entry.current = { kind: 'fade' };
      }
      dispatch({ type: dir });
    },
    [dispatch, nav, cardLeadingTo],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        escape();
      } else if (e.key === 'Enter' && selectedNode && !(t instanceof HTMLButtonElement)) {
        e.preventDefault();
        void openNode(selectedNode);
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        void history('back');
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        void history('forward');
      } else if (e.key === 'Backspace' && level?.parent) {
        e.preventDefault();
        void goOut(level.parent);
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) void history('back');
      if (e.button === 4) void history('forward');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [escape, openNode, history, goOut, selectedNode, level]);

  const onRendered = useCallback(
    (info: RenderInfo) => {
      if (layouter) send({ type: 'rendered', ...info, workerMode: layouter.mode });
    },
    [layouter],
  );
  const onSelect = useCallback((id: string | null) => dispatch({ type: 'select', id }), [dispatch]);
  const onError = useCallback((message: string) => log('error', message), []);

  if (fatal) {
    return (
      <div className="state state--error">
        <span className="codicon codicon-error" aria-hidden="true" />
        <p>The chart couldn't start: {fatal}</p>
      </div>
    );
  }
  if (!model || !level || !layouter) {
    return (
      <div className="state" aria-busy="true">
        <span className="state__spinner" aria-hidden="true" />
        <p>Loading plan…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar__history">
          <button type="button" className="icon-button" disabled={!canBack(nav)} onClick={() => void history('back')} title="Back (Alt+←)" aria-label="Back">
            <span className="codicon codicon-arrow-left" aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" disabled={!canForward(nav)} onClick={() => void history('forward')} title="Forward (Alt+→)" aria-label="Forward">
            <span className="codicon codicon-arrow-right" aria-hidden="true" />
          </button>
        </div>
        <Breadcrumb crumbs={level.crumbs} onGo={(id) => void goOut(id)} />
        <div className="toolbar__meta">
          {level.depth > 0 && (
            <span className="depth" title={`${level.depth} level${level.depth > 1 ? 's' : ''} below the overview`}>
              Level {level.depth}
            </span>
          )}
          <span className="toolbar__progress" title={progressText(level.progress)}>
            <ProgressRing progress={level.progress} size={14} />
            {level.progress.total ? `${level.progress.done}/${level.progress.total}` : '—'}
          </span>
        </div>
      </header>
      {level.description && <p className="level-description">{level.description}</p>}
      {errors.length > 0 && (
        <div className={`issues${issuesOpen ? ' issues--open' : ''}`} role="status">
          <button type="button" className="issues__summary" onClick={() => setIssuesOpen((o) => !o)} aria-expanded={issuesOpen}>
            <span className="codicon codicon-warning" aria-hidden="true" />
            {errors.length === 1 ? '1 problem in the plan files' : `${errors.length} problems in the plan files`}. The rest of the plan still shows.
            <span className={`codicon codicon-chevron-${issuesOpen ? 'up' : 'down'}`} aria-hidden="true" />
          </button>
          {issuesOpen && (
            <ul>
              {errors.map((i, k) => (
                <li key={k}>
                  <button type="button" className="issues__item" onClick={() => send({ type: 'openSource', file: i.file, line: i.line })}>
                    <span className="issues__where">
                      {i.file.replace(/^plan\//, '')}:{i.line}
                    </span>
                    {i.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <main className="stage">
        <Chart
          ref={chart}
          level={level}
          version={version}
          layouter={layouter}
          measure={measure}
          selected={nav.selected}
          panelOpen={nav.details}
          entry={entry.current}
          onSelect={onSelect}
          onOpen={openNode}
          onRendered={onRendered}
          onError={onError}
        />
        {nav.details && selectedNode && (
          <DetailsPanel
            node={selectedNode}
            level={level}
            onClose={() => dispatch({ type: 'closeDetails' })}
            onOpen={openNode}
            onSource={(n) => send({ type: 'openSource', file: n.source.file, line: n.source.line })}
          />
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Viewer />
    </ReactFlowProvider>
  );
}
