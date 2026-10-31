import type { Crumb, LevelId } from '@idea-to-code/core';

/** Where you are, from the overview down. Long trails collapse their middle. */
export function Breadcrumb({ crumbs, onGo }: { crumbs: Crumb[]; onGo: (id: LevelId) => void }) {
  const shown: (Crumb | null)[] = crumbs.length > 4 ? [...crumbs.slice(0, 1), null, ...crumbs.slice(-2)] : crumbs;
  return (
    <nav className="crumbs" aria-label="Plan levels">
      <ol>
        {shown.map((c, i) => {
          const last = i === shown.length - 1;
          return (
            <li key={c?.id ?? 'more'}>
              {i > 0 && <span className="codicon codicon-chevron-right crumbs__sep" aria-hidden="true" />}
              {c === null ? (
                <span
                  className="crumbs__more"
                  title={crumbs
                    .slice(1, -2)
                    .map((x) => x.title)
                    .join(' › ')}
                >
                  …
                </span>
              ) : last ? (
                <span className="crumbs__current" aria-current="page" title={c.title}>
                  {i === 0 && <span className="codicon codicon-type-hierarchy" aria-hidden="true" />}
                  {c.title}
                </span>
              ) : (
                <button
                  type="button"
                  className="crumbs__link"
                  onClick={() => {
                    onGo(c.id);
                  }}
                  title={c.title}
                >
                  {i === 0 && <span className="codicon codicon-type-hierarchy" aria-hidden="true" />}
                  <span className="crumbs__text">{c.title}</span>
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
