// The workspace's plan, as the rest of the extension sees it: which folder, what it
// says, and (when trusted) the ProjectService behind it. Every change takes one path,
// refresh(), so the sidebar, tabs and Problems panel can't disagree.
import {
  buildViewModel,
  loadFromTexts,
  summarizePlan,
  type AppState,
  type EditResult,
  type HistoryView,
  type Reveal,
  type UiOperation,
} from '@idea-to-code/core';
import { appDataDir, buildHistoryView, HistoryStore, ProjectService, type PlanFiles, type RestoreResult } from '@idea-to-code/store';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { ModelHost } from './models/modelHost.js';
import { OutsideEdits } from './outsideEdits.js';
import { looksLikePlan, planFileIn } from './planPaths.js';
import type { WorkspaceTrust } from './trust.js';
import { VsCodePlanFiles } from './vscodePlanFiles.js';

const REFRESH_QUIET_MS = 150;
const SOURCE = 'idea-to-code';
const BUSY = 'The built-in agent is working. Edits wait until it finishes.';

async function readTexts(files: PlanFiles): Promise<Record<string, string>> {
  const texts: Record<string, string> = {};
  for (const path of await files.listPlanFiles()) {
    const content = await files.read(path);
    if (content !== null) texts[path] = content;
  }
  return texts;
}

export class ProjectHost implements vscode.Disposable {
  private folder: vscode.WorkspaceFolder | undefined;
  private serviceInstance: ProjectService | undefined;
  private stopEvents: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  private readonly changed = new vscode.EventEmitter<AppState>();
  private readonly revealed = new vscode.EventEmitter<Reveal>();
  private readonly outside = new OutsideEdits((reveal) => {
    this.revealed.fire(reveal);
  });
  /** The refresh waiting to run follows a change made here, which isn't pointed out. */
  private pendingOwn = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  state: AppState;
  readonly onDidChange = this.changed.event;
  /** Where changes made outside this editor are, once they pause. */
  readonly onDidReveal = this.revealed.event;
  /** The level the user last looked at, for the built-in agent. */
  currentLevel = 'overview';
  /** The agent's changes so far in a turn, shown on the chart before they're written. */
  private preview: Record<string, string> | null = null;
  private agentBusy = false;

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly trust: WorkspaceTrust,
    readonly models: ModelHost,
  ) {
    this.state = { kind: 'no-plan', trusted: trust.isTrusted };
    const watcher = vscode.workspace.createFileSystemWatcher('**/plan/**/*.yaml');
    const later = () => {
      this.scheduleRefresh();
    };
    this.subscriptions.push(
      watcher,
      watcher.onDidChange(later),
      watcher.onDidCreate(later),
      watcher.onDidDelete(later),
      vscode.workspace.onDidChangeWorkspaceFolders(later),
      // A plan file the user saved from the editor they're typing in is their own change.
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.planFile(document.uri) !== undefined && vscode.window.activeTextEditor?.document === document) this.scheduleRefresh(true);
      }),
      // Trusting the folder turns everything on, without reopening it.
      trust.onDidGrant(later),
    );
  }

  get service(): ProjectService | undefined {
    return this.serviceInstance;
  }

  get activeFolder(): vscode.WorkspaceFolder | undefined {
    return this.folder;
  }

  /** The file's path in the active plan, if it belongs to it. */
  planFile(uri: vscode.Uri): string | undefined {
    if (this.folder?.uri.scheme !== uri.scheme) return undefined;
    return planFileIn(this.folder.uri.path, uri.path);
  }

  /** One edit from the UI, recorded in history. The chart has the result by the time this answers. */
  async applyEdit(name: UiOperation, input: unknown): Promise<EditResult> {
    if (!this.trust.isTrusted || !this.serviceInstance) return { ok: false, message: 'This plan is view-only until you trust the folder.' };
    if (this.agentBusy) return { ok: false, message: BUSY };
    const result = await this.serviceInstance.apply({ name, input }, { source: 'ui', actor: 'user' });
    await this.refresh(true);
    return result.ok ? { ok: true, created: result.created } : { ok: false, message: result.message };
  }

  /** Brings back an earlier version, as a new version. */
  restoreVersion(snapshotId: string): Promise<EditResult> {
    return this.restoring((service) => service.rollback(snapshotId, { actor: 'user' }));
  }

  /** Reverses the change the user was told about, which `latest` names. */
  undo(latest: string): Promise<EditResult> {
    return this.restoring((service) => service.undo({ actor: 'user', expectedLatest: latest }));
  }

  private async restoring(run: (service: ProjectService) => Promise<RestoreResult>): Promise<EditResult> {
    if (!this.trust.isTrusted || !this.serviceInstance) return { ok: false, message: 'This plan is view-only until you trust the folder.' };
    if (this.agentBusy) return { ok: false, message: BUSY };
    const result = await run(this.serviceInstance);
    await this.refresh(true);
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  /** Records the level being looked at, for agents. In Restricted Mode nothing is recorded. */
  async publishLevel(level: string): Promise<void> {
    this.currentLevel = level;
    try {
      await this.serviceInstance?.projectHistory?.writeView(level);
    } catch (err) {
      this.log.warn(`couldn't record the current level: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** While the agent works, edits from the chart and history wait; navigation doesn't. */
  setAgentBusy(busy: boolean): void {
    this.agentBusy = busy;
    void this.refresh();
  }

  /** Shows the agent's changes so far on the chart, or (null) the files again. */
  setPreview(texts: Record<string, string> | null): void {
    this.preview = texts;
    void this.refresh();
  }

  /** Waits for any refresh already under way. */
  settled(): Promise<void> {
    return this.queue;
  }

  private scheduleRefresh(own = false): void {
    this.pendingOwn ||= own;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const ownChange = this.pendingOwn;
      this.pendingOwn = false;
      void this.refresh(ownChange);
    }, REFRESH_QUIET_MS);
  }

  /**
   * Finds the plan and brings everything in line with what's on disk. Never rejects.
   * `own` says the change was made here; while the built-in agent works, every change is its own.
   */
  refresh(own = false): Promise<void> {
    const ownChange = own || this.agentBusy || this.preview !== null;
    this.queue = this.queue
      .then(() => this.update(ownChange))
      .catch((err: unknown) => {
        this.log.error(`couldn't refresh the plan: ${err instanceof Error ? err.message : String(err)}`);
      });
    return this.queue;
  }

  private async update(own: boolean): Promise<void> {
    const trusted = this.trust.isTrusted;
    const folder = await this.findPlanFolder();
    if (folder?.uri.toString() !== this.folder?.uri.toString()) await this.stopService();
    this.folder = folder;
    // In Restricted Mode nothing is recorded, so opening an untrusted project leaves no trace.
    if (!folder) {
      this.outside.reset();
      this.diagnostics.clear();
      this.publish({ kind: 'no-plan', trusted });
      return;
    }
    const files = new VsCodePlanFiles(folder.uri);
    if (trusted && !this.serviceInstance) await this.startService(folder, files);

    const disk = await readTexts(files);
    this.outside.seen(disk, own);
    // Problems are about the files; the chart shows the agent's preview while it works.
    this.showDiagnostics(folder, summarizePlan(disk).problems);
    const texts = this.preview ?? disk;
    const history = await this.readHistory();
    this.publish({
      kind: 'plan',
      trusted,
      folder: folder.name,
      plan: summarizePlan(texts),
      model: buildViewModel(loadFromTexts(texts)),
      history,
      ...(this.agentBusy ? { agentBusy: true } : {}),
    });
  }

  /** Null in Restricted Mode. A history that can't be read says so, and the plan still shows. */
  private async readHistory(): Promise<HistoryView | null> {
    if (!this.serviceInstance) return null;
    const empty = { sessions: [], older: 0, undo: null };
    const history = this.serviceInstance.projectHistory;
    if (!history) return { ...empty, problem: "History isn't available for this plan right now." };
    try {
      return buildHistoryView(await history.listSessions(), await history.listSnapshots());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`couldn't read history: ${message}`);
      return { ...empty, problem: `History couldn't be read: ${message}` };
    }
  }

  /** Only the first folder with a plan is used. */
  private async findPlanFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (looksLikePlan(await new VsCodePlanFiles(folder.uri).read('plan/map.yaml'))) return folder;
    }
    return undefined;
  }

  private async startService(folder: vscode.WorkspaceFolder, files: VsCodePlanFiles): Promise<void> {
    const store = new HistoryStore(appDataDir({ platform: process.platform, env: process.env, home: homedir() }));
    const service = await ProjectService.open({ files, store, root: folder.uri.fsPath });
    this.stopEvents = service.onEvent((event) => {
      if (event.type === 'warning') this.log.warn(event.message);
      else this.scheduleRefresh();
    });
    service.startWatching();
    this.serviceInstance = service;
    const { status, previousPath } = service.openStatus;
    this.log.info(`plan history for ${folder.name}: ${status}${previousPath ? `, moved from ${previousPath}` : ''}`);
  }

  private async stopService(): Promise<void> {
    this.outside.reset();
    this.stopEvents?.();
    this.stopEvents = undefined;
    await this.serviceInstance?.dispose();
    this.serviceInstance = undefined;
  }

  private showDiagnostics(
    folder: vscode.WorkspaceFolder,
    problems: { file: string; line: number; col: number; severity: 'error' | 'warning'; code: string; message: string }[],
  ): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const problem of problems) {
      const line = Math.max(problem.line - 1, 0);
      const col = Math.max(problem.col - 1, 0);
      const severity = problem.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      // The editor trims the range to the line's real length.
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1000), problem.message, severity);
      diagnostic.source = SOURCE;
      diagnostic.code = problem.code;
      byFile.set(problem.file, [...(byFile.get(problem.file) ?? []), diagnostic]);
    }
    this.diagnostics.clear();
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.joinPath(folder.uri, ...file.split('/')), list);
  }

  private publish(state: AppState): void {
    this.state = state;
    void vscode.commands.executeCommand('setContext', 'ideaToCode.hasPlan', state.kind === 'plan');
    this.changed.fire(state);
  }

  dispose(): void {
    clearTimeout(this.timer);
    void this.stopService();
    for (const s of this.subscriptions) s.dispose();
    this.diagnostics.dispose();
    this.outside.dispose();
    this.changed.dispose();
    this.revealed.dispose();
  }
}
