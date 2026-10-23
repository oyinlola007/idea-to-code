// Screenshots of every level × theme, rendered by the real webview bundle in
// a browser harness with theme variables captured from VS Code (out/themes,
// written by the in-editor suite). Usage:
//   npm run screenshots -- [--only <level>] [--theme dark] [--out <dir>]
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { loadProject } from '../../format/src/load.js';
import { buildViewModel } from '../src/host/viewModel.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'out', 'webview');
const THEMES = join(ROOT, 'out', 'themes');

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    theme: { type: 'string' },
    out: { type: 'string', default: join(ROOT, '..', '..', 'docs', 'spikes', 'runtime-screens') },
    fixture: { type: 'string', default: join(ROOT, '..', 'format', 'fixtures', 'career-app') },
    select: { type: 'string' },
    width: { type: 'string', default: '960' },
    // Press a key after the level renders, then capture at a fixed laptop height (e.g. Escape).
    press: { type: 'string' },
    height: { type: 'string', default: '760' },
  },
});

// Used only until the in-editor suite has captured the real variables.
const FALLBACK: Record<string, { bodyClass: string; vars: Record<string, string> }> = {
  dark: {
    bodyClass: 'vscode-dark',
    vars: {
      '--vscode-font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
      '--vscode-editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-descriptionForeground': '#9d9d9d',
      '--vscode-focusBorder': '#0078d4',
      '--vscode-textLink-foreground': '#4daafc',
      '--vscode-charts-green': '#89d185',
      '--vscode-charts-yellow': '#cca700',
      '--vscode-editorWidget-background': '#202020',
      '--vscode-widget-border': '#313131',
      '--vscode-editorWidget-border': '#454545',
      '--vscode-editorLineNumber-foreground': '#6e7681',
      '--vscode-toolbar-hoverBackground': 'rgba(90, 93, 94, 0.31)',
      '--vscode-button-background': '#0078d4',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-button-hoverBackground': '#026ec1',
      '--vscode-button-secondaryBackground': '#313131',
      '--vscode-button-secondaryForeground': '#cccccc',
      '--vscode-icon-foreground': '#cccccc',
      '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.36)',
    },
  },
  light: {
    bodyClass: 'vscode-light',
    vars: {
      '--vscode-font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
      '--vscode-editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-descriptionForeground': '#616161',
      '--vscode-focusBorder': '#005fb8',
      '--vscode-textLink-foreground': '#005fb8',
      '--vscode-charts-green': '#388a34',
      '--vscode-charts-yellow': '#bf8803',
      '--vscode-editorWidget-background': '#f8f8f8',
      '--vscode-widget-border': '#e5e5e5',
      '--vscode-editorWidget-border': '#c8c8c8',
      '--vscode-editorLineNumber-foreground': '#6e7681',
      '--vscode-toolbar-hoverBackground': 'rgba(184, 184, 184, 0.31)',
      '--vscode-button-background': '#005fb8',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-button-hoverBackground': '#0258a8',
      '--vscode-button-secondaryBackground': '#e5e5e5',
      '--vscode-button-secondaryForeground': '#3b3b3b',
      '--vscode-icon-foreground': '#3b3b3b',
      '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.16)',
    },
  },
};

async function themes(): Promise<string[]> {
  const found: string[] = [];
  if (existsSync(THEMES)) {
    for (const f of await readdir(THEMES)) {
      if (!f.endsWith('.json')) continue;
      const name = f.replace(/\.json$/, '');
      await writeFile(join(WEB, `theme-${name}.json`), await readFile(join(THEMES, f)));
      found.push(name);
    }
  }
  for (const [name, theme] of Object.entries(FALLBACK)) {
    if (found.includes(name)) continue;
    await writeFile(join(WEB, `theme-${name}.json`), JSON.stringify(theme));
    found.push(name);
    console.warn(`theme ${name}: using fallback colours (run the in-editor suite with --themes to capture the real ones)`);
  }
  return found.sort();
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf' };

function serve(): Promise<{ url: string; close: () => void }> {
  const server = createServer(async (req, res) => {
    const path = resolve(WEB, `.${decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)}`);
    if (!path.startsWith(WEB)) return void res.writeHead(403).end();
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() })));
}

async function main() {
  const model = buildViewModel(await loadProject(values.fixture!));
  await writeFile(join(WEB, 'fixture-model.json'), JSON.stringify(model));
  const names = values.theme ? [values.theme] : await themes();
  if (values.theme) await themes();
  const levels = values.only ? [values.only] : Object.keys(model.levels);
  await mkdir(values.out!, { recursive: true });

  const { url, close } = await serve();
  const browser = await chromium.launch({ channel: 'chrome' });
  const width = Number(values.width);
  try {
    for (const theme of names) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme.includes('light') ? 'light' : 'dark' });
      page.on('pageerror', (e) => console.error(`[${theme}] page error: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.error(`[${theme}] console ${m.type()}: ${m.text()}`);
      });
      for (const level of levels) {
        const q = new URLSearchParams({ level, theme, ...(values.select ? { select: values.select } : {}) });
        await page.goto(`${url}/harness.html?${q}`);
        const info = (await page.evaluate(
          () =>
            Promise.race([
              (window as unknown as { __rendered: Promise<unknown> }).__rendered,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`no rendered message; sent: ${JSON.stringify((window as unknown as { __sent: { type: string }[] }).__sent.map((m) => m.type === 'log' || m.type === 'workerFailed' ? m : m.type))}`)), 15_000),
              ),
            ]),
        )) as { height: number; width: number };
        if (values.press) {
          await page.setViewportSize({ width, height: Number(values.height) });
          await page.waitForTimeout(500);
          await page.keyboard.press(values.press);
          await page.waitForTimeout(1200);
          const file = join(values.out!, `${level}--${theme}--after-${values.press}.png`);
          await page.screenshot({ path: file });
          console.log(file);
          continue;
        }
        // Grow the window to the whole level (it grows downward at fit-width).
        const zoom = Math.min(1, (width - 64) / Math.max(info.width, 1));
        const height = Math.min(4000, Math.max(560, Math.ceil(info.height * zoom + 40 + 64 + (model.levels[level]?.description ? 30 : 0))));
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(700);
        const file = join(values.out!, `${level}--${theme}${values.select ? `--${values.select}` : ''}.png`);
        await page.screenshot({ path: file });
        console.log(`${file} (${info.width}×${info.height})`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    close();
  }
}

await main();
