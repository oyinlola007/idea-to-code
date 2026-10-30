import { describe, expect, it } from 'vitest';
import { checkProjectPath, UnsafePathError } from '../src/paths.js';

describe('checkProjectPath', () => {
  it('allows the plan folder and the connector files', () => {
    for (const ok of [
      'plan/map.yaml',
      'plan/features/bookings.yaml',
      'plan/GUIDE.md',
      'AGENTS.md',
      '.claude/skills/plan/SKILL.md',
      '.github/copilot-instructions.md',
      '.cursor/rules/plan.mdc',
      '.mcp.json',
      '.cursor/mcp.json',
    ]) {
      expect(() => {
        checkProjectPath(ok);
      }, ok).not.toThrow();
    }
  });

  it('refuses anything that could leave the project or reach other files', () => {
    for (const bad of [
      '../secrets',
      'plan/../../etc/passwd',
      'plan/../package.json',
      '/etc/passwd',
      'C:/Windows/x',
      'plan\\..\\x',
      'src/index.ts',
      'package.json',
      '.env',
      'plan//x',
      './plan/map.yaml',
      'plan/x\0.yaml',
      '',
    ]) {
      expect(() => {
        checkProjectPath(bad);
      }, bad).toThrow(UnsafePathError);
    }
  });
});
