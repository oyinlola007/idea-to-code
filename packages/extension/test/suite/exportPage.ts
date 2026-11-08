// "Export as Web Page" in the real editor: one self-contained file with the plan in it.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { check, step } from './helpers.js';

export async function exportPageSteps(): Promise<void> {
  await step('Export as Web Page writes one self-contained page of the plan', async () => {
    const target = vscode.Uri.file(join(await mkdtemp(join(tmpdir(), 'itc-share-')), 'toolshed-plan.html'));
    const saved = await vscode.commands.executeCommand<vscode.Uri | undefined>('ideaToCode.exportWebPage', target);
    check(saved?.fsPath === target.fsPath, `saved to ${saved?.fsPath ?? 'nowhere'}`);
    const html = await readFile(target.fsPath, 'utf8');
    check(html.includes('<title>Toolshed</title>'), 'no title');
    check(html.includes('"readOnly":true'), 'not read-only');
    check(html.includes('Browse tools nearby'), 'the plan is missing');
    check(!/(src|href)="(https?:|\.\/)/.test(html), 'it loads something from outside');
    check(html.includes('url(data:font/ttf;base64,'), 'the icon font is missing');
    check(html.length > 1_000_000, `only ${String(html.length)} characters: the app is missing`);
  });
}
