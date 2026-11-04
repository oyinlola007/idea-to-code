import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/history.js';
import { NodePlanFiles } from '../src/nodePlanFiles.js';
import { ProjectService } from '../src/projectService.js';
import { outsideEditorSave, projectFolder, tempDir } from './helpers.js';

const AGENT = { source: 'agent', actor: 'built-in agent' } as const;
const MAP = 'plan/map.yaml';

let root: string;
let service: ProjectService;

beforeEach(async () => {
  root = await projectFolder();
  service = await ProjectService.open({ files: new NodePlanFiles(root), store: new HistoryStore(await tempDir()), root });
});

const snapshots = async () => (await service.projectHistory?.listSnapshots()) ?? [];

describe('a whole agent turn', () => {
  it('writes once and records one version, under the chat session', async () => {
    const chat = await service.projectHistory?.openSession({ kind: 'chat', editor: 'VS Code', title: 'Planning' });
    const before = (await snapshots()).length;
    const result = await service.applyBatch(
      [
        { name: 'add_feature', input: { label: 'Fees' } },
        { name: 'fill_flow', input: { flowId: 'fees', nodes: [{ key: 'a', type: 'step', label: 'Charge a fee' }] } },
        { name: 'set_status', input: { id: 'join-waitlist', status: 'done' } },
      ],
      { ...AGENT, sessionId: chat?.id ?? '' },
    );
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ applied: 3, skipped: [], sessionId: chat?.id });
    expect(result.changed.sort()).toEqual(['plan/features/bookings.yaml', 'plan/features/fees.yaml', MAP]);
    const all = await snapshots();
    expect(all).toHaveLength(before + 1);
    expect(all.at(-1)).toMatchObject({ id: result.snapshotId, source: 'agent', actor: 'built-in agent', session: chat?.id });
    expect(result.summary).toContain("Added feature 'Fees'");
    expect(await readFile(join(root, 'plan/features/fees.yaml'), 'utf8')).toContain('Charge a fee');
  });

  it('records nothing when nothing changes', async () => {
    const before = (await snapshots()).length;
    expect(await service.applyBatch([], AGENT)).toMatchObject({ ok: true, applied: 0, changed: [], summary: 'No changes' });
    expect(await snapshots()).toHaveLength(before);
  });

  it('replays on top of an outside edit made meanwhile, skipping what no longer applies', async () => {
    // The agent previewed a change to join-waitlist; meanwhile someone removed that step by hand.
    const bookings = await readFile(join(root, 'plan/features/bookings.yaml'), 'utf8');
    await outsideEditorSave(
      root,
      'plan/map.yaml',
      (await readFile(join(root, MAP), 'utf8')).replace('label: Reminders', 'label: Text reminders'),
    );
    const result = await service.applyBatch(
      [
        { name: 'set_status', input: { id: 'no-such-step', status: 'done' } },
        { name: 'set_status', input: { id: 'pick-dates', status: 'in_progress' } },
      ],
      AGENT,
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([{ index: 0, message: expect.stringContaining('no-such-step') as string }]);
    // The outside edit was recorded first, as its own version, and kept.
    const all = await snapshots();
    expect(all.at(-2)).toMatchObject({ source: 'external' });
    expect(await readFile(join(root, MAP), 'utf8')).toContain('Text reminders');
    expect(await readFile(join(root, 'plan/features/bookings.yaml'), 'utf8')).not.toBe(bookings);
  });

  it('files the turn under activity, with a warning, if the chat session has closed', async () => {
    const chat = await service.projectHistory?.openSession({ kind: 'chat', editor: 'VS Code' });
    await service.projectHistory?.closeSession(chat?.id ?? '');
    const result = await service.applyBatch([{ name: 'set_status', input: { id: 'pick-dates', status: 'todo' } }], {
      ...AGENT,
      sessionId: chat?.id ?? '',
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.warnings.join(' ')).toContain('outside the chat session');
    expect(result.sessionId).not.toBe(chat?.id);
  });
});
