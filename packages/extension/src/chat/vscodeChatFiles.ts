// Chat files in the editor's storage for this workspace (ExtensionContext.storageUri),
// through VS Code's file API. Paths come only from ChatStore, never from a page.
import * as vscode from 'vscode';
import type { ChatFiles } from './transcript.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class VsCodeChatFiles implements ChatFiles {
  constructor(private readonly root: vscode.Uri) {}

  private uri(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...path.split('/'));
  }

  async read(path: string): Promise<string | null> {
    try {
      return decoder.decode(await vscode.workspace.fs.readFile(this.uri(path)));
    } catch {
      return null;
    }
  }

  async write(path: string, text: string): Promise<void> {
    const uri = this.uri(path);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
  }

  async append(path: string, text: string): Promise<void> {
    await this.write(path, ((await this.read(path)) ?? '') + text);
  }
}
