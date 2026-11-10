// The messages between the webview and the extension host. Both sides parse every
// message with these schemas, so neither trusts what crosses the boundary.
import { z } from 'zod';
import { type Issue, type Project, loadFromTexts } from './load.js';
import { OVERVIEW, rollup } from './progress.js';
import { Reveal } from './reveal.js';
import { indexProject, validateProject } from './validate.js';
import { ViewModel } from './viewModel.js';

const Problem = z.strictObject({
  file: z.string(),
  line: z.number(),
  col: z.number(),
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
});

const FeatureSummary = z.strictObject({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  done: z.number(),
  total: z.number(),
  /** Listed in map.yaml, with no flows file yet. */
  planned: z.boolean(),
});

const PlanSummary = z.strictObject({
  /** Null when map.yaml can't be read. */
  project: z.string().nullable(),
  features: z.array(FeatureSummary),
  done: z.number(),
  total: z.number(),
  problems: z.array(Problem),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

const HistoryEntry = z.strictObject({
  id: z.string(),
  at: z.number(),
  source: z.enum(['ui', 'agent', 'mcp', 'external', 'restore', 'repair']),
  /** Who made the change, in words: "You", "Claude Code via MCP", "Outside edit". */
  who: z.string(),
  summary: z.string(),
  /** A restore only: when the version it brought back was made. */
  restoredFromAt: z.number().optional(),
  /** A restore made by Undo. */
  undo: z.boolean().optional(),
  /** Holds exactly what the plan holds now, so restoring it would change nothing. */
  current: z.boolean(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

const HistorySession = z.strictObject({
  id: z.string(),
  kind: z.enum(['chat', 'activity']),
  title: z.string(),
  openedAt: z.number(),
  /** Newest first. */
  entries: z.array(HistoryEntry),
});
export type HistorySession = z.infer<typeof HistorySession>;

export const HistoryView = z.strictObject({
  /** The session with the newest change first. */
  sessions: z.array(HistorySession),
  /** Earlier changes left out of the list, to keep it a sensible size. They stay in history. */
  older: z.number().int(),
  /** What Undo would reverse. `latest` lets the host refuse if the plan has moved on since this was shown. */
  undo: z.strictObject({ latest: z.string(), who: z.string(), summary: z.string() }).nullable(),
  /** Why history couldn't be read. */
  problem: z.string().optional(),
});
export type HistoryView = z.infer<typeof HistoryView>;

export const AppState = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('no-plan'), trusted: z.boolean() }),
  z.strictObject({
    kind: z.literal('plan'),
    trusted: z.boolean(),
    folder: z.string(),
    plan: PlanSummary,
    model: ViewModel,
    /** Null in Restricted Mode, which records and reads no history. */
    history: HistoryView.nullable(),
    /** The built-in agent is working: the chart shows its changes so far, and edits wait until it's done. */
    agentBusy: z.boolean().optional(),
    /** A shared web page: only reading, with no editor to edit in or open files from. */
    readOnly: z.literal(true).optional(),
  }),
]);
export type AppState = z.infer<typeof AppState>;

/** Something a chat notice can offer to do. */
export const ChatAction = z.enum(['open-model-settings', 'init-plan', 'show-history', 'open-plan', 'undo', 'trust', 'open-folder']);
export type ChatAction = z.infer<typeof ChatAction>;

const ItemId = z.string().max(100);

/** One line of the chat, as the sidebar draws it. A turn starts at a user item. */
export const ChatItem = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('user'),
    id: ItemId,
    text: z.string().max(20_000),
    /** How the message was handled: the decider's verdict, or a slash command, and the model it went to. */
    route: z.strictObject({ kind: z.enum(['edit', 'question', 'plan', 'slash']), model: z.string().max(200).optional() }).optional(),
  }),
  z.strictObject({ kind: z.literal('assistant'), id: ItemId, text: z.string().max(200_000) }),
  /** One tool call in words, e.g. "Filled the Reminders flow: 7 steps". */
  z.strictObject({ kind: z.literal('activity'), id: ItemId, text: z.string().max(500), ok: z.boolean() }),
  z.strictObject({
    kind: z.literal('notice'),
    id: ItemId,
    text: z.string().max(2000),
    tone: z.enum(['info', 'error']),
    action: ChatAction.optional(),
  }),
  /** The end of a turn that changed the plan: saved as one version in history. */
  z.strictObject({
    kind: z.literal('changes'),
    id: ItemId,
    summary: z.string().max(2000),
    /** The history session it was recorded under, to open History there. */
    session: z.string().max(100).optional(),
    /** Changes that couldn't be applied, because the plan changed while the agent worked. */
    skipped: z.number().int().optional(),
    cancelled: z.boolean().optional(),
    /** Still the latest change to the plan, so Undo would reverse exactly this. */
    undoable: z.boolean().optional(),
    /** Reversed with the chat's Undo. */
    undone: z.boolean().optional(),
    /** Where the changes are on the chart. */
    reveal: Reveal.optional(),
  }),
]);
export type ChatItem = z.infer<typeof ChatItem>;

export const ChatView = z.strictObject({
  /** What stands in the way of chatting, if anything: each has one fix, shown as one button. */
  status: z.enum(['ready', 'no-folder', 'untrusted', 'no-plan', 'no-model']),
  threads: z.array(z.strictObject({ id: ItemId, title: z.string().max(200), updatedAt: z.number() })),
  current: z.strictObject({ id: ItemId, title: z.string().max(200) }).nullable(),
  items: z.array(ChatItem),
  busy: z.boolean(),
  /** The model in use, in words, e.g. "gpt-5.5 · your OpenAI key". Absent until one is set up. */
  model: z.string().max(300).optional(),
});
export type ChatView = z.infer<typeof ChatView>;

/** The plan edits the UI may ask for. */
export const UiOperation = z.enum([
  'add_feature',
  'update_feature',
  'remove_feature',
  'update_component',
  'remove_component',
  'connect_features',
  'disconnect_features',
  'add_node',
  'update_node',
  'set_status',
  'link_code',
  'remove_node',
  'add_edge',
  'remove_edge',
  'fill_flow',
]);
export type UiOperation = z.infer<typeof UiOperation>;

export const EditResult = z.strictObject({
  ok: z.boolean(),
  /** Why it was refused. */
  message: z.string().optional(),
  /** IDs of what was created. */
  created: z.record(z.string(), z.string()).optional(),
});
export type EditResult = z.infer<typeof EditResult>;

export const ModelTier = z.enum(['large', 'small']);
export type ModelTier = z.infer<typeof ModelTier>;

/** Everything the settings view shows. It says whether a key is saved, and never holds one. */
export const ModelSettingsView = z.strictObject({
  /** What's in use: "key" whenever the editor has no models, whatever was chosen before. */
  source: z.enum(['editor', 'key']),
  editorModels: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  provider: z.string(),
  providers: z.array(
    z.strictObject({
      id: z.string(),
      label: z.string(),
      keyRequired: z.boolean(),
      hasKey: z.boolean(),
      /** Suggested models, best first. */
      large: z.array(z.string()),
      small: z.array(z.string()),
    }),
  ),
  baseUrl: z.string(),
  baseUrlProblem: z.string().optional(),
  /** A saved key would travel over plain http to another machine. */
  sendsKeyInClear: z.boolean().optional(),
  large: z.string(),
  small: z.string(),
});
export type ModelSettingsView = z.infer<typeof ModelSettingsView>;

export const ModelSettingsPatch = z.strictObject({
  source: z.enum(['editor', 'key']).optional(),
  provider: z.string().max(50).optional(),
  baseUrl: z.string().max(2000).optional(),
  large: z.string().max(200).optional(),
  small: z.string().max(200).optional(),
});
export type ModelSettingsPatch = z.infer<typeof ModelSettingsPatch>;

/** The tabs of the settings view. */
export const SettingsTab = z.enum(['models']);
export type SettingsTab = z.infer<typeof SettingsTab>;

export const ModelTestResult = z.strictObject({
  tier: ModelTier,
  model: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
});
export type ModelTestResult = z.infer<typeof ModelTestResult>;

export const HostMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state'), state: AppState }),
  /** Show this level, e.g. the feature whose file was opened. */
  z.strictObject({ type: z.literal('show-level'), level: z.string() }),
  z.strictObject({ type: z.literal('edit-result'), requestId: z.number().int(), result: EditResult }),
  /** Open the history panel, at a session if one is given. */
  z.strictObject({ type: z.literal('show-history'), session: z.string().optional() }),
  /** Go to where the agent's changes are and point them out. */
  z.strictObject({ type: z.literal('reveal'), reveal: Reveal }),
  z.strictObject({ type: z.literal('show-settings'), tab: SettingsTab.optional() }),
  z.strictObject({ type: z.literal('model-settings'), view: ModelSettingsView }),
  z.strictObject({ type: z.literal('model-test-result'), results: z.array(ModelTestResult) }),
  z.strictObject({ type: z.literal('chat'), view: ChatView }),
  /** More streamed text for an assistant item, appended to what the page has. */
  z.strictObject({ type: z.literal('chat-text'), itemId: ItemId, text: z.string().max(20_000) }),
]);
export type HostMessage = z.infer<typeof HostMessage>;

export const WebviewMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('log'), level: z.enum(['info', 'warn', 'error']), message: z.string().max(2000) }),
  z.strictObject({ type: z.literal('rendered'), kind: z.enum(['no-plan', 'plan']), features: z.number(), problems: z.number() }),
  z.strictObject({
    type: z.literal('chart-rendered'),
    level: z.string(),
    nodes: z.number().int(),
    width: z.number(),
    height: z.number(),
    layoutMs: z.number(),
    workerMode: z.enum(['blob', 'main']),
  }),
  /** The level this tab is showing, for agents to read. */
  z.strictObject({ type: z.literal('level'), level: z.string().max(500) }),
  z.strictObject({ type: z.literal('edit'), requestId: z.number().int(), name: UiOperation, input: z.unknown() }),
  z.strictObject({ type: z.literal('restore'), requestId: z.number().int(), snapshotId: z.string().max(100) }),
  z.strictObject({ type: z.literal('undo'), requestId: z.number().int(), latest: z.string().max(100) }),
  z.strictObject({ type: z.literal('model-settings-get') }),
  z.strictObject({ type: z.literal('model-settings-set'), patch: ModelSettingsPatch }),
  /** Asks the host to prompt for a key, in the editor's own box. A key never comes from the page. */
  z.strictObject({ type: z.literal('model-key'), provider: z.string().max(50), action: z.enum(['set', 'remove']) }),
  z.strictObject({ type: z.literal('model-test') }),
  /** The chat page switched between the conversation and settings, so its title can follow. */
  z.strictObject({ type: z.literal('settings-shown'), shown: z.boolean() }),
  z.strictObject({ type: z.literal('init-plan') }),
  z.strictObject({ type: z.literal('open-source'), file: z.string().max(500), line: z.number().int().min(1) }),
  /** Open a card's linked file beside the chart, or show a linked folder. */
  z.strictObject({ type: z.literal('open-code'), path: z.string().max(300) }),
  /** Pick files or folders in the editor and link them to a card. */
  z.strictObject({ type: z.literal('link-code'), nodeId: z.string().max(200) }),
  /** A shared web page's light/dark switch, answered by the page itself; the editor ignores it. */
  z.strictObject({ type: z.literal('toggle-theme') }),
  z.strictObject({ type: z.literal('chat-get') }),
  z.strictObject({ type: z.literal('chat-send'), text: z.string().min(1).max(20_000) }),
  z.strictObject({ type: z.literal('chat-cancel') }),
  z.strictObject({ type: z.literal('chat-new') }),
  z.strictObject({ type: z.literal('chat-open'), id: ItemId }),
  z.strictObject({ type: z.literal('chat-action'), action: ChatAction, session: z.string().max(100).optional() }),
  z.strictObject({ type: z.literal('chat-show-changes'), reveal: Reveal }),
]);
export type WebviewMessage = z.infer<typeof WebviewMessage>;

function summarize(project: Project, extraIssues: readonly Issue[] = []): PlanSummary {
  const progress = rollup(project);
  const listed = project.map?.data?.features ?? [];
  const features = [...indexProject(project).features.entries()].map(([id, feature]) => {
    const { done, total } = progress.get(id) ?? { done: 0, total: 0 };
    const description = listed.find((f) => f.id === id)?.description;
    return { id, label: feature.label, ...(description === undefined ? {} : { description }), done, total, planned: !feature.file };
  });
  const overall = progress.get(OVERVIEW) ?? { done: 0, total: 0 };
  return {
    project: project.map?.data?.project ?? null,
    features,
    done: overall.done,
    total: overall.total,
    // A listed feature without flows is a normal stage of planning, and its row already says so.
    problems: [...validateProject(project), ...extraIssues]
      .filter((issue) => issue.code !== 'feature-without-flows')
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col),
  };
}

/** What the app shows about a plan, from its file contents, plus problems only the host can find (missing code). */
export function summarizePlan(texts: Readonly<Record<string, string>>, extraIssues: readonly Issue[] = []): PlanSummary {
  return summarize(loadFromTexts(texts), extraIssues);
}
