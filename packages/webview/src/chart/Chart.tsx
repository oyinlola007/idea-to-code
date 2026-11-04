// One level on the canvas. Lays it out (cached per level and model version),
// keeps the fit-width viewport, and plays the transition that shows where the
// level came from: zoom into the opened card, or out to the card we left. After
// the agent's changes, it centres on the changed cards and rings them for a moment.
import { ReactFlow, useReactFlow, type Viewport } from '@xyflow/react';
import { forwardRef, useCallback, useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Level, VNode } from '@idea-to-code/core';
import type { Layouter } from '../layout/elkClient.js';
import { fitWidthViewport, fromElk, toElkGraph, type Placed } from '../layout/geometry.js';
import type { Measure } from '../layout/metrics.js';
import { EdgeMarkers, edgeTypes, type PlanFlowEdge } from './PlanEdge.js';
import { nodeTypes, type PlanFlowNode } from './nodes.js';
import { settle } from './settle.js';

type Timed = Placed & { ms: number };

/**
 * How a level arrives. `keep` is the same level after the plan changed: you stay where you were.
 * `reveal` points out cards, on a new level or the one already shown.
 */
export type Entry =
  { kind: 'in' } | { kind: 'out'; focus?: string } | { kind: 'fade' } | { kind: 'keep' } | { kind: 'reveal'; ids: string[] };

export interface ChartHandle {
  leave(kind: 'in' | 'out', nodeId?: string): Promise<void>;
}

export interface RenderInfo {
  level: string;
  nodes: number;
  layoutMs: number;
  width: number;
  height: number;
}

interface Props {
  level: Level;
  version: number;
  layouter: Layouter;
  measure: Measure;
  selected: string | null;
  /** The details panel is open over the right edge of the canvas. */
  panelOpen: boolean;
  emptyText: string;
  entry: Entry;
  onSelect: (id: string | null) => void;
  onOpen: (node: VNode) => void;
  onRendered: (info: RenderInfo) => void;
  onError: (message: string) => void;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const LEAVE_MS = 200;
const LEAVE_LIMIT_MS = LEAVE_MS + 80;
const ENTER_MS = 280;
const ARRIVED_MS = 1400;
const REVEALED_MS = 3000;
const REVEAL_PAN_MS = 400;
/** How long a click on a card that opens waits to see whether it's a double-click. */
const DOUBLE_CLICK_MS = 250;
const SETTLE_MS = ENTER_MS + 20;
const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const Chart = forwardRef<ChartHandle, Props>(function Chart(props, ref) {
  const { level, version, layouter, measure, selected, panelOpen, emptyText, entry, onSelect, onOpen, onRendered, onError } = props;
  const flow = useReactFlow<PlanFlowNode, PlanFlowEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, Timed>());
  const [placed, setPlaced] = useState<{ key: string; levelId: string; placed: Timed } | null>(null);
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'entering'>('entering');
  /** Cards ringed for a moment: the one we came back to, or the agent's changes. */
  const [ringed, setRinged] = useState<{ ids: string[]; kind: 'arrived' | 'revealed' } | null>(null);
  const revealed = useRef<Entry | null>(null);
  const userZoomed = useRef(false);
  const leaving = useRef(false);
  const shownLevel = useRef<string | null>(null);
  const pendingClick = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The cards the current level was centred on, kept for resizes. */
  const focusRef = useRef<string[] | undefined>(undefined);

  const key = `${version}:${level.id}`;

  // Layout (cached).
  useEffect(() => {
    let cancelled = false;
    const hit = cache.current.get(key);
    if (hit) {
      setPlaced({ key, levelId: level.id, placed: hit });
      return;
    }
    const started = performance.now();
    const { graph, boxes, labels } = toElkGraph(level, measure);
    layouter
      .layout(graph)
      .then((result) => {
        if (cancelled) return;
        const p = { ...fromElk(result, boxes, labels, level), ms: performance.now() - started };
        // Layouts of older versions of the plan will never be shown again.
        for (const old of cache.current.keys()) if (!old.startsWith(`${String(version)}:`)) cache.current.delete(old);
        cache.current.set(key, p);
        setPlaced({ key, levelId: level.id, placed: p });
      })
      .catch((err: unknown) => {
        onError(`layout failed for ${level.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [key, version, level, layouter, measure, onError]);

  const targetViewport = useCallback((p: Placed, focus?: string[]): Viewport => {
    const el = wrapper.current;
    const w = el?.clientWidth ?? 960;
    const h = el?.clientHeight ?? 800;
    const cards = focus ? p.nodes.filter((x) => focus.includes(x.id)) : [];
    if (cards.length === 0) return fitWidthViewport(p.width, w, 32);
    // Centre the cards that matter (the one we came back to, or the changes), so a big plan doesn't lose your place.
    const top = Math.min(...cards.map((n) => n.y));
    const bottom = Math.max(...cards.map((n) => n.y + n.box.height));
    return fitWidthViewport(p.width, w, 32, { container: { h }, graphH: p.height, focus: { y: top, h: bottom - top } });
  }, []);

  /** Shows a newly placed level with its entry transition, reading the props of that moment. */
  const showPlaced = useEffectEvent((p: Timed): 'arrived' | 'revealed' | undefined => {
    leaving.current = false;
    const sameLevel = shownLevel.current === level.id;
    shownLevel.current = level.id;
    const info = { level: level.id, nodes: p.nodes.length, layoutMs: p.ms, width: p.width, height: p.height };
    if (entry.kind === 'reveal') revealed.current = entry;
    if (entry.kind === 'reveal' && sameLevel) {
      // Already here: glide to the changes.
      focusRef.current = entry.ids;
      userZoomed.current = false;
      void flow.setViewport(targetViewport(p, entry.ids), { duration: reducedMotion() ? 0 : REVEAL_PAN_MS });
      setRinged({ ids: entry.ids, kind: 'revealed' });
      setPhase('shown');
      onRendered(info);
      return 'revealed';
    }
    if (entry.kind === 'keep' && sameLevel) {
      // Scrolled or zoomed: leave everything alone. Otherwise only recentre for the new width.
      if (!userZoomed.current) {
        const target = targetViewport(p);
        void flow.setViewport({ ...target, y: flow.getViewport().y });
      }
      setPhase('shown');
      onRendered(info);
      return undefined;
    }
    const focus = entry.kind === 'out' ? entry.focus : undefined;
    const ids = entry.kind === 'reveal' ? entry.ids : focus === undefined ? undefined : [focus];
    const target = targetViewport(p, ids);
    focusRef.current = ids;
    userZoomed.current = false;
    const kind = entry.kind === 'reveal' ? 'revealed' : 'arrived';
    setRinged(ids ? { ids, kind } : null);
    if (!reducedMotion() && entry.kind !== 'fade' && entry.kind !== 'reveal') {
      const el = wrapper.current;
      const cx = (el?.clientWidth ?? 960) / 2;
      const n = focus ? p.nodes.find((x) => x.id === focus) : undefined;
      // Scale around the focus card when coming back to it, else the upper third.
      const cy = n ? (n.y + n.box.height / 2) * target.zoom + target.y : (el?.clientHeight ?? 800) / 3;
      const s = entry.kind === 'in' ? 0.9 : 1.12;
      void flow.setViewport({ x: cx - (cx - target.x) * s, y: cy - (cy - target.y) * s, zoom: target.zoom * s });
      setPhase('entering');
      requestAnimationFrame(() => {
        setPhase('shown');
        void flow.setViewport(target, { duration: ENTER_MS });
      });
    } else {
      void flow.setViewport(target);
      setPhase('shown');
    }
    onRendered(info);
    return ids ? kind : undefined;
  });

  /** A new ring, with how long it stays. */
  const [ringing, setRinging] = useState<{ ms: number } | null>(null);
  const ring = useCallback((kind: 'arrived' | 'revealed' | undefined) => {
    if (kind) setRinging({ ms: kind === 'revealed' ? REVEALED_MS : ARRIVED_MS });
  }, []);
  useEffect(() => {
    if (placed?.key !== key) return;
    ring(showPlaced(placed.placed));
  }, [placed, key, ring]);

  // Changes pointed out on the level already shown, which isn't laid out again.
  useEffect(() => {
    if (entry.kind !== 'reveal' || revealed.current === entry || placed?.key !== key || shownLevel.current !== level.id) return;
    ring(showPlaced(placed.placed));
  }, [entry, placed, key, level.id, ring]);

  // The ring is a pointer, not a state: it goes after a moment.
  useEffect(() => {
    if (!ringing) return;
    const timer = setTimeout(() => {
      setRinged(null);
    }, ringing.ms);
    return () => {
      clearTimeout(timer);
    };
  }, [ringing]);

  // Keep the selected card visible beside the details panel (320px + margins).
  const keepSelectedVisible = useCallback(() => {
    // A pan now would interrupt the leaving animation.
    if (!selected || !panelOpen || leaving.current) return;
    const n = flow.getNode(selected);
    const el = wrapper.current;
    if (!n?.width || !el) return;
    const vp = flow.getViewport();
    const right = (n.position.x + n.width) * vp.zoom + vp.x;
    const limit = el.clientWidth - 344 - 16;
    if (right > limit) void flow.setViewport({ ...vp, x: vp.x - (right - limit) }, { duration: reducedMotion() ? 0 : 220 });
  }, [flow, selected, panelOpen]);

  // Also when the selection arrives before the level is laid out.
  useEffect(() => {
    if (!selected || !panelOpen || placed?.key !== key) return;
    const timer = setTimeout(keepSelectedVisible, SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [selected, panelOpen, placed, key, keepSelectedVisible]);

  // Keep fitting the width as the tab resizes, unless the user zoomed. Only real
  // width changes count: the observer's first call must not undo the entry viewport.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (!userZoomed.current && placed?.key === key) {
        void flow.setViewport(targetViewport(placed.placed, focusRef.current)).then(keepSelectedVisible);
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [flow, key, placed, targetViewport, keepSelectedVisible]);

  useImperativeHandle(
    ref,
    () => ({
      async leave(kind, nodeId) {
        if (reducedMotion()) return;
        clearTimeout(pendingClick.current);
        leaving.current = true;
        setPhase('leaving');
        const n = nodeId ? flow.getNode(nodeId) : undefined;
        const vp = flow.getViewport();
        if (kind === 'in' && n?.width && n.height) {
          const center = flow.setCenter(n.position.x + n.width / 2, n.position.y + n.height / 2, {
            zoom: Math.min(2, vp.zoom * 1.6),
            duration: LEAVE_MS,
          });
          await settle(center, LEAVE_LIMIT_MS);
        } else {
          const el = wrapper.current;
          const cx = (el?.clientWidth ?? 960) / 2;
          const cy = (el?.clientHeight ?? 800) / 3;
          const s = 0.88;
          const out = flow.setViewport({ x: cx - (cx - vp.x) * s, y: cy - (cy - vp.y) * s, zoom: vp.zoom * s }, { duration: LEAVE_MS });
          await settle(out, LEAVE_LIMIT_MS);
        }
        await sleep(0);
      },
    }),
    [flow],
  );

  // A click waiting on the level we just left mustn't select anything on the next one.
  useEffect(
    () => () => {
      clearTimeout(pendingClick.current);
    },
    [key],
  );

  const neighbours = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    for (const e of level.edges) {
      if (e.from === selected) set.add(e.to);
      if (e.to === selected) set.add(e.from);
    }
    return set;
  }, [selected, level.edges]);

  // While the same level is laid out again, the old chart stays up instead of a blank flash.
  const current = placed?.key === key || placed?.levelId === level.id ? placed.placed : null;

  const nodes = useMemo<PlanFlowNode[]>(() => {
    if (!current) return [];
    const byId = new Map(level.nodes.map((n) => [n.id, n]));
    return current.nodes.flatMap((p) => {
      const node = byId.get(p.id);
      if (!node) return [];
      return [
        {
          id: p.id,
          type: 'plan' as const,
          position: { x: p.x, y: p.y },
          width: p.box.width,
          height: p.box.height,
          draggable: false,
          connectable: false,
          selected: p.id === selected,
          data: {
            node,
            box: p.box,
            dimmed: neighbours !== null && !neighbours.has(p.id),
            ring: ringed?.ids.includes(p.id) === true ? ringed.kind : null,
            onOpen,
          },
        },
      ];
    });
  }, [current, level.nodes, selected, neighbours, ringed, onOpen]);

  const edges = useMemo<PlanFlowEdge[]>(() => {
    if (!current) return [];
    return current.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: 'plan',
      selectable: false,
      focusable: false,
      data: {
        points: e.points,
        label: e.label,
        labelAt: e.labelAt,
        emphasis: !selected ? 'none' : e.from === selected || e.to === selected ? 'active' : 'dim',
      },
    }));
  }, [current, selected]);

  const pad = 480;
  const extent: [[number, number], [number, number]] | undefined = current
    ? [
        [-pad, -pad / 2],
        [current.width + pad, current.height + pad],
      ]
    : undefined;

  return (
    <div ref={wrapper} className={`chart chart--${phase}`}>
      <EdgeMarkers />
      <ReactFlow<PlanFlowNode, PlanFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        selectNodesOnDrag={false}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        disableKeyboardA11y={false}
        minZoom={0.25}
        maxZoom={2}
        {...(extent ? { translateExtent: extent } : {})}
        proOptions={{ hideAttribution: true }}
        onMoveStart={(event) => {
          if (event && 'type' in event && (event.type === 'wheel' || event.type === 'touchstart')) userZoomed.current = true;
        }}
        onNodeClick={(_, n) => {
          clearTimeout(pendingClick.current);
          const { node } = n.data;
          // A double-click starts with a click: only cards that open have to wait to tell them apart.
          if (node.opens === undefined && node.jumpsTo === undefined) {
            onSelect(n.id);
            return;
          }
          pendingClick.current = setTimeout(() => {
            onSelect(n.id);
          }, DOUBLE_CLICK_MS);
        }}
        onNodeDoubleClick={(_, n) => {
          clearTimeout(pendingClick.current);
          onOpen(n.data.node);
        }}
        onPaneClick={() => {
          clearTimeout(pendingClick.current);
          onSelect(null);
        }}
      />
      {current && level.nodes.length === 0 && (
        <div className="empty">
          <span className="codicon codicon-type-hierarchy" aria-hidden="true" />
          <p>{emptyText}</p>
        </div>
      )}
    </div>
  );
});
