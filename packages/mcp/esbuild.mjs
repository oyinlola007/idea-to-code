// Bundles the MCP server into one runnable file with everything inside, so the
// published package has no dependencies and `npx` starts it quickly.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  // CommonJS dependencies (yaml) call require(); give the ES module bundle one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
