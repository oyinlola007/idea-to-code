import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/history.js';
import { NodePlanFiles } from '../src/nodePlanFiles.js';
import type { PlanFiles } from '../src/planFiles.js';
import { ProjectService, type ServiceEvent } from '../src/projectService.js';
import { outsideEditorSave, projectFolder, tempDir } from './helpers.js';

const BOOKINGS = 'plan/features/bookings.yaml';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string;
let dataDir: string;
beforeEach(async () => {
  root = await projectFolder();
  dataDir = await tempDir();
});

const open = (files: PlanFiles = new NodePlanFiles(root), quietMs?: number) =>
  ProjectService.open({ files, store: new HistoryStore(dataDir), root, ...(quietMs === undefined ? {} : { quietMs }) });

const renameLabel = async () => (await readFile(join(root, BOOKINGS), 'utf8')).replace('label: Pick dates', 'label: Choose dates');

describe('outside changes', () => {
  it('records a change made while the app was closed, with a diff summary', async () => {
    await open();
    await outsideEditorSave(root, BOOKINGS, await renameLabel());
    const service = await open();
    const latest = (await service.projectHistory?.listSnapshots())?.at(-1);
    expect(latest).toMatchObject({ source: 'external', actor: 'unknown', summary: "Renamed 'Pick dates' to 'Choose dates'" });
  });

  it('saves a broken file too, so its state is on record', async () => {
    const service = await open();
    await outsideEditorSave(root, BOOKINGS, 'feature: bookings\nflows: [broken\n');
    await service.sync();
    const latest = (await service.projectHistory?.listSnapshots())?.at(-1);
    expect(latest).toMatchObject({ source: 'external' });
    expect(latest?.summary).toContain("can't be read");
  });

  it('records outside changes before an edit, so each change has the right author', async () => {
    const service = await open();
    await outsideEditorSave(root, BOOKINGS, await renameLabel());
    const r = await service.apply(
      { name: 'set_status', input: { id: 'join-waitlist', status: 'done' } },
      { source: 'mcp', actor: 'claude-code' },
    );
    expect(r.ok).toBe(true);
    const snapshots = (await service.projectHistory?.listSnapshots()) ?? [];
    expect(snapshots.map((s) => s.actor)).toEqual(['unknown', 'unknown', 'claude-code']);
    expect(snapshots.at(-1)?.summary).toBe("'Join the waitlist' → done");
  });

  it("doesn't record its own write twice, in this process or another", async () => {
    const service = await open();
    const other = await open();
    await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, { source: 'mcp', actor: 'claude-code' });
    await service.sync();
    await other.sync();
    const snapshots = (await service.projectHistory?.listSnapshots()) ?? [];
    expect(snapshots.map((s) => s.source)).toEqual(['external', 'mcp']);
  });

  it('groups a burst of saves into one snapshot once it goes quiet', async () => {
    const service = await open(new NodePlanFiles(root), 150);
    const events: ServiceEvent[] = [];
    service.onEvent((e) => events.push(e));
    service.startWatching();
    await sleep(50);
    const text = await renameLabel();
    for (let i = 0; i < 5; i++) {
      await outsideEditorSave(root, BOOKINGS, `${text}# save ${i}\n`);
      await sleep(20);
    }
    await sleep(600);
    await service.dispose();
    expect(events.filter((e) => e.type === 'changed')).toHaveLength(1);
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(2);
    expect(events[0]).toMatchObject({ cause: 'external', changed: [BOOKINGS] });
  });

  it("doesn't react to its own writes while watching", async () => {
    const service = await open(new NodePlanFiles(root), 50);
    const events: ServiceEvent[] = [];
    service.onEvent((e) => events.push(e));
    service.startWatching();
    await sleep(30);
    await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, { source: 'ui', actor: 'user' });
    await sleep(300);
    await service.dispose();
    expect(events.flatMap((e) => (e.type === 'changed' ? [e.cause] : []))).toEqual(['operation']);
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(2);
  });

  it('gives a copied folder its own history, because the original still exists', async () => {
    const first = await open();
    const copy = await projectFolder();
    const service = await ProjectService.open({ files: new NodePlanFiles(copy), store: new HistoryStore(dataDir), root: copy });
    expect(service.openStatus.status).toBe('new');
    expect(service.projectHistory?.record.id).not.toBe(first.projectHistory?.record.id);
  });

  it('picks its history back up when the folder really moves', async () => {
    const first = await open();
    const moved = await projectFolder();
    await rm(root, { recursive: true });
    const service = await ProjectService.open({ files: new NodePlanFiles(moved), store: new HistoryStore(dataDir), root: moved });
    expect(service.openStatus).toEqual({ status: 'relinked', previousPath: root });
    expect(service.projectHistory?.record.id).toBe(first.projectHistory?.record.id);
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(1);
  });
});

describe('a file changing during a save', () => {
  /** Saves like an outside editor right after the service has read the plan, for the first `times` writes. */
  class Interfering extends NodePlanFiles {
    private reads = 0;
    constructor(
      root: string,
      private times: number,
      private readonly change: (round: number) => Promise<void>,
    ) {
      super(root);
    }
    /** Called by the test once it wants interference to begin. */
    arm(): void {
      this.reads = 1;
    }
    override async read(path: string): Promise<string | null> {
      const value = await super.read(path);
      // After the bookings file is read as part of the whole plan, an outside save lands.
      if (this.reads > 0 && this.times > 0 && path === 'plan/features/handover.yaml') {
        this.times--;
        await this.change(this.reads++);
      }
      return value;
    }
  }

  const appendComment = (round: number) => async () => {
    const text = await readFile(join(root, BOOKINGS), 'utf8');
    await outsideEditorSave(root, BOOKINGS, `${text}# outside save ${round}\n`);
  };

  it('re-applies the edit to the newest version, keeping both changes', async () => {
    const files = new Interfering(root, 1, (n) => appendComment(n)());
    const service = await open(files);
    files.arm();
    const r = await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, { source: 'ui', actor: 'user' });
    expect(r.ok).toBe(true);
    const text = await readFile(join(root, BOOKINGS), 'utf8');
    expect(text).toContain('# outside save 1');
    expect(text).toContain('label: Join the waitlist\n        status: done');
  });

  it('reports a conflict if the file keeps changing, leaving the outside version in place', async () => {
    const files = new Interfering(root, 100, (n) => appendComment(n)());
    const service = await open(files);
    files.arm();
    const r = await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, { source: 'ui', actor: 'user' });
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    const text = await readFile(join(root, BOOKINGS), 'utf8');
    expect(text).toContain('# outside save');
    expect(text).toContain('label: Join the waitlist\n        status: todo');
  });
});
