// The chart's HTML shell. Strict CSP: scripts only with this page's nonce or
// from the extension's own files, no eval, workers from blob: or local files.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'out', 'webview');
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [webviewRoot(extensionUri)] };
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const src = webview.cspSource;
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot(extensionUri), name)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${src} data:`,
    `font-src ${src}`,
    `style-src ${src} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${src}`,
    `worker-src blob: ${src}`,
    `connect-src ${src}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('style.css')}">
<title>Plan</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  // Boot probe: report load failures and CSP violations before the app runs.
  window.__vscode = acquireVsCodeApi();
  const report = (message) => window.__vscode.postMessage({ type: 'log', level: 'error', message: String(message).slice(0, 500) });
  window.addEventListener('error', (e) => report('boot: ' + e.message + ' ' + (e.filename || (e.target && (e.target.src || e.target.href)) || '')), true);
  document.addEventListener('securitypolicyviolation', (e) => report('csp: ' + e.violatedDirective + ' blocked ' + e.blockedURI));
</script>
<script nonce="${nonce}" type="module" src="${asset('webview.js')}"></script>
</body>
</html>`;
}
