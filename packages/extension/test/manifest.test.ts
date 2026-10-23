import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface Manifest {
  engines: { vscode: string };
  main: string;
  devDependencies: Record<string, string>;
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
});
