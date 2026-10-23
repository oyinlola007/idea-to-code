// JSON Schema for the two plan file kinds, generated from the zod schema so
// the two never disagree. It feeds editor validation for plan YAML, agent tool
// definitions and the MCP server; scripts/gen-schema.ts writes it to schema/.
import { z } from 'zod';
import { FeatureFile, MapFile } from './schema.js';

export interface PlanJsonSchemas {
  map: Record<string, unknown>;
  feature: Record<string, unknown>;
}

export function jsonSchemas(): PlanJsonSchemas {
  return {
    map: { title: 'idea-to-code plan map (plan/map.yaml)', ...z.toJSONSchema(MapFile, { io: 'input' }) },
    feature: { title: 'idea-to-code feature file (plan/features/<id>.yaml)', ...z.toJSONSchema(FeatureFile, { io: 'input' }) },
  };
}
