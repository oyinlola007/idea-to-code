// Writes the JSON Schema files in schema/ from the zod schema. A test fails
// when they're out of date, so run this after changing src/schema.ts.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { jsonSchemas } from '../src/jsonSchema.js';

export const SCHEMA_FILES = { map: 'plan-map.schema.json', feature: 'plan-feature.schema.json' } as const;

export function serialise(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const schemas = jsonSchemas();
  for (const [kind, file] of Object.entries(SCHEMA_FILES) as [keyof typeof SCHEMA_FILES, string][]) {
    const path = fileURLToPath(new URL(`../schema/${file}`, import.meta.url));
    await writeFile(path, serialise(schemas[kind]));
    console.log(`wrote schema/${file}`);
  }
}
