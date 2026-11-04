// The package as people will get it from npm: packed, installed in an empty folder,
// started over stdio by a real MCP client, on a copy of the Toolshed plan.
// Usage: pnpm --filter idea-to-code-mcp run smoke
import { HistoryStore } from '@idea-to-code/store';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const TOOLSHED = fileURLToPath(new URL('../../core/test/fixtures/toolshed/plan', import.meta.url));

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`smoke: ${what}`);
  console.log(`ok   ${what}`);
}

const work = await mkdtemp(join(tmpdir(), 'itc-mcp-smoke-'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: PACKAGE, stdio: 'ignore' });
  const tarball = (await readdir(work)).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('smoke: pnpm pack made no tarball');
  const listing = execFileSync('tar', ['-tzf', join(work, tarball)], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .sort();
  check(
    listing.join() === ['package/README.md', 'package/dist/main.js', 'package/package.json'].join(),
    `packs only ${listing.join(', ')}`,
  );

  const install = join(work, 'install');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', install, join(work, tarball)], { stdio: 'ignore' });
  const installed = JSON.parse(await readFile(join(install, 'node_modules/idea-to-code-mcp/package.json'), 'utf8')) as {
    dependencies?: object;
  };
  check(installed.dependencies === undefined, 'installs with no dependencies');
  const bin = join(install, 'node_modules/.bin/idea-to-code-mcp');
  check((await stat(bin)).isFile(), 'puts idea-to-code-mcp on the path');

  const project = join(work, 'project');
  await cp(TOOLSHED, join(project, 'plan'), { recursive: true });
  const data = join(work, 'data');
  const transport = new StdioClientTransport({
    command: bin,
    cwd: project,
    env: { ...(process.env as Record<string, string>), IDEA_TO_CODE_DATA: data },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  check(tools.length > 20, `lists ${tools.length} tools`);
  const outline = await client.callTool({ name: 'get_outline', arguments: {} });
  check(JSON.stringify(outline.content).includes('Bookings'), 'reads the plan');
  const added = await client.callTool({ name: 'add_feature', arguments: { label: 'Late fees' } });
  check(added.isError !== true, 'adds a feature');
  await client.close();

  const map = await readFile(join(project, 'plan/map.yaml'), 'utf8');
  check(map.includes('label: Late fees'), 'saves it to plan/map.yaml');
  const history = (await new HistoryStore(data).openProject({ path: project, texts: {} })).project;
  const latest = (await history.listSnapshots()).at(-1);
  check(latest?.source === 'mcp' && latest.actor === 'smoke', `records it as ${latest?.source} by ${latest?.actor}`);
  console.log('smoke passed');
} finally {
  await rm(work, { recursive: true, force: true });
}
