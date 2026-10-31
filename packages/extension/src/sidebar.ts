// The activity bar's views: the plan's features with their progress, and its sessions.
import type { AppState, HistorySession } from '@idea-to-code/core';
import * as vscode from 'vscode';
import type { ProjectHost } from './projectHost.js';

type Feature = Extract<AppState, { kind: 'plan' }>['plan']['features'][number];

export class FeatureTree implements vscode.TreeDataProvider<Feature> {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly host: ProjectHost) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(feature: Feature): vscode.TreeItem {
    const item = new vscode.TreeItem(feature.label);
    const finished = feature.total > 0 && feature.done === feature.total;
    const started = feature.done > 0;
    item.description = feature.planned
      ? 'not planned yet'
      : feature.total > 0
        ? `${String(feature.done)}/${String(feature.total)}`
        : 'no steps yet';
    item.iconPath = new vscode.ThemeIcon(finished ? 'pass-filled' : started ? 'circle-large-filled' : 'circle-large-outline');
    item.tooltip = feature.description ?? feature.label;
    item.command = { command: 'ideaToCode.openApp', title: 'Open Plan' };
    return item;
  }

  getChildren(parent?: Feature): Feature[] {
    return !parent && this.host.state.kind === 'plan' ? this.host.state.plan.features : [];
  }
}

export class SessionTree implements vscode.TreeDataProvider<HistorySession> {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly host: ProjectHost) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(session: HistorySession): vscode.TreeItem {
    const item = new vscode.TreeItem(session.title);
    const count = session.entries.length;
    const when = new Date(session.openedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    item.description = `${String(count)} change${count === 1 ? '' : 's'} · ${when}`;
    item.iconPath = new vscode.ThemeIcon(session.kind === 'chat' ? 'comment-discussion' : 'history');
    item.tooltip = session.entries[0]?.summary ?? session.title;
    item.command = { command: 'ideaToCode.showHistory', title: 'Show in History', arguments: [session.id] };
    return item;
  }

  getChildren(parent?: HistorySession): HistorySession[] {
    const { state } = this.host;
    return !parent && state.kind === 'plan' ? (state.history?.sessions ?? []) : [];
  }
}

export function registerSidebar(host: ProjectHost, trees: { features: FeatureTree; sessions: SessionTree }): vscode.Disposable {
  const featureView = vscode.window.createTreeView('ideaToCode.features', { treeDataProvider: trees.features });
  const sessionView = vscode.window.createTreeView('ideaToCode.sessions', { treeDataProvider: trees.sessions });
  return vscode.Disposable.from(
    featureView,
    sessionView,
    host.onDidChange((state) => {
      // With several folders, say which one's plan this is.
      featureView.description = state.kind === 'plan' ? state.folder : undefined;
      trees.features.refresh();
      trees.sessions.refresh();
    }),
  );
}
