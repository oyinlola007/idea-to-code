// Writes the Toolshed plan as a shared web page, for checking the export in real browsers.
// Usage: pnpm --filter idea-to-code exec tsx scripts/export-sample.ts <out.html>
import { sharedState } from '@idea-to-code/core';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedPageHtml } from '../src/sharedPage.js';

const FIXTURE = fileURLToPath(new URL('../../core/test/fixtures/toolshed/plan', import.meta.url));
const WEBVIEW = fileURLToPath(new URL('../dist/webview', import.meta.url));
const texts: Record<string, string> = { 'plan/map.yaml': await readFile(join(FIXTURE, 'map.yaml'), 'utf8') };
for (const name of await readdir(join(FIXTURE, 'features')))
  texts[`plan/features/${name}`] = await readFile(join(FIXTURE, 'features', name), 'utf8');
const html = sharedPageHtml({
  title: 'Toolshed',
  state: sharedState(texts, 'toolshed'),
  script: await readFile(join(WEBVIEW, 'webview.js'), 'utf8'),
  style: await readFile(join(WEBVIEW, 'style.css'), 'utf8'),
  font: await readFile(join(WEBVIEW, 'codicon.ttf')),
});
await writeFile(process.argv[2] ?? 'toolshed-plan.html', html);
console.log(`wrote ${String(html.length)} characters`);
