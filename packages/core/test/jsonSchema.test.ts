import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SCHEMA_FILES, serialise } from '../scripts/gen-schema.js';
import { jsonSchemas } from '../src/jsonSchema.js';

describe('JSON Schema', () => {
  it('committed files match the zod schema (run `pnpm --filter @idea-to-code/core gen-schema` after schema changes)', async () => {
    const schemas = jsonSchemas();
    for (const [kind, file] of Object.entries(SCHEMA_FILES) as [keyof typeof SCHEMA_FILES, string][]) {
      const committed = await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8');
      expect(committed, file).toBe(serialise(schemas[kind]));
    }
  });

  it('keeps node objects strict, so unknown keys are reported in editors too', () => {
    const text = JSON.stringify(jsonSchemas().feature);
    expect(text).toContain('"additionalProperties":false');
    for (const type of ['start', 'end', 'step', 'decision', 'component', 'reference']) expect(text).toContain(`"const":"${type}"`);
  });

  it('titles both schemas', () => {
    const { map, feature } = jsonSchemas();
    expect(map.title).toMatch(/plan map/);
    expect(feature.title).toMatch(/feature file/);
  });
});
