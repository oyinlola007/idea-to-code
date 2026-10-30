import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface Manifest {
  engines: { vscode: string };
  main: string;
  devDependencies: Record<string, string>;
  capabilities: { untrustedWorkspaces: { supported: unknown } };
  contributes: {
    commands: { command: string; enablement?: string }[];
    customEditors: { selector: { filenamePattern: string }[] }[];
  };
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Manifest;

describe('extension manifest', () => {
  it('keeps the engine floor found in ITC-3', () => {
    expect(manifest.engines.vscode).toBe('^1.90.0');
  });

  it('pins the API types to the floor, so newer APIs are never used without a runtime check', () => {
    expect(manifest.devDependencies['@types/vscode']).toBe('1.90.0');
  });

  it('loads a CommonJS bundle', () => {
    expect(manifest.main).toBe('./dist/extension.cjs');
  });

  it('claims only the plan files, not any YAML in a folder called plan', () => {
    expect(manifest.contributes.customEditors[0]?.selector.map((s) => s.filenamePattern)).toEqual([
      '**/plan/map.yaml',
      '**/plan/features/*.yaml',
    ]);
  });

  it('runs limited in Restricted Mode, where creating a plan is off', () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe('limited');
    expect(manifest.contributes.commands.find((c) => c.command === 'ideaToCode.initPlan')?.enablement).toBe('isWorkspaceTrusted');
  });
});
