import pkg from '../package.json' with { type: 'json' };

/** The name it's published under, and its version. */
export const serverInfo = { name: 'idea-to-code-mcp', version: pkg.version } as const;
