// What the chart needs to draw a plan, already resolved by the extension host:
// every level, with parents, progress and source lines. The webview never
// parses YAML, so it can also be rendered from a JSON file (screenshots).

/** `overview`, or a flow id (a feature's main flow uses the feature id). */
export type LevelId = string;

export type NodeKind = 'feature' | 'start' | 'end' | 'step' | 'decision' | 'component' | 'reference';
export type Status = 'todo' | 'in_progress' | 'done';

/** A file relative to the plan root, and a 1-based line. */
export interface SourcePos {
  file: string;
  line: number;
}

export interface Progress {
  done: number;
  total: number;
}

export interface VNode {
  id: string;
  kind: NodeKind;
  label: string;
  description?: string;
  status?: Status;
  componentKind?: string;
  tech?: string;
  /** The level this node expands into (child flow, or a feature's main flow). */
  opens?: LevelId;
  /** For references: the level the target lives at, when it has one. */
  jumpsTo?: LevelId;
  refLabel?: string;
  /** Computed for nodes that open a level. */
  progress?: Progress;
  /** An overview feature that has no flows yet. */
  planned?: boolean;
  source: SourcePos;
}

export interface VEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  data?: string;
}

export interface Crumb {
  id: LevelId;
  title: string;
}

export interface Level {
  id: LevelId;
  title: string;
  description?: string;
  parent: LevelId | null;
  /** From the overview down to this level, inclusive. */
  crumbs: Crumb[];
  depth: number;
  nodes: VNode[];
  edges: VEdge[];
  progress: Progress;
  source: SourcePos;
}

export interface PlanIssue {
  file: string;
  line: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ViewModel {
  project: string;
  levels: Record<LevelId, Level>;
  issues: PlanIssue[];
}

export const OVERVIEW: LevelId = 'overview';
