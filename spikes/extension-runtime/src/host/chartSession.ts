// One webview showing one plan: loads it, posts the view model, reloads on
// save, and handles what the webview asks for. Shared by the app tab and the
// custom editor.
import { appendFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as vscode from 'vscode';
import { loadProject } from '../../../format/src/load.js';
import { HostToView, ViewToHost, WorkerSetting } from '../shared/messages.js';
import { buildViewModel } from './viewModel.js';
import { webviewRoot } from './webviewHtml.js';

type Rendered = Extract<ViewToHost, { type: 'rendered' }>;
type WorkerFailed = Extract<ViewToHost, { type: 'workerFailed' }>;
type ThemeVars = Extract<ViewToHost, { type: 'themeVars' }>;

/** Events from every chart, for the runtime report and the in-editor tests. */
export const chartEvents = {
  rendered: new vscode.EventEmitter<Rendered & { session: string }>(),
  workerFailed: new vscode.EventEmitter<WorkerFailed & { session: string }>(),
  themeVars: new vscode.EventEmitter<ThemeVars & { session: string }>(),
  planChanged: new vscode.EventEmitter<string>(),
};

const sessions = new Set<ChartSession>();
export const allSessions = () => [...sessions];

export class ChartSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  lastRendered: Rendered | undefined;

  constructor(
    readonly name: string,
    private readonly webview: vscode.Webview,
    private readonly root: string,
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    private start?: string,
  ) {
    sessions.add(this);
    this.disposables.push(webview.onDidReceiveMessage((raw) => this.receive(raw)));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'plan/**/*.yaml'));
    const changed = () => this.scheduleReload();
    this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
  }

  post(msg: HostToView) {
    void this.webview.postMessage(HostToView.parse(msg));
  }

  navigate(level: string) {
    this.post({ type: 'navigate', level });
  }

  private scheduleReload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      chartEvents.planChanged.fire(this.root);
      void this.sendModel();
    }, 300);
  }

  private async sendModel() {
    try {
      const model = buildViewModel(await loadProject(this.root));
      this.post({ type: 'model', model, ...(this.start ? { start: this.start } : {}) });
      this.start = undefined;
    } catch (err) {
      this.log.error(`could not load the plan at ${this.root}: ${(err as Error).message}`);
    }
  }

  private async receive(raw: unknown) {
    // In the in-editor test runs, keep a transcript of what each webview says.
    const dir = process.env.ITC_RESULTS_DIR;
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `messages-${process.env.ITC_TARGET ?? 'x'}.log`), `${this.name} ${JSON.stringify(raw).slice(0, 400)}\n`);
      } catch {
        // diagnostics only
      }
    }
    const parsed = ViewToHost.safeParse(raw);
    if (!parsed.success) {
      this.log.warn(`dropped an invalid message from the webview: ${parsed.error.message}`);
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'ready': {
        const setting = vscode.workspace.getConfiguration('ideaToCode.spike').get<string>('workerMode');
        const workerMode = WorkerSetting.safeParse(setting).data ?? 'auto';
        const workerUrl = this.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot(this.extensionUri), 'elk-worker.min.js')).toString();
        this.post({ type: 'config', workerMode, workerUrl });
        await this.sendModel();
        break;
      }
      case 'rendered':
        this.lastRendered = msg;
        this.log.info(`[${this.name}] rendered ${msg.level}: ${msg.nodes} nodes in ${msg.layoutMs.toFixed(0)}ms via ${msg.workerMode} worker`);
        chartEvents.rendered.fire({ ...msg, session: this.name });
        break;
      case 'workerFailed':
        this.log.warn(`[${this.name}] worker mode ${msg.mode} failed: ${msg.error}`);
        chartEvents.workerFailed.fire({ ...msg, session: this.name });
        break;
      case 'themeVars':
        chartEvents.themeVars.fire({ ...msg, session: this.name });
        break;
      case 'openSource':
        await this.openSource(msg.file, msg.line);
        break;
      case 'level':
        break;
      case 'log':
        this.log[msg.level](`[webview ${this.name}] ${msg.message}`);
        break;
    }
  }

  private async openSource(file: string, line: number) {
    const planDir = join(this.root, 'plan');
    const target = resolve(this.root, file);
    const rel = relative(planDir, target);
    if (isAbsolute(file) || rel.startsWith('..') || isAbsolute(rel)) {
      this.log.warn(`refused to open ${file}: outside the plan folder`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const at = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(at, at) });
  }

  dispose() {
    clearTimeout(this.reloadTimer);
    sessions.delete(this);
    for (const d of this.disposables) d.dispose();
  }
}
