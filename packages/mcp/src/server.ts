// The MCP server: the built-in agent's tools for any coding agent. Every edit goes
// through ProjectService.apply, which checks it, records outside edits first, writes
// only plan/ and records a snapshot under the client's name. The low-level Server
// handlers serve core's JSON Schemas as they are, the same ones the built-in agent
// uses, rather than registering zod shapes for the SDK to convert.
import {
  buildViewModel,
  isReadTool,
  loadFromTexts,
  MCP_INSTRUCTIONS,
  newPlanMap,
  OPERATIONS,
  readToolDefinitions,
  runReadTool,
  toolDefinitions,
  validateProject,
  type ToolDefinition,
} from '@idea-to-code/core';
import { NodePlanFiles, ProjectService, type HistoryStore } from '@idea-to-code/store';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { basename } from 'node:path';
import { serverInfo } from './info.js';
import { errorResult, issuesResult, opResult, textResult, viewResult, type ToolResult } from './results.js';

export interface ServerOptions {
  /** The project folder, from findProjectRoot. */
  root: string;
  store: HistoryStore;
  now?: () => number;
  /** Where unexpected errors go; stdout belongs to the protocol. */
  log?: (message: string) => void;
}

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

const OWN_TOOLS: ToolDefinition[] = [
  {
    name: 'get_current_view',
    description: 'Which part of the plan the user has open in the idea-to-code chart: what "here" and "this" mean.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'validate',
    description: 'Checks the whole plan and lists every problem with its file, line and reason.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'init_plan',
    description: 'Starts a plan in this project when there is none: creates plan/map.yaml and plan/GUIDE.md.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', maxLength: 200, description: "The project's name. Defaults to the folder name." } },
      additionalProperties: false,
    },
  },
];

const READ_ONLY = new Set(['get_current_view', 'validate']);

function toTool(definition: ToolDefinition): Tool {
  const readOnly = isReadTool(definition.name) || READ_ONLY.has(definition.name);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema as Tool['inputSchema'],
    annotations: readOnly
      ? { readOnlyHint: true }
      : { readOnlyHint: false, destructiveHint: definition.name.startsWith('remove_'), openWorldHint: false },
  };
}

/** Reading tools first, then ours, then every operation: a fixed order. */
export function serverTools(): Tool[] {
  return [...readToolDefinitions(), ...OWN_TOOLS, ...toolDefinitions()].map(toTool);
}

const OPERATION_NAMES = new Set(OPERATIONS.map((op) => op.name));
const NO_PLAN = "There's no plan in this project yet. Call init_plan to start one.";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface McpPlanServer {
  server: McpServer;
  /** Disconnects and lets go of the project. */
  close(): Promise<void>;
}

export function createServer(options: ServerOptions): McpPlanServer {
  const { root, store } = options;
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });
  const files = new NodePlanFiles(root);
  const tools = serverTools();
  let service: Promise<ProjectService> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  // Only our handlers: declaring tools here instead of in the options keeps McpServer's own out.
  const server = new McpServer({ name: serverInfo.name, version: serverInfo.version }, { instructions: MCP_INSTRUCTIONS });
  server.server.registerCapabilities({ tools: {} });

  const hasPlan = async () => (await files.read('plan/map.yaml')) !== null;
  /** Opened on first use and kept: opening records anything that changed while no one was looking. */
  const open = (): Promise<ProjectService> => {
    service ??= ProjectService.open({ files, store, root }).catch((err: unknown) => {
      service = undefined;
      throw err;
    });
    return service;
  };
  /** The client's own name, e.g. "claude-code", known once it has connected. */
  const actor = () => (server.server.getClientVersion()?.name.trim().slice(0, 100) ?? '') || 'unknown';

  async function call(name: string, input: unknown): Promise<ToolResult> {
    if (name === 'init_plan') return initPlan(input);
    if (!tools.some((tool) => tool.name === name)) return errorResult(`Unknown tool "${name}".`);
    if (!(await hasPlan())) return errorResult(NO_PLAN);
    const project = await open();

    if (isReadTool(name)) {
      const read = runReadTool(loadFromTexts(await project.readPlan()), name, input);
      return read.ok ? textResult(read.text) : errorResult(read.text);
    }
    if (name === 'validate') return issuesResult(validateProject(loadFromTexts(await project.readPlan())));
    if (name === 'get_current_view') {
      const view = (await project.projectHistory?.readView()) ?? null;
      return viewResult(view, buildViewModel(loadFromTexts(await project.readPlan())), now());
    }
    if (OPERATION_NAMES.has(name)) return opResult(await project.apply({ name, input }, { source: 'mcp', actor: actor() }));
    return errorResult(`Unknown tool "${name}".`);
  }

  async function initPlan(input: unknown): Promise<ToolResult> {
    const given = typeof input === 'object' && input !== null ? (input as { project?: unknown }).project : undefined;
    if (given !== undefined && (typeof given !== 'string' || given.trim() === '' || given.length > 200))
      return errorResult('error [invalid-input]: project must be a name of 1 to 200 characters. Fix the call and try again.');
    if (await hasPlan()) return errorResult("There's already a plan here. Read it with get_outline.");
    await files.write('plan/map.yaml', newPlanMap(given?.trim() ?? basename(root)));
    await (await open()).writeGuide();
    return textResult('Started a plan in plan/. Add features with add_feature, then fill each one with fill_flow.');
  }

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: input } = request.params;
    // One call at a time, so each answer describes the plan in the order things happened.
    const run = queue.then(() =>
      call(name, input ?? {}).catch((err: unknown) => {
        log(`${name} failed: ${messageOf(err)}`);
        return errorResult(`internal error: ${messageOf(err)}`);
      }),
    );
    queue = run;
    return run;
  });

  return {
    server,
    close: async () => {
      await server.close();
      await queue;
      if (service) await (await service.catch(() => undefined))?.dispose();
    },
  };
}
