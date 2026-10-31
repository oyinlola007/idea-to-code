// Where you are, from the main map down, and a way to jump to any level above.
// The path shows in full while it fits; otherwise the levels after the main map
// move into a "…" menu, starting with the furthest from you.
import type { Crumb, LevelId } from '@idea-to-code/core';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { crumbsToHide } from './crumbLayout.js';

const MENU_MARGIN = 8;

const MapIcon = () => <span className="codicon codicon-type-hierarchy" aria-hidden="true" />;
const Separator = () => <span className="codicon codicon-chevron-right crumbs__sep" aria-hidden="true" />;

function MoreMenu({ hidden, onGo }: { hidden: Crumb[]; onGo: (id: LevelId) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Shift left if the menu would run off the right of the tab.
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const overflow = menu.current.getBoundingClientRect().right - (document.documentElement.clientWidth - MENU_MARGIN);
    if (overflow > 0) menu.current.style.left = `${String(-overflow)}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: Event) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };
    const closeOnBlur = () => {
      setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('blur', closeOnBlur);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('blur', closeOnBlur);
    };
  }, [open]);

  // While the menu is open its keys belong to it: Esc closes the menu rather than going up a level.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    event.stopPropagation();
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items.at(at <= 0 ? -1 : at - 1)?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="crumbs__menu-root" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={toggle}
        type="button"
        className="crumbs__more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Show ${String(hidden.length)} more level${hidden.length > 1 ? 's' : ''}`}
        title={hidden.map((crumb) => crumb.title).join(' › ')}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        …
      </button>
      {open && (
        <div ref={menu} className="crumbs__menu" role="menu" aria-label="Hidden levels">
          {hidden.map((crumb) => (
            <button
              key={crumb.id}
              type="button"
              role="menuitem"
              className="crumbs__menu-item"
              title={crumb.title}
              onClick={() => {
                setOpen(false);
                onGo(crumb.id);
              }}
            >
              {crumb.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The visible path, with `hide` levels after the main map moved into the menu. */
export function CrumbTrail({ crumbs, hide, onGo }: { crumbs: Crumb[]; hide: number; onGo: (id: LevelId) => void }) {
  const hidden = crumbs.slice(1, 1 + hide);
  const shown: (Crumb | null)[] = hide > 0 ? [...crumbs.slice(0, 1), null, ...crumbs.slice(1 + hide)] : crumbs;
  return (
    <ol>
      {shown.map((crumb, i) => {
        const isMap = i === 0;
        return (
          <li key={crumb?.id ?? 'more'} className={crumb === null ? 'crumbs__more-item' : undefined}>
            {!isMap && <Separator />}
            {crumb === null ? (
              <MoreMenu hidden={hidden} onGo={onGo} />
            ) : i === shown.length - 1 ? (
              <span className="crumbs__current" aria-current="page" title={crumb.title}>
                {isMap && <MapIcon />}
                {crumb.title}
              </span>
            ) : (
              <button
                type="button"
                className="crumbs__link"
                title={crumb.title}
                onClick={() => {
                  onGo(crumb.id);
                }}
              >
                {isMap && <MapIcon />}
                <span className="crumbs__text">{crumb.title}</span>
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function Breadcrumb({ crumbs, onGo }: { crumbs: Crumb[]; onGo: (id: LevelId) => void }) {
  const nav = useRef<HTMLElement>(null);
  const ruler = useRef<HTMLOListElement>(null);
  const [hide, setHide] = useState(0);

  // Before the first paint, so a long path never flashes in full.
  useLayoutEffect(() => {
    const update = () => {
      const items = [...(ruler.current?.children ?? [])].map((item) => Math.ceil(item.getBoundingClientRect().width));
      const moreWidth = items.pop() ?? 0;
      setHide(crumbsToHide(items, nav.current?.clientWidth ?? 0, moreWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    if (nav.current) observer.observe(nav.current);
    return () => {
      observer.disconnect();
    };
  }, [crumbs]);

  return (
    <nav className="crumbs" aria-label="Plan levels" ref={nav}>
      <CrumbTrail crumbs={crumbs} hide={hide} onGo={onGo} />
      {/* An invisible copy of the whole path, to measure what it would need. */}
      <div className="crumbs__ruler-clip" aria-hidden="true">
        <ol className="crumbs__ruler" ref={ruler}>
          {crumbs.map((crumb, i) => (
            <li key={crumb.id}>
              {i > 0 && <Separator />}
              <span className={i === crumbs.length - 1 ? 'crumbs__current' : 'crumbs__link'}>
                {i === 0 && <MapIcon />}
                {crumb.title}
              </span>
            </li>
          ))}
          <li>
            <Separator />
            <span className="crumbs__more">…</span>
          </li>
        </ol>
      </div>
    </nav>
  );
}
