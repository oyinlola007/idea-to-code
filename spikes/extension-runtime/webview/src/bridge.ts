// The webview side of the bridge. In VS Code it wraps acquireVsCodeApi; in the
// screenshot harness a mock host stands in. Both directions are validated.
import './zodConfig';
import { HostToView, ViewToHost } from '../../src/shared/messages';
import type { LevelId } from '../../src/shared/viewModel';

export interface SavedState {
  history: LevelId[];
  cursor: number;
  selected: string | null;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    /** Acquired by the boot script in the extension's HTML (it can only be acquired once). */
    __vscode?: VsCodeApi;
    __harnessApi?: VsCodeApi;
  }
}

// Looked up on first use, so the screenshot harness can install its mock first.
let cached: VsCodeApi | undefined;
function host(): VsCodeApi {
  cached ??= window.__vscode ??
    window.acquireVsCodeApi?.() ??
    window.__harnessApi ?? {
      postMessage: () => {},
      getState: () => undefined,
      setState: () => {},
    };
  return cached;
}

export function send(msg: ViewToHost) {
  host().postMessage(ViewToHost.parse(msg));
}

export function log(level: 'info' | 'warn' | 'error', message: string) {
  send({ type: 'log', level, message });
}

export function onMessage(handler: (msg: HostToView) => void): () => void {
  const listener = (event: MessageEvent) => {
    const parsed = HostToView.safeParse(event.data);
    if (parsed.success) handler(parsed.data);
    else if (event.data && typeof event.data === 'object' && 'type' in event.data) log('warn', `dropped an invalid message: ${parsed.error.message}`);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

export function loadState(): SavedState | undefined {
  const s = host().getState() as SavedState | undefined;
  return s && Array.isArray(s.history) && typeof s.cursor === 'number' ? s : undefined;
}

export function saveState(state: SavedState) {
  host().setState(state);
}
