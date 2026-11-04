import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_LABEL, MCP_PROVIDER_ID, serverLaunch } from '../src/mcpLaunch.js';

describe('starting the bundled MCP server', () => {
  it('runs the bundle with the editor’s own Node, on the plan’s folder', () => {
    const launch = serverLaunch('/ext', '/work/app', '1.2.3', '/Applications/Code.app/Electron');
    expect(launch).toEqual({
      command: '/Applications/Code.app/Electron',
      args: [join('/ext', 'dist', 'mcp.mjs'), '--root', '/work/app'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      version: '1.2.3',
    });
  });

  it('is declared in the manifest under the id it registers with', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      contributes: { mcpServerDefinitionProviders?: { id: string; label: string }[] };
    };
    expect(manifest.contributes.mcpServerDefinitionProviders).toEqual([{ id: MCP_PROVIDER_ID, label: MCP_LABEL }]);
  });

  it('ships the bundle in the packaged extension', async () => {
    const ignore = (await readFile(new URL('../.vscodeignore', import.meta.url), 'utf8')).split('\n');
    expect(ignore).toContain('!dist/mcp.mjs');
  });
});
