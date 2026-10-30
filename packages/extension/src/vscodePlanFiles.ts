// PlanFiles on VS Code's file API, so remote and virtual workspaces work too.
// Exercised inside a real editor from ITC-9 on.
import { checkProjectPath, UnsafePathError, type PlanFiles } from '@idea-to-code/store';
import * as vscode from 'vscode';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class VsCodePlanFiles implements PlanFiles {
  constructor(private readonly root: vscode.Uri) {}

  private uri(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...path.split('/'));
  }

  async listPlanFiles(): Promise<string[]> {
    const paths: string[] = [];
    if ((await this.read('plan/map.yaml')) !== null) paths.push('plan/map.yaml');
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.uri('plan/features'));
    } catch {
      // No features folder yet.
    }
    const names = entries.filter(([name, type]) => name.endsWith('.yaml') && (type & vscode.FileType.File) !== 0).map(([name]) => name);
    for (const name of names.sort()) paths.push(`plan/features/${name}`);
    return paths;
  }

  async read(path: string): Promise<string | null> {
    try {
      return decoder.decode(await vscode.workspace.fs.readFile(this.uri(path)));
    } catch {
      return null;
    }
  }

  /** A symlink inside the project could point anywhere, so refuse any along the way. */
  private async checkNoSymlinks(path: string): Promise<void> {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      try {
        const { type } = await vscode.workspace.fs.stat(this.uri(folder));
        if ((type & vscode.FileType.SymbolicLink) !== 0) throw new UnsafePathError(path, `${folder} is a symbolic link`);
      } catch (err) {
        if (err instanceof UnsafePathError) throw err;
        return; // Doesn't exist yet, so nothing further along exists either.
      }
    }
  }

  async write(path: string, content: string): Promise<void> {
    checkProjectPath(path);
    await this.checkNoSymlinks(path);
    const target = this.uri(path);
    const temp = this.uri(`${path}.tmp-${crypto.randomUUID()}`);
    await vscode.workspace.fs.writeFile(temp, encoder.encode(content));
    try {
      await vscode.workspace.fs.rename(temp, target, { overwrite: true });
    } catch (err) {
      await vscode.workspace.fs.delete(temp).then(undefined, () => undefined);
      throw err;
    }
  }

  async remove(path: string): Promise<void> {
    checkProjectPath(path);
    await this.checkNoSymlinks(path);
    try {
      await vscode.workspace.fs.delete(this.uri(path));
    } catch (err) {
      if (!(err instanceof vscode.FileSystemError) || err.code !== 'FileNotFound') throw err;
    }
  }

  watch(onChange: () => void): () => void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, 'plan/**/*.yaml'));
    const subscriptions = [watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange)];
    return () => {
      for (const s of subscriptions) s.dispose();
    };
  }
}
