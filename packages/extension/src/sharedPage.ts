// A plan as one web page anyone can open: the chart's own bundle, styles and icons,
// and the plan as data, all inside a single .html file that works offline and on any
// host. A small stand-in for the editor answers the page's requests: the plan, read-only.
// Pure, so it's tested without VS Code.
import type { AppState } from '@idea-to-code/core';
import { createHash } from 'node:crypto';
import { SHARED_THEME_CSS } from './sharedTheme.js';

export interface SharedPageParts {
  title: string;
  state: AppState;
  /** The chart bundle (dist/webview/webview.js). */
  script: string;
  /** Its styles (dist/webview/style.css). */
  style: string;
  /** The icon font (dist/webview/codicon.ttf). */
  font: Uint8Array;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plan text in a script tag can't end it early or open markup. */
const asData = (state: AppState) => JSON.stringify(state).replace(/</g, '\\u003c');

const hash = (code: string) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`;

/**
 * Stands in for the editor: answers "ready" with the plan and keeps the page's state in memory.
 * It follows the reader's light or dark setting until they switch, and remembers the switch
 * where the browser allows it.
 */
const HOST = `(() => {
  const state = JSON.parse(document.getElementById('plan').textContent);
  const root = document.documentElement;
  const KEY = 'idea-to-code-theme';
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const theme = () => {
    const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : dark.matches;
    document.body.classList.toggle('vscode-dark', isDark);
    document.body.classList.toggle('vscode-light', !isDark);
  };
  try {
    const chosen = localStorage.getItem(KEY);
    if (chosen === 'light' || chosen === 'dark') root.dataset.theme = chosen;
  } catch {}
  let saved;
  window.__vscode = {
    postMessage(message) {
      if (message && message.type === 'ready') setTimeout(() => window.postMessage({ type: 'state', state }, '*'));
      if (message && message.type === 'toggle-theme') {
        root.dataset.theme = document.body.classList.contains('vscode-dark') ? 'light' : 'dark';
        try { localStorage.setItem(KEY, root.dataset.theme); } catch {}
        theme();
      }
    },
    getState: () => saved,
    setState: (value) => { saved = value; },
  };
  theme();
  dark.addEventListener('change', theme);
})();`;

export function sharedPageHtml(parts: SharedPageParts): string {
  const font = `url(data:font/ttf;base64,${Buffer.from(parts.font).toString('base64')})`;
  const style = parts.style.replace(/url\(\.\/codicon\.ttf[^)]*\)/g, font);
  // A closing script tag inside the bundle would end its block early.
  const script = parts.script.replace(/<\/script/gi, '<\\/script');
  const csp = [
    "default-src 'none'",
    `script-src ${hash(HOST)} ${hash(script)}`,
    "style-src 'unsafe-inline'",
    'font-src data:',
    'img-src data:',
    'worker-src blob:',
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="idea-to-code">
<title>${escapeHtml(parts.title)}</title>
<style>${SHARED_THEME_CSS}</style>
<style>${style}</style>
</head>
<body data-view="app">
<div id="root"></div>
<script type="application/json" id="plan">${asData(parts.state)}</script>
<script>${HOST}</script>
<script type="module">${script}</script>
</body>
</html>
`;
}
