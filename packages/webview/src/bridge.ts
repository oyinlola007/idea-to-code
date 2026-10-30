// The page's side of the message bridge. The boot probe in the HTML acquires the
// VS Code API once (it can only be acquired once) and leaves it on window.
import { HostMessage, WebviewMessage, type AppState } from '@idea-to-code/core';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare global {
  interface Window {
    __vscode: VsCodeApi;
  }
}

export function send(message: WebviewMessage): void {
  window.__vscode.postMessage(WebviewMessage.parse(message));
}

/** Calls back with each valid state from the host; anything else is reported and dropped. */
export function onState(callback: (state: AppState) => void): () => void {
  const listener = (event: MessageEvent<unknown>) => {
    const parsed = HostMessage.safeParse(event.data);
    if (parsed.success) callback(parsed.data.state);
    else
      send({
        type: 'log',
        level: 'error',
        message: `dropped a bad message from the host: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      });
  };
  window.addEventListener('message', listener);
  return () => {
    window.removeEventListener('message', listener);
  };
}
