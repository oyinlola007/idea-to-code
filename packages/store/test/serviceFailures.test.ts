// History problems must never stop someone editing their plan.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/history.js';
import { NodePlanFiles } from '../src/nodePlanFiles.js';
import { ProjectService, type ServiceEvent } from '../src/projectService.js';
import { projectFolder, tempDir } from './helpers.js';

const UI = { source: 'ui', actor: 'user' } as const;
const BOOKINGS = 'plan/features/bookings.yaml';
const EDIT = { name: 'set_status', input: { id: 'join-waitlist', status: 'done' } };

let root: string;
beforeEach(async () => {
  root = await projectFolder();
});

describe('when history is in trouble', () => {
  it('still edits when the store folder is unusable, warns, and catches up once it recovers', async () => {
    const parent = await tempDir();
    const dataDir = join(parent, 'data');
    await writeFile(dataDir, 'a file where the folder should be');
    const service = await ProjectService.open({ files: new NodePlanFiles(root), store: new HistoryStore(dataDir), root });
    const warnings: ServiceEvent[] = [];
    service.onEvent((e) => warnings.push(e));
    expect(service.openStatus.status).toBe('unavailable');

    const r = await service.apply(EDIT, UI);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings.join(' ')).toContain('history is unavailable');
    await expect(readFile(join(root, BOOKINGS), 'utf8')).resolves.toContain('status: done');
    expect(warnings.some((e) => e.type === 'warning')).toBe(true);

    // The problem clears: the next check records what was missed.
    await rm(dataDir);
    await service.sync();
    const latest = (await service.projectHistory?.listSnapshots())?.at(-1);
    expect(latest).toBeDefined();
  });

  it('still edits when a lock is stuck, warns, and the next check catches up', async () => {
    const dataDir = await tempDir();
    const store = new HistoryStore(dataDir, { lock: { timeoutMs: 100, staleMs: 60_000 } });
    const service = await ProjectService.open({ files: new NodePlanFiles(root), store, root });
    const dir = service.projectHistory?.dir ?? '';
    const stuck = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token: 'stuck' });
    await writeFile(join(dir, 'plan.lock'), stuck);
    await writeFile(join(dir, 'lock'), stuck);

    const r = await service.apply(EDIT, UI);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/lock/);
    await expect(readFile(join(root, BOOKINGS), 'utf8')).resolves.toContain('status: done');
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(1);

    await rm(join(dir, 'plan.lock'));
    await rm(join(dir, 'lock'));
    await service.sync();
    const latest = (await service.projectHistory?.listSnapshots())?.at(-1);
    expect(latest).toMatchObject({ source: 'external', summary: "'Join the waitlist' → done" });
  });

  it('puts files back if a save fails partway, so a plan is never left half-changed', async () => {
    class FailsOnMap extends NodePlanFiles {
      override async write(path: string, content: string): Promise<void> {
        if (path === 'plan/map.yaml') throw new Error('disk full');
        await super.write(path, content);
      }
    }
    const service = await ProjectService.open({ files: new FailsOnMap(root), store: new HistoryStore(await tempDir()), root });
    const r = await service.apply({ name: 'add_feature', input: { label: 'Insurance' } }, UI);
    expect(r).toMatchObject({ ok: false, code: 'write-failed' });
    expect(!r.ok && r.message).toContain('disk full');
    await expect(new NodePlanFiles(root).read('plan/features/insurance.yaml')).resolves.toBeNull();
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(1);
  });
});
