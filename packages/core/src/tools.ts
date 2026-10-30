// Agent tool definitions, generated once from the operations, so the built-in
// chat and the MCP server describe exactly what the code accepts. Plain data:
// each entry point adapts it to its own SDK and runs calls through applyOperation.
import { z } from 'zod';
import { OPERATIONS } from './opDefinitions.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function toolDefinitions(): ToolDefinition[] {
  return OPERATIONS.map((op) => ({
    name: op.name,
    description: op.description,
    inputSchema: z.toJSONSchema(op.input, { io: 'input' }),
  }));
}
