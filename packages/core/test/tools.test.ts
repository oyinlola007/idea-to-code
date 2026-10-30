import { describe, expect, it } from 'vitest';
import { OPERATIONS, applyOperation } from '../src/opDefinitions.js';
import { toolDefinitions } from '../src/tools.js';

interface ObjectSchema {
  type: string;
  additionalProperties: boolean;
  properties: Record<string, unknown>;
  required?: string[];
}

const schemaOf = (name: string) => toolDefinitions().find((t) => t.name === name)?.inputSchema as unknown as ObjectSchema;

describe('tool definitions', () => {
  it('has one tool per operation, covering the full list', () => {
    expect(toolDefinitions().map((t) => t.name)).toEqual(OPERATIONS.map((o) => o.name));
    expect(
      toolDefinitions()
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      [
        'add_component',
        'add_edge',
        'add_feature',
        'add_node',
        'connect_features',
        'disconnect_features',
        'expand_node',
        'fill_flow',
        'remove_component',
        'remove_edge',
        'remove_feature',
        'remove_node',
        'set_status',
        'update_component',
        'update_connection',
        'update_edge',
        'update_feature',
        'update_node',
      ].sort(),
    );
  });

  it('uses unique snake_case names and real descriptions', () => {
    const tools = toolDefinitions();
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
  });

  it('generates strict object schemas with the right required fields', () => {
    for (const t of toolDefinitions()) {
      const schema = t.inputSchema as unknown as ObjectSchema;
      expect(schema.type, t.name).toBe('object');
      expect(schema.additionalProperties, t.name).toBe(false);
    }
    expect(schemaOf('add_node').required?.sort()).toEqual(['flowId', 'type']);
    expect(schemaOf('set_status').required?.sort()).toEqual(['id', 'status']);
  });

  it('shows optional arrays on fill_flow as not required', () => {
    expect(schemaOf('fill_flow').required).toEqual(['flowId']);
    expect(Object.keys(schemaOf('fill_flow').properties).sort()).toEqual(['edges', 'flowId', 'nodes']);
  });

  it('is plain JSON, ready for any SDK', () => {
    const tools = toolDefinitions();
    expect(JSON.parse(JSON.stringify(tools))).toEqual(tools);
  });

  it('every tool name runs through applyOperation', () => {
    for (const t of toolDefinitions()) {
      const result = applyOperation({}, { name: t.name, input: {} });
      expect(result, t.name).toMatchObject({ ok: false });
      expect(!result.ok && result.code, t.name).not.toBe('unknown-operation');
    }
  });
});
