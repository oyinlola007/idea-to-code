// The activity bar's "Plan" view: an entry to open the chart, then the
// features with their progress.
import * as vscode from 'vscode';
import { loadProject } from '../../../format/src/load.js';
import type { VNode } from '../shared/viewModel.js';
import { chartEvents } from './chartSession.js';
import { planRoot } from './planRoot.js';
import { buildViewModel } from './viewModel.js';

type Item = { kind: 'open' } | { kind: 'feature'; node: VNode };

export class PlanTree implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh() {
    this.changed.fire();
  }

  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === 'open') {
      const t = new vscode.TreeItem('Open Plan');
      t.iconPath = new vscode.ThemeIcon('type-hierarchy');
      t.command = { command: 'ideaToCode.openPlan', title: 'Open Plan' };
      return t;
    }
    const { node } = item;
    const t = new vscode.TreeItem(node.label);
    const p = node.progress;
    if (node.planned) t.description = 'not planned yet';
    else if (p) t.description = p.total ? `${p.done}/${p.total}` : 'no steps yet';
    const done = p && p.total > 0 && p.done === p.total;
    t.iconPath = new vscode.ThemeIcon(done ? 'pass-filled' : node.planned ? 'circle-large-outline' : 'circle-large');
    t.tooltip = node.description ?? node.label;
    t.command = { command: 'ideaToCode.openPlan', title: 'Open', arguments: [node.opens ?? 'overview'] };
    return t;
  }

  async getChildren(item?: Item): Promise<Item[]> {
    if (item) return [];
    const root = planRoot();
    if (!root) return [];
    const model = buildViewModel(await loadProject(root));
    const features = (model.levels.overview?.nodes ?? []).filter((n) => n.kind === 'feature');
    return [{ kind: 'open' }, ...features.map((node) => ({ kind: 'feature' as const, node }))];
  }
}

export function registerSidebar(): vscode.Disposable[] {
  const tree = new PlanTree();
  const root = planRoot();
  const disposables: vscode.Disposable[] = [vscode.window.registerTreeDataProvider('ideaToCode.features', tree), chartEvents.planChanged.event(() => tree.refresh())];
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'plan/**/*.yaml'));
    disposables.push(watcher, watcher.onDidChange(() => tree.refresh()), watcher.onDidCreate(() => tree.refresh()), watcher.onDidDelete(() => tree.refresh()));
  }
  return disposables;
}
