import './zodConfig';
import { log } from './bridge';
import { start } from './main';

// Surface webview failures in the extension's output channel.
window.addEventListener('error', (e) => log('error', `${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log('error', `unhandled rejection: ${String(e.reason)}`));

start();
