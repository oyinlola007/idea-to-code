// @idea-to-code/mcp: the MCP server, published as idea-to-code-mcp. The tools
// arrive in ITC-18; for now it only describes itself.
import pkg from '../package.json' with { type: 'json' };

export const serverInfo = { name: 'idea-to-code-mcp', version: pkg.version } as const;
