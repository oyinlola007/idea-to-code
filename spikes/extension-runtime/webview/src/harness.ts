// A stand-in for the extension host, so the same webview bundle can run in a
// plain browser for screenshots. It loads a view model and a captured set of
// VS Code theme variables, then talks to the app like the host would.
// Query: ?level=<id>&select=<nodeId>&theme=<name>
import type { HostToView, ViewToHost } from '../../src/shared/messages';
import { start } from './main';

interface Theme {
  bodyClass: string;
  vars: Record<string, string>;
}

const params = new URLSearchParams(location.search);
let state: unknown;
let resolveRendered: (v: unknown) => void = () => {};
const rendered = new Promise((r) => (resolveRendered = r));
const sent: ViewToHost[] = [];

function deliver(msg: HostToView) {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

async function onReady() {
  const theme = (await (await fetch(`./theme-${params.get('theme') ?? 'dark'}.json`)).json()) as Theme;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  document.body.className = theme.bodyClass;
  const model = await (await fetch('./fixture-model.json')).json();
  deliver({ type: 'config', workerMode: 'blob', workerUrl: './elk-worker.min.js' });
  deliver({ type: 'model', model, start: params.get('level') ?? 'overview' });
}

window.__harnessApi = {
  postMessage(msg: unknown) {
    const m = msg as ViewToHost;
    sent.push(m);
    if (m.type === 'ready') void onReady();
    if (m.type === 'rendered') resolveRendered(m);
  },
  getState: () => state,
  setState: (s: unknown) => (state = s),
};

Object.assign(window, {
  __rendered: rendered,
  __sent: sent,
  __select: params.get('select'),
  __deliver: deliver,
});

// Start the app only after the mock host is installed.
start();
