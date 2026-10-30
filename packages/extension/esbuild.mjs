// Bundles the extension host as CommonJS, which every VS Code core from the
// engine floor (1.90) up can load (ITC-3), and copies the webview in beside it:
// webviews may only load files from inside the extension.
import { cpSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});

rmSync('dist/webview', { recursive: true, force: true });
cpSync('../webview/dist', 'dist/webview', { recursive: true });
