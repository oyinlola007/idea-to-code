// The workspace's plan, as the rest of the extension sees it: which folder, what it
// says, and (when trusted) the ProjectService behind it. Every change takes one path,
// refresh(), so the sidebar, tabs and Problems panel can't disagree.
import { buildViewModel, loadFromTexts, summarizePlan, type AppState } from '@idea-to-code/core';
import { appDataDir, HistoryStore, ProjectService, type PlanFiles } from '@idea-to-code/store';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { looksLikePlan, planFileIn } from './planPaths.js';
import type { WorkspaceTrust } from './trust.js';
import { VsCodePlanFiles } from './vscodePlanFiles.js';

const REFRESH_QUIET_MS = 150;
const SOURCE = 'idea-to-code';

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
  private readonly subscriptions: vscode.Disposable[] = [];

  state: AppState;
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly trust: WorkspaceTrust,
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

  /** Records the level being looked at, for agents. In Restricted Mode nothing is recorded. */
  async publishLevel(level: string): Promise<void> {
    try {
      await this.serviceInstance?.projectHistory?.writeView(level);
    } catch (err) {
      this.log.warn(`couldn't record the current level: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Waits for any refresh already under way. */
  settled(): Promise<void> {
    return this.queue;
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh();
    }, REFRESH_QUIET_MS);
  }

  /** Finds the plan and brings everything in line with what's on disk. Never rejects. */
  refresh(): Promise<void> {
    this.queue = this.queue
      .then(() => this.update())
      .catch((err: unknown) => {
        this.log.error(`couldn't refresh the plan: ${err instanceof Error ? err.message : String(err)}`);
      });
    return this.queue;
  }

  private async update(): Promise<void> {
    const trusted = this.trust.isTrusted;
    const folder = await this.findPlanFolder();
    if (folder?.uri.toString() !== this.folder?.uri.toString()) await this.stopService();
    this.folder = folder;
    // In Restricted Mode nothing is recorded, so opening an untrusted project leaves no trace.
    if (!folder) {
      this.diagnostics.clear();
      this.publish({ kind: 'no-plan', trusted });
      return;
    }
    const files = new VsCodePlanFiles(folder.uri);
    if (trusted && !this.serviceInstance) await this.startService(folder, files);

    const texts = await readTexts(files);
    const plan = summarizePlan(texts);
    this.showDiagnostics(folder, plan.problems);
    this.publish({ kind: 'plan', trusted, folder: folder.name, plan, model: buildViewModel(loadFromTexts(texts)) });
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
    this.changed.dispose();
  }
}
