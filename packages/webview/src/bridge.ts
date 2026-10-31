// The page's side of the message bridge. The boot probe in the HTML acquires the
// VS Code API once (it can only be acquired once) and leaves it on window.
import { HostMessage, WebviewMessage } from '@idea-to-code/core';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    __vscode: VsCodeApi;
  }
}

export function send(message: WebviewMessage): void {
  window.__vscode.postMessage(WebviewMessage.parse(message));
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  send({ type: 'log', level, message: message.slice(0, 2000) });
}

/** Calls back with each valid message from the host; anything else is reported and dropped. */
export function onHostMessage(callback: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<unknown>) => {
    const parsed = HostMessage.safeParse(event.data);
    if (parsed.success) callback(parsed.data);
    else log('error', `dropped a bad message from the host: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  };
  window.addEventListener('message', listener);
  return () => {
    window.removeEventListener('message', listener);
  };
}

export interface SavedView {
  level: string;
  selected: string | null;
}

/** What to restore when a hidden or reloaded tab comes back. */
export function loadView(): SavedView | undefined {
  const saved = window.__vscode.getState() as Partial<SavedView> | undefined;
  return typeof saved?.level === 'string' ? { level: saved.level, selected: saved.selected ?? null } : undefined;
}

export function saveView(view: SavedView): void {
  window.__vscode.setState(view);
}
