import { describe, expect, it } from 'vitest';
import { generateGuide, generateSkill } from '../src/guide.js';
import { loadFromTexts } from '../src/load.js';
import { OPERATIONS } from '../src/opDefinitions.js';
import { ComponentNode, DecisionNode, EndNode, ReferenceNode, StartNode, Status, StepNode } from '../src/schema.js';
import { errorsOf, indexProject, validateProject } from '../src/validate.js';

const guide = generateGuide();

const yamlBlocks = guide.match(/```yaml\n[\s\S]*?```/g)?.map((b) => b.replace(/^```yaml\n/, '').replace(/```$/, '')) ?? [];

describe('generateGuide', () => {
  it('shows examples that are a valid plan', () => {
    expect(yamlBlocks).toHaveLength(2);
    const project = loadFromTexts({ 'plan/map.yaml': yamlBlocks[0] ?? '', 'plan/features/bookings.yaml': yamlBlocks[1] ?? '' });
    expect(errorsOf(validateProject(project))).toEqual([]);
  });

  it('shows every node type in its table, and every type and field in the example', () => {
    const shapes = {
      step: StepNode,
      decision: DecisionNode,
      start: StartNode,
      end: EndNode,
      component: ComponentNode,
      reference: ReferenceNode,
    };
    const project = loadFromTexts({ 'plan/map.yaml': yamlBlocks[0] ?? '', 'plan/features/bookings.yaml': yamlBlocks[1] ?? '' });
    const shown = [...indexProject(project).nodes.values()].map((n) => n.node);
    const used = new Set(shown.flatMap((n) => Object.keys(n)));
    for (const [type, schema] of Object.entries(shapes)) {
      expect(guide).toContain(`| \`${type}\` |`);
      expect(shown.map((n) => n.type)).toContain(type);
      for (const field of Object.keys(schema.shape)) expect(used, `${type}.${field}`).toContain(field);
    }
  });

  it('takes node fields from the schema', () => {
    expect(guide).toContain('| `step` | something the app or user does | `status`, `expands` |');
    expect(guide).toMatch(/\| `component` \|.*\| `kind` \(required, any word\), `tech`, `status`, `expands` \|/);
    expect(guide).toMatch(/\| `reference` \|.*\| `ref` \(required\) \|/);
    expect(guide).toMatch(/\| `decision` \|.*\| none \|/);
  });

  it('takes status values and where they apply from the schema', () => {
    for (const s of Status.options) expect(guide).toContain(`\`${s}\``);
    expect(guide).toContain('only on `step` and `component` nodes');
    expect(guide).toContain("Don't put a status on `decision`, `start`, `end` or `reference`");
  });

  it('states the rules agents must follow', () => {
    expect(guide).toContain('Never change an existing `id`');
    expect(guide).toMatch(/flows into/);
    expect(guide).toContain('exactly one node');
    expect(guide).toContain('**Shared components:** check `components`');
    expect(guide).toMatch(/## Checking your work/);
  });

  it('says to prefer the MCP tools, naming every one', () => {
    expect(guide).toContain('prefer them');
    for (const op of OPERATIONS) expect(guide).toContain(`\`${op.name}\``);
  });

  it('warns about the unquoted comma that broke a file in testing', () => {
    expect(guide).toContain('An unquoted comma inside `{ }` silently breaks the file');
  });

  it('is the same every time', () => {
    expect(generateGuide()).toBe(guide);
  });
});

describe('generateSkill', () => {
  it('has the frontmatter Claude Code needs, and points at the guide', () => {
    const skill = generateSkill('<!-- m -->');
    expect(skill.startsWith('---\nname: plan\ndescription: ')).toBe(true);
    expect(skill).toContain('plan/GUIDE.md');
    expect(skill).toContain('<!-- m -->');
  });
});
