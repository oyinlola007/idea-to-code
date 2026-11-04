// How the editor starts the MCP server bundled in the extension: with the editor's
// own Node, so nothing needs installing. Pure, so it's tested without VS Code.
import { join } from 'node:path';

/** The provider id, also declared under contributes.mcpServerDefinitionProviders. */
export const MCP_PROVIDER_ID = 'ideaToCode.mcp';
export const MCP_LABEL = 'idea-to-code';

export interface ServerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  version: string;
}

export function serverLaunch(extensionPath: string, root: string, version: string, execPath = process.execPath): ServerLaunch {
  return {
    command: execPath,
    args: [join(extensionPath, 'dist', 'mcp.mjs'), '--root', root],
    // The editor's binary is Electron: this makes it run the script as plain Node.
    env: { ELECTRON_RUN_AS_NODE: '1' },
    version,
  };
}
