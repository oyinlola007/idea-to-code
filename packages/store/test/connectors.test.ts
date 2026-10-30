import { CONNECTORS, generateGuide } from '@idea-to-code/core';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/history.js';
import { NodePlanFiles } from '../src/nodePlanFiles.js';
import { checkProjectPath } from '../src/paths.js';
import { ProjectService } from '../src/projectService.js';
import { projectFolder, tempDir } from './helpers.js';

let root: string;
let service: ProjectService;
beforeEach(async () => {
  root = await projectFolder();
  service = await ProjectService.open({ files: new NodePlanFiles(root), store: new HistoryStore(await tempDir()), root });
});

const exists = (path: string) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );

describe('guide and connectors on disk', () => {
  it('writes the guide, outside plan history', async () => {
    await service.writeGuide();
    await expect(readFile(join(root, 'plan/GUIDE.md'), 'utf8')).resolves.toBe(generateGuide());
    await service.sync();
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(1);
  });

  it('allows writing every connector path', () => {
    for (const c of CONNECTORS) {
      expect(() => {
        checkProjectPath(c.path);
      }, c.path).not.toThrow();
    }
  });

  it('turns every connector on and off, leaving no files behind', async () => {
    for (const { id, path } of CONNECTORS) {
      await expect(service.setConnector(id, true)).resolves.toMatchObject({ status: 'added' });
      await expect(exists(path), path).resolves.toBe(true);
      await expect(service.setConnector(id, true)).resolves.toMatchObject({ status: 'unchanged' });
      await expect(service.setConnector(id, false)).resolves.toMatchObject({ status: 'removed' });
      await expect(exists(path), path).resolves.toBe(false);
    }
  });

  it('reports each connector state', async () => {
    await service.setConnector('claude-skill', true);
    await writeFile(join(root, 'AGENTS.md'), 'mine\n');
    const states = Object.fromEntries((await service.connectorStates()).map((s) => [s.id, s.state]));
    expect(states).toMatchObject({ 'claude-skill': 'installed', 'agents-md': 'absent', copilot: 'absent' });
  });

  it("keeps a project's own AGENTS.md content", async () => {
    await writeFile(join(root, 'AGENTS.md'), '# Rules\n\nUse tabs.\n');
    await service.setConnector('agents-md', true);
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toContain('Use tabs.');
    await service.setConnector('agents-md', false);
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toBe('# Rules\n\nUse tabs.\n');
  });

  it("refuses to overwrite someone else's file", async () => {
    await service.writeProjectFile('.cursor/rules/plan.mdc', 'my rule\n');
    await expect(service.setConnector('cursor-rule', true)).resolves.toMatchObject({ status: 'refused' });
    await expect(readFile(join(root, '.cursor/rules/plan.mdc'), 'utf8')).resolves.toBe('my rule\n');
  });
});
