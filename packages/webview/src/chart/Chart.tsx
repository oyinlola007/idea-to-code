// One level on the canvas. Lays it out (cached per level and model version) and
// keeps the fit-width viewport: zoom at most 1, aligned to the top.
import { ReactFlow, useReactFlow, type Viewport } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Level, VNode } from '@idea-to-code/core';
import type { Layouter } from '../layout/elkClient.js';
import { fitWidthViewport, fromElk, toElkGraph, type Placed } from '../layout/geometry.js';
import type { Measure } from '../layout/metrics.js';
import { EdgeMarkers, edgeTypes, type PlanFlowEdge } from './PlanEdge.js';
import { nodeTypes, type PlanFlowNode } from './nodes.js';

type Timed = Placed & { ms: number };

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
  onSelect: (id: string | null) => void;
  onOpen: (node: VNode) => void;
  onRendered: (info: RenderInfo) => void;
  onError: (message: string) => void;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SETTLE_MS = 300;

export function Chart({ level, version, layouter, measure, selected, panelOpen, onSelect, onOpen, onRendered, onError }: Props) {
  const flow = useReactFlow<PlanFlowNode, PlanFlowEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, Timed>());
  const [placed, setPlaced] = useState<{ key: string; placed: Timed } | null>(null);
  const userZoomed = useRef(false);

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
        const p = { ...fromElk(result, boxes, labels, level), ms: performance.now() - started };
        cache.current.set(key, p);
        setPlaced({ key, placed: p });
      })
      .catch((err: unknown) => {
        onError(`layout failed for ${level.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [key, level, layouter, measure, onError]);

  const targetViewport = useCallback((p: Placed): Viewport => fitWidthViewport(p.width, wrapper.current?.clientWidth ?? 960), []);

  // Show a newly placed level.
  useEffect(() => {
    if (placed?.key !== key) return;
    const p = placed.placed;
    userZoomed.current = false;
    void flow.setViewport(targetViewport(p));
    onRendered({ level: level.id, nodes: p.nodes.length, layoutMs: p.ms, width: p.width, height: p.height });
    // Only when the placed level changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed]);

  // Keep fitting the width as the tab resizes, unless the user zoomed.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (!userZoomed.current && placed?.key === key) void flow.setViewport(targetViewport(placed.placed));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [flow, key, placed, targetViewport]);

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
    }, SETTLE_MS);
    return () => {
      clearTimeout(t);
    };
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
          data: { node, box: p.box, dimmed: neighbours !== null && !neighbours.has(p.id), onOpen },
        },
      ];
    });
  }, [current, level.nodes, selected, neighbours, onOpen]);

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
    <div ref={wrapper} className="chart chart--shown">
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
          onSelect(n.id);
        }}
        onNodeDoubleClick={(_, n) => {
          onOpen(n.data.node);
        }}
        onPaneClick={() => {
          onSelect(null);
        }}
      />
      {current && level.nodes.length === 0 && (
        <div className="empty">
          <span className="codicon codicon-type-hierarchy" aria-hidden="true" />
          <p>This flow has no steps yet.</p>
        </div>
      )}
    </div>
  );
}
