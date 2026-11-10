// "Export as Web Page" in the real editor: one self-contained file with the plan in it.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import { check, sleep, step } from './helpers.js';

export async function exportPageSteps(api: ExtensionApi, root: string): Promise<void> {
  await step('Export as Web Page writes one self-contained page of the plan', async () => {
    const target = vscode.Uri.file(join(await mkdtemp(join(tmpdir(), 'itc-share-')), 'toolshed-plan.html'));
    const saved = await api.exportWebPage(target);
    check(saved?.fsPath === target.fsPath, `saved to ${saved?.fsPath ?? 'nowhere'}`);
    const html = await readFile(target.fsPath, 'utf8');
    check(html.includes('<title>Toolshed</title>'), 'no title');
    check(html.includes('"readOnly":true'), 'not read-only');
    check(html.includes('Browse tools nearby'), 'the plan is missing');
    check(!/(src|href)="(https?:|\.\/)/.test(html), 'it loads something from outside');
    check(html.includes('url(data:font/ttf;base64,'), 'the icon font is missing');
    check(html.length > 1_000_000, `only ${String(html.length)} characters: the app is missing`);
  });

  await step('Export from a plan file’s menu never saves over the plan file', async () => {
    const map = vscode.Uri.file(join(root, 'plan', 'map.yaml'));
    const before = await readFile(map.fsPath, 'utf8');
    // As the tab's … menu runs it: with the tab's own address.
    const running = vscode.commands.executeCommand<vscode.Uri | undefined>('ideaToCode.exportWebPage', map);
    await sleep(1500);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    check((await running) === undefined, 'it saved without asking');
    check((await readFile(map.fsPath, 'utf8')) === before, 'plan/map.yaml changed');
  });
}
