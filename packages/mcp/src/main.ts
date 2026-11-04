// The idea-to-code-mcp command: an MCP server on stdio for the plan in this project.
// Stdout is the protocol, so everything else goes to stderr.
import { appDataDir, HistoryStore } from '@idea-to-code/store';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { serverInfo } from './info.js';
import { findProjectRoot } from './root.js';
import { createServer } from './server.js';

const USAGE = `Usage: ${serverInfo.name} [--root <folder>]

An MCP server for the idea-to-code plan in plan/. Without --root it uses the
nearest folder with a plan, from the current folder up to your home folder.

  claude mcp add idea-to-code -- npx -y ${serverInfo.name}
`;

function fail(message: string, code: number): never {
  process.stderr.write(`${serverInfo.name}: ${message}\n`);
  process.exit(code);
}

function readArgs() {
  try {
    return parseArgs({ options: { root: { type: 'string' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }).values;
  } catch (err) {
    return fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`, 2);
  }
}

const args = readArgs();

if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`${serverInfo.version}\n`);
  process.exit(0);
}

const home = homedir();
const found = await findProjectRoot({ start: process.cwd(), home, root: args.root });
if ('error' in found) fail(found.error, 1);

const store = new HistoryStore(appDataDir({ platform: process.platform, env: process.env, home }));
const mcp = createServer({ root: found.root, store });
await mcp.server.connect(new StdioServerTransport());
process.stderr.write(`${serverInfo.name} ${serverInfo.version}: ${found.root}${found.found ? '' : ' (no plan yet)'}\n`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await mcp.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdin.on('end', () => void shutdown());
