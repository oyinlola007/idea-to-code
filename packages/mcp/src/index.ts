// idea-to-code-mcp: the MCP server, under the name it's published as. It gives any
// coding agent the plan tools of the built-in agent, on the plan in its project.
export { serverInfo } from './info.js';
export { findProjectRoot, type ProjectRoot } from './root.js';
export { createServer, serverTools, type McpPlanServer, type ServerOptions } from './server.js';
