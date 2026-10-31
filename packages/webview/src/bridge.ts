// The page's side of the message bridge. The boot probe in the HTML acquires the
// VS Code API once (it can only be acquired once) and leaves it on window.
import { HostMessage, WebviewMessage, type EditResult, type UiOperation } from '@idea-to-code/core';

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

const pendingEdits = new Map<number, (result: EditResult) => void>();
let nextRequest = 1;

/** Asks the host to apply an edit; answers when the plan has been updated, or why it wasn't. */
export function sendEdit(name: UiOperation, input: unknown): Promise<EditResult> {
  const requestId = nextRequest++;
  return new Promise((resolve) => {
    pendingEdits.set(requestId, resolve);
    send({ type: 'edit', requestId, name, input });
  });
}

export function finishEdit(requestId: number, result: EditResult): void {
  pendingEdits.get(requestId)?.(result);
  pendingEdits.delete(requestId);
}

/** What a hidden or reloaded tab saved; checked by whoever reads it. */
export function loadSaved(): unknown {
  return window.__vscode.getState();
}

export function save(state: unknown): void {
  window.__vscode.setState(state);
}
