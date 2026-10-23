// The idea-to-code-mcp command. Placeholder until ITC-18; it already bundles
// @idea-to-code/core, so the published package needs no other workspace code.
import { validateProject } from '@idea-to-code/core';
import { serverInfo } from './index.js';

process.stderr.write(
  `${serverInfo.name} ${serverInfo.version}: the MCP server arrives in ITC-18 (core loaded: ${typeof validateProject})\n`,
);
