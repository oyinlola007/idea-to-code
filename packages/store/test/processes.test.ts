// Several real processes at once, using the approach ITC-3 proved.
import { describe, expect, it } from 'vitest';
import { runWriter } from '../scripts/stress.js';
import { HistoryStore } from '../src/history.js';
import { tempDir } from './helpers.js';

describe('several processes writing at once', () => {
  it('keeps one unbroken chain, every blob intact, in truly interleaved writes', async () => {
    const dir = await tempDir();
    await Promise.all([runWriter(dir, { count: 100, tag: 'a' }), runWriter(dir, { count: 100, tag: 'b' })]);
    const { project } = await new HistoryStore(dir).openProject({ path: '/projects/stress', texts: {} });
    const result = await project.verify();
    expect(result.problems).toEqual([]);
    expect(result.damagedLines).toBe(0);
    expect(result.snapshots).toBe(200);
    const snapshots = await project.listSnapshots();
    const switches = snapshots.filter((s, i) => i > 0 && s.actor !== snapshots[i - 1]?.actor).length;
    expect(switches).toBeGreaterThan(1);
    // All in one activity session, even with both processes opening it at once.
    await expect(project.listSessions()).resolves.toHaveLength(1);
  });

  it('registers a new folder once when several processes open it together', async () => {
    const dir = await tempDir();
    const ids = await Promise.all(['a', 'b', 'c', 'd'].map((tag) => runWriter(dir, { count: 0, tag, path: '/projects/together' })));
    expect(new Set(ids).size).toBe(1);
    await expect(new HistoryStore(dir).listProjects()).resolves.toHaveLength(1);
  });
});
