// Bundles the extension host and the in-editor test suite as CommonJS, which
// every VS Code core down to the spike's lowest test version can load.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  minify: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/host/extension.ts'], outfile: 'out/extension.cjs' });
await build({ ...common, entryPoints: ['test/suite/index.ts'], outfile: 'out/test/suite.cjs' });
// The second writer process in the in-editor store test, runnable by the editor's own Node.
await build({ ...common, format: 'esm', entryPoints: ['scripts/store-writer.ts'], outfile: 'out/store-writer.mjs' });

// The "url" worker mode loads ELK's worker from an extension-local file.
await mkdir('out/webview', { recursive: true });
await copyFile('node_modules/elkjs/lib/elk-worker.min.js', 'out/webview/elk-worker.min.js');
