// A plain summary of the plan, until the chart replaces it in ITC-11.
import type { AppState, PlanSummary } from '@idea-to-code/core';
import { useEffect, useState } from 'react';
import './app.css';
import { onState, send } from './bridge.js';
import { progressText } from './status.js';

function NoPlan({ trusted }: { trusted: boolean }) {
  return (
    <section className="empty">
      <h1>No plan in this workspace yet</h1>
      {trusted ? (
        <button
          type="button"
          onClick={() => {
            send({ type: 'init-plan' });
          }}
        >
          Initialize plan
        </button>
      ) : (
        <p>Trust this folder to create a plan. Restricted Mode is view-only.</p>
      )}
    </section>
  );
}

function Plan({ plan, folder, trusted }: { plan: PlanSummary; folder: string; trusted: boolean }) {
  return (
    <>
      <header>
        <h1>{plan.project ?? folder}</h1>
        <p>{progressText(plan.done, plan.total)}</p>
      </header>
      {!trusted && (
        <p className="notice">Restricted Mode: view-only, and no history is recorded. Trust this folder to turn everything on.</p>
      )}
      <ul className="features">
        {plan.features.map((feature) => (
          <li key={feature.id}>
            <span className="label">{feature.label}</span>
            <span className="progress">{feature.planned ? 'Not planned yet' : progressText(feature.done, feature.total)}</span>
            {feature.description !== undefined && <span className="description">{feature.description}</span>}
          </li>
        ))}
      </ul>
      {plan.features.length === 0 && <p className="notice">No features yet.</p>}
      {plan.problems.length > 0 && (
        <section>
          <h2>Problems</h2>
          <ul className="problems">
            {plan.problems.map((problem) => (
              <li key={`${problem.file}:${String(problem.line)}:${problem.code}:${problem.message}`}>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    send({ type: 'open-problem', file: problem.file, line: Math.max(problem.line, 1) });
                  }}
                >
                  {problem.file}:{problem.line}
                </button>
                <span className={problem.severity}>{problem.severity}</span>
                <span>{problem.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    const stop = onState(setState);
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
    <main>
      {state.kind === 'plan' ? (
        <Plan plan={state.plan} folder={state.folder} trusted={state.trusted} />
      ) : (
        <NoPlan trusted={state.trusted} />
      )}
    </main>
  );
}
