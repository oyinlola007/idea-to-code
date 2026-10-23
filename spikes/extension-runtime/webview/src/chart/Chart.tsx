// One level on the canvas. Lays it out (cached per level and model version),
// keeps the fit-width viewport, and plays the transition that shows where the
// level came from: zoom into the opened card, or out to the card we left.
import { ReactFlow, useReactFlow, type Viewport } from '@xyflow/react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Level, VNode } from '../../../src/shared/viewModel';
import type { Layouter } from '../layout/elkClient';
import { fitWidthViewport, fromElk, toElkGraph, type Placed } from '../layout/geometry';
import type { Measure } from '../layout/metrics';
import { EdgeMarkers, edgeTypes, type PlanFlowEdge } from './PlanEdge';
import { nodeTypes, type PlanFlowNode } from './nodes';

export type Entry = { kind: 'in' } | { kind: 'out'; focus?: string } | { kind: 'fade' };

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
  entry: Entry;
  onSelect: (id: string | null) => void;
  onOpen: (node: VNode) => void;
  onRendered: (info: RenderInfo) => void;
  onError: (message: string) => void;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LEAVE_MS = 200;
const ENTER_MS = 280;

export const Chart = forwardRef<ChartHandle, Props>(function Chart(props, ref) {
  const { level, version, layouter, measure, selected, panelOpen, entry, onSelect, onOpen, onRendered, onError } = props;
  const flow = useReactFlow<PlanFlowNode, PlanFlowEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, Placed>());
  const [placed, setPlaced] = useState<{ key: string; placed: Placed } | null>(null);
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'entering'>('entering');
  const [arrived, setArrived] = useState<string | null>(null);
  const userZoomed = useRef(false);
  /** The card the current level was centred on (coming back up), kept for resizes. */
  const focusRef = useRef<string | undefined>(undefined);

  const key = `${version}:${level.id}`;

  // Layout (cached).
  useEffect(() => {
    let cancelled = false;
    const hit = cache.current.get(key);
    if (hit) {
      setPlaced({ key, placed: hit });
      return;
    }
    const started = performance.now();
    const { graph, boxes, labels } = toElkGraph(level, measure);
    layouter
      .layout(graph)
      .then((result) => {
        if (cancelled) return;
        const p = fromElk(result, boxes, labels, level);
        cache.current.set(key, p);
        setPlaced({ key, placed: p });
        (p as Placed & { ms?: number }).ms = performance.now() - started;
      })
      .catch((err: unknown) => onError(`layout failed for ${level.id}: ${err instanceof Error ? err.message : String(err)}`));
    return () => {
      cancelled = true;
    };
  }, [key, level, layouter, measure, onError]);

  const targetViewport = useCallback((p: Placed, focus?: string): Viewport => {
    const el = wrapper.current;
    const w = el?.clientWidth ?? 960;
    const h = el?.clientHeight ?? 800;
    const n = focus ? p.nodes.find((x) => x.id === focus) : undefined;
    // Back up one level: centre the card we came from, so a big plan doesn't lose your place.
    return fitWidthViewport(p.width, w, 32, n ? { container: { h }, graphH: p.height, focus: { y: n.y, h: n.box.height } } : undefined);
  }, []);

  // Show a newly placed level with its entry transition.
  useEffect(() => {
    if (!placed || placed.key !== key) return;
    const p = placed.placed;
    const focus = entry.kind === 'out' ? entry.focus : undefined;
    const target = targetViewport(p, focus);
    focusRef.current = focus;
    userZoomed.current = false;
    setArrived(focus ?? null);
    const motion = !reducedMotion() && entry.kind !== 'fade';
    if (motion) {
      const el = wrapper.current;
      const cx = (el?.clientWidth ?? 960) / 2;
      const n = focus ? p.nodes.find((x) => x.id === focus) : undefined;
      // Scale around the focus card when coming back to it, else the upper third.
      const cy = n ? (n.y + n.box.height / 2) * target.zoom + target.y : (el?.clientHeight ?? 800) / 3;
      const s = entry.kind === 'in' ? 0.9 : 1.12;
      // Start slightly smaller (coming in) or larger (coming back out), around the upper third.
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
    onRendered({ level: level.id, nodes: p.nodes.length, layoutMs: (p as Placed & { ms?: number }).ms ?? 0, width: p.width, height: p.height });
    if (focus) {
      const t = setTimeout(() => setArrived(null), 1400);
      return () => clearTimeout(t);
    }
    // Only when the placed level changes; entry is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed]);

  // Keep fitting the width as the tab resizes, unless the user zoomed. Only real
  // width changes count: the observer's first call must not undo the entry viewport.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (!userZoomed.current && placed?.key === key) void flow.setViewport(targetViewport(placed.placed, focusRef.current));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [flow, key, placed, targetViewport]);

  useImperativeHandle(
    ref,
    () => ({
      async leave(kind, nodeId) {
        if (reducedMotion()) return;
        setPhase('leaving');
        const n = nodeId ? flow.getNode(nodeId) : undefined;
        const vp = flow.getViewport();
        if (kind === 'in' && n?.width && n.height) {
          await flow.setCenter(n.position.x + n.width / 2, n.position.y + n.height / 2, { zoom: Math.min(2, vp.zoom * 1.6), duration: LEAVE_MS });
        } else {
          const el = wrapper.current;
          const cx = (el?.clientWidth ?? 960) / 2;
          const cy = (el?.clientHeight ?? 800) / 3;
          const s = 0.88;
          await flow.setViewport({ x: cx - (cx - vp.x) * s, y: cy - (cy - vp.y) * s, zoom: vp.zoom * s }, { duration: LEAVE_MS });
        }
        await sleep(0);
      },
    }),
    [flow],
  );

  // Keep the selected card visible beside the details panel (320px + margins),
  // also when the selection arrives before the level is laid out.
  useEffect(() => {
    if (!selected || !panelOpen || placed?.key !== key) return;
    const t = setTimeout(() => {
      const n = flow.getNode(selected);
      const el = wrapper.current;
      if (!n?.width || !el) return;
      const vp = flow.getViewport();
      const right = (n.position.x + n.width) * vp.zoom + vp.x;
      const limit = el.clientWidth - 344 - 16;
      if (right > limit) void flow.setViewport({ ...vp, x: vp.x - (right - limit) }, { duration: reducedMotion() ? 0 : 220 });
    }, ENTER_MS + 20);
    return () => clearTimeout(t);
  }, [selected, panelOpen, flow, placed, key]);

  const neighbours = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    for (const e of level.edges) {
      if (e.from === selected) set.add(e.to);
      if (e.to === selected) set.add(e.from);
    }
    return set;
  }, [selected, level.edges]);

  const current = placed?.key === key ? placed.placed : null;

  const nodes = useMemo<PlanFlowNode[]>(() => {
    if (!current) return [];
    const byId = new Map(level.nodes.map((n) => [n.id, n]));
    return current.nodes.map((p) => ({
      id: p.id,
      type: 'plan',
      position: { x: p.x, y: p.y },
      width: p.box.width,
      height: p.box.height,
      draggable: false,
      connectable: false,
      selected: p.id === selected,
      data: { node: byId.get(p.id)!, box: p.box, dimmed: neighbours !== null && !neighbours.has(p.id), arrived: arrived === p.id, onOpen },
    }));
  }, [current, level.nodes, selected, neighbours, arrived, onOpen]);

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
        onNodeClick={(_, n) => onSelect(n.id)}
        onNodeDoubleClick={(_, n) => onOpen(n.data.node)}
        onPaneClick={() => onSelect(null)}
      />
      {current && level.nodes.length === 0 && (
        <div className="empty">
          <span className="codicon codicon-type-hierarchy" aria-hidden="true" />
          <p>This flow has no steps yet.</p>
        </div>
      )}
    </div>
  );
});
