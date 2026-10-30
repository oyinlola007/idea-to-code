// The files that point each coding agent at the plan. Pure: current text in, new
// text out. Adding twice changes nothing, removing leaves other content alone, and
// anything we can't safely edit is refused, never overwritten.
import { generateSkill } from './guide.js';

export type ConnectorId = 'claude-skill' | 'agents-md' | 'copilot' | 'cursor-rule' | 'mcp-claude' | 'mcp-cursor';

export interface Connector {
  id: ConnectorId;
  label: string;
  path: string;
  /** Switched on by default when a plan is set up. */
  defaultOn: boolean;
  /** MCP connectors stay false until the server is published (ITC-18), so nobody gets a broken server entry. */
  available: boolean;
}

export const CONNECTORS: readonly Connector[] = [
  { id: 'claude-skill', label: 'Claude Code skill', path: '.claude/skills/plan/SKILL.md', defaultOn: true, available: true },
  { id: 'agents-md', label: 'AGENTS.md (Codex and others)', path: 'AGENTS.md', defaultOn: false, available: true },
  { id: 'copilot', label: 'GitHub Copilot instructions', path: '.github/copilot-instructions.md', defaultOn: false, available: true },
  { id: 'cursor-rule', label: 'Cursor rule', path: '.cursor/rules/plan.mdc', defaultOn: false, available: true },
  { id: 'mcp-claude', label: 'MCP tools for Claude Code', path: '.mcp.json', defaultOn: false, available: false },
  { id: 'mcp-cursor', label: 'MCP tools for Cursor', path: '.cursor/mcp.json', defaultOn: false, available: false },
];

export type ConnectorResult =
  { status: 'added' | 'updated' | 'unchanged' | 'removed' | 'absent'; text: string | null } | { status: 'refused'; reason: string };

export type ConnectorState = 'absent' | 'installed' | 'outdated' | 'blocked';

const MANAGED = '<!-- idea-to-code: managed file, safe to regenerate -->';
const BLOCK_START = '<!-- idea-to-code:start -->';
const BLOCK_END = '<!-- idea-to-code:end -->';
const MCP_KEY = 'idea-to-code';

const POINTER =
  "This project's plan lives in `plan/` (features, flows, components, progress). When planning or changing features, read `plan/GUIDE.md` first and keep the plan up to date. If the idea-to-code MCP tools are available, use them.";

const CURSOR_RULE = `---
description: Read and update this project's plan in plan/ (features, flows, components, progress). Use when planning a feature, changing steps or flows, or marking work done.
globs: plan/**
alwaysApply: false
---

${MANAGED}

${POINTER}
`;

/** Result of comparing what's there with what we'd write. */
function settled(text: string | null, next: string): ConnectorResult {
  if (text === next) return { status: 'unchanged', text };
  return { status: text === null ? 'added' : 'updated', text: next };
}

function addManagedFile(text: string | null, next: string, path: string): ConnectorResult {
  if (text !== null && !text.includes(MANAGED))
    return { status: 'refused', reason: `${path} already exists and wasn't created by idea-to-code, so it was left alone` };
  return settled(text, next);
}

function removeManagedFile(text: string | null, path: string): ConnectorResult {
  if (text === null) return { status: 'absent', text: null };
  if (!text.includes(MANAGED)) return { status: 'refused', reason: `${path} wasn't created by idea-to-code, so it was left alone` };
  return { status: 'removed', text: null };
}

/** Where our section sits in a shared file; "broken" means its markers are unusable, so we stay out. */
function findBlock(text: string): { start: number; end: number } | 'none' | 'broken' {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start < 0 && end < 0) return 'none';
  if (start < 0 || end < start || text.includes(BLOCK_START, start + 1) || text.includes(BLOCK_END, end + 1)) return 'broken';
  return { start, end: end + BLOCK_END.length };
}

const block = `${BLOCK_START}\n${POINTER}\n${BLOCK_END}`;

function addBlock(text: string | null, path: string): ConnectorResult {
  if (text === null) return settled(null, `${block}\n`);
  const found = findBlock(text);
  if (found === 'broken') return { status: 'refused', reason: `the idea-to-code markers in ${path} are damaged; fix or remove them first` };
  if (found !== 'none') return settled(text, text.slice(0, found.start) + block + text.slice(found.end));
  const separator = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return settled(text, `${text}${separator}${block}\n`);
}

function removeBlock(text: string | null, path: string): ConnectorResult {
  if (text === null) return { status: 'absent', text: null };
  const found = findBlock(text);
  if (found === 'none') return { status: 'absent', text };
  if (found === 'broken') return { status: 'refused', reason: `the idea-to-code markers in ${path} are damaged; fix or remove them first` };
  // Also take the blank line we added before the section, and its line ending.
  const before = text.slice(0, found.start).replace(/\n$/, '');
  const after = text.slice(found.end).replace(/^\n/, '');
  const next = before === '' || before.endsWith('\n') ? before + after : `${before}\n${after}`;
  return { status: 'removed', text: next.trim() === '' ? null : next };
}

const MCP_SERVER = { command: 'npx', args: ['-y', 'idea-to-code-mcp'] };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMcp(text: string | null, path: string): { config: JsonObject; servers: JsonObject } | { reason: string } {
  if (text === null || text.trim() === '') return { config: {}, servers: {} };
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return { reason: `${path} isn't valid JSON, so it was left alone` };
  }
  if (!isObject(config)) return { reason: `${path} isn't a JSON object, so it was left alone` };
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) return { reason: `"mcpServers" in ${path} isn't an object, so it was left alone` };
  return { config, servers };
}

const formatJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function addMcp(text: string | null, path: string): ConnectorResult {
  const parsed = parseMcp(text, path);
  if ('reason' in parsed) return { status: 'refused', reason: parsed.reason };
  if (JSON.stringify(parsed.servers[MCP_KEY]) === JSON.stringify(MCP_SERVER)) return { status: 'unchanged', text };
  return settled(text, formatJson({ ...parsed.config, mcpServers: { ...parsed.servers, [MCP_KEY]: MCP_SERVER } }));
}

function removeMcp(text: string | null, path: string): ConnectorResult {
  if (text === null) return { status: 'absent', text: null };
  const parsed = parseMcp(text, path);
  if ('reason' in parsed) return { status: 'refused', reason: parsed.reason };
  if (!(MCP_KEY in parsed.servers)) return { status: 'absent', text };
  const servers = Object.fromEntries(Object.entries(parsed.servers).filter(([name]) => name !== MCP_KEY));
  const config = Object.fromEntries(Object.entries(parsed.config).filter(([name]) => name !== 'mcpServers'));
  const next = Object.keys(servers).length > 0 ? { ...config, mcpServers: servers } : config;
  return { status: 'removed', text: Object.keys(next).length > 0 ? formatJson(next) : null };
}

function pathOf(id: ConnectorId): string {
  return CONNECTORS.find((c) => c.id === id)?.path ?? id;
}

/** Adds or refreshes a connector, given its file's current text (null if there's no file). */
export function addConnector(id: ConnectorId, text: string | null): ConnectorResult {
  const path = pathOf(id);
  switch (id) {
    case 'claude-skill':
      return addManagedFile(text, generateSkill(MANAGED), path);
    case 'cursor-rule':
      return addManagedFile(text, CURSOR_RULE, path);
    case 'agents-md':
    case 'copilot':
      return addBlock(text, path);
    case 'mcp-claude':
    case 'mcp-cursor':
      return addMcp(text, path);
  }
}

/** Removes only what idea-to-code added. A null text in the result means the file should be deleted. */
export function removeConnector(id: ConnectorId, text: string | null): ConnectorResult {
  const path = pathOf(id);
  switch (id) {
    case 'claude-skill':
    case 'cursor-rule':
      return removeManagedFile(text, path);
    case 'agents-md':
    case 'copilot':
      return removeBlock(text, path);
    case 'mcp-claude':
    case 'mcp-cursor':
      return removeMcp(text, path);
  }
}

/** Whether a connector is set up, given its file's current text. */
export function connectorState(id: ConnectorId, text: string | null): ConnectorState {
  const added = addConnector(id, text);
  if (added.status === 'refused') return 'blocked';
  if (added.status === 'unchanged') return 'installed';
  const present = removeConnector(id, text).status === 'removed';
  return present ? 'outdated' : 'absent';
}
