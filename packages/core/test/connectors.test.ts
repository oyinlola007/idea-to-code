import { describe, expect, it } from 'vitest';
import { addConnector, CONNECTORS, connectorState, removeConnector, type ConnectorId, type ConnectorResult } from '../src/connectors.js';

const ALL = CONNECTORS.map((c) => c.id);

function textOf(result: ConnectorResult): string | null {
  if (result.status === 'refused') throw new Error(result.reason);
  return result.text;
}

const add = (id: ConnectorId, text: string | null) => textOf(addConnector(id, text));
const remove = (id: ConnectorId, text: string | null) => textOf(removeConnector(id, text));

describe('every connector', () => {
  for (const id of ALL) {
    it(`${id}: adds to nothing, is idempotent, and removes cleanly`, () => {
      const first = addConnector(id, null);
      expect(first.status).toBe('added');
      const text = textOf(first);
      expect(addConnector(id, text)).toEqual({ status: 'unchanged', text });
      expect(connectorState(id, text)).toBe('installed');
      expect(connectorState(id, null)).toBe('absent');
      expect(removeConnector(id, text)).toEqual({ status: 'removed', text: null });
      expect(removeConnector(id, null)).toEqual({ status: 'absent', text: null });
    });
  }

  it('only the Claude skill is on by default, and MCP waits for the published server', () => {
    expect(CONNECTORS.filter((c) => c.defaultOn).map((c) => c.id)).toEqual(['claude-skill']);
    expect(CONNECTORS.filter((c) => !c.available).map((c) => c.id)).toEqual(['mcp-claude', 'mcp-cursor']);
  });
});

describe('files we own (skill, Cursor rule)', () => {
  for (const id of ['claude-skill', 'cursor-rule'] as const) {
    it(`${id}: refuses to overwrite or delete someone else's file`, () => {
      const theirs = '# My own instructions\n';
      expect(addConnector(id, theirs).status).toBe('refused');
      expect(removeConnector(id, theirs).status).toBe('refused');
      expect(connectorState(id, theirs)).toBe('blocked');
    });
  }

  it('refreshes an older version of our own file', () => {
    const current = add('claude-skill', null) ?? '';
    const older = current.replace('Keep changes small', 'Keep changes tiny');
    expect(connectorState('claude-skill', older)).toBe('outdated');
    expect(addConnector('claude-skill', older)).toEqual({ status: 'updated', text: current });
  });

  it('writes a skill Claude Code can discover', () => {
    expect(add('claude-skill', null)).toMatch(/^---\nname: plan\ndescription: /);
  });

  it('writes a Cursor rule scoped to the plan', () => {
    expect(add('cursor-rule', null)).toContain('globs: plan/**');
  });
});

describe('sections in shared files (AGENTS.md, Copilot)', () => {
  const existing = '# My project\n\nBuild with make.\n';

  for (const id of ['agents-md', 'copilot'] as const) {
    it(`${id}: adds without touching what's there, and removes back to the original`, () => {
      const added = add(id, existing) ?? '';
      expect(added.startsWith(existing)).toBe(true);
      expect(added).toContain('plan/GUIDE.md');
      expect(connectorState(id, added)).toBe('installed');
      expect(remove(id, added)).toBe(existing);
      expect(connectorState(id, existing)).toBe('absent');
    });
  }

  it('keeps content written after our section', () => {
    const added = add('agents-md', existing) ?? '';
    const withMore = `${added}\n## Later notes\n\nKeep this.\n`;
    expect(addConnector('agents-md', withMore)).toEqual({ status: 'unchanged', text: withMore });
    const removed = remove('agents-md', withMore);
    expect(removed).toContain('Build with make.');
    expect(removed).toContain('## Later notes\n\nKeep this.\n');
    expect(removed).not.toContain('idea-to-code');
  });

  it('refreshes our section in place', () => {
    const added = add('agents-md', existing) ?? '';
    const older = added.replace('keep the plan up to date', 'update the plan');
    expect(connectorState('agents-md', older)).toBe('outdated');
    expect(add('agents-md', older)).toBe(added);
  });

  it('handles a file without a final newline', () => {
    const added = add('agents-md', 'Short note') ?? '';
    expect(added.startsWith('Short note\n\n<!--')).toBe(true);
    expect(remove('agents-md', added)).toBe('Short note\n');
  });

  it('leaves a file alone when our section is not in it', () => {
    expect(removeConnector('agents-md', existing)).toEqual({ status: 'absent', text: existing });
  });

  it('refuses when the markers are damaged', () => {
    const damaged = `${existing}<!-- idea-to-code:start -->\nno end marker\n`;
    expect(addConnector('copilot', damaged).status).toBe('refused');
    expect(removeConnector('copilot', damaged).status).toBe('refused');
    expect(connectorState('copilot', damaged)).toBe('blocked');
  });
});

describe('MCP config', () => {
  const server = { command: 'npx', args: ['-y', 'idea-to-code-mcp'] };
  const existing = `${JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: 1 }, null, 2)}\n`;

  for (const id of ['mcp-claude', 'mcp-cursor'] as const) {
    it(`${id}: merges beside other servers, and removes only ours`, () => {
      const added = JSON.parse(add(id, existing) ?? '') as { mcpServers: Record<string, unknown>; extra: number };
      expect(added.mcpServers).toEqual({ other: { command: 'x' }, 'idea-to-code': server });
      expect(added.extra).toBe(1);
      expect(JSON.parse(remove(id, add(id, existing)) ?? '')).toEqual(JSON.parse(existing));
    });
  }

  it("doesn't reformat a file that already has our server", () => {
    const oddlyFormatted = `{"mcpServers":{"idea-to-code":${JSON.stringify(server)}}}`;
    expect(addConnector('mcp-claude', oddlyFormatted)).toEqual({ status: 'unchanged', text: oddlyFormatted });
  });

  it('leaves other settings when ours was the only server', () => {
    const text = add('mcp-cursor', '{"theme":"dark"}') ?? '';
    expect(JSON.parse(remove('mcp-cursor', text) ?? '')).toEqual({ theme: 'dark' });
  });

  it('refuses invalid JSON rather than overwrite it', () => {
    for (const bad of ['{ not json', '[1,2]', '{"mcpServers":[]}']) {
      expect(addConnector('mcp-claude', bad).status, bad).toBe('refused');
      expect(removeConnector('mcp-claude', bad).status, bad).toBe('refused');
      expect(connectorState('mcp-claude', bad), bad).toBe('blocked');
    }
  });

  it('is absent when our server is not there', () => {
    expect(removeConnector('mcp-claude', existing)).toEqual({ status: 'absent', text: existing });
  });
});
