import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deadPid, plantLock, runWriter } from '../scripts/store-stress.js';
import { Store } from '../src/store/cas.js';
import { withLock } from '../src/store/lock.js';

const fresh = () => mkdtemp(join(tmpdir(), 'itc-store-test-'));

describe('store under two writer processes', () => {
  it('keeps a linear chain and intact blobs over 2 × 100 interleaved writes', async () => {
    const dir = await fresh();
    await Promise.all([runWriter(dir, { count: 100, tag: 'a' }), runWriter(dir, { count: 100, tag: 'b' })]);
    const store = new Store(dir, 'stress');
    const { records } = await store.readIndex();
    const result = await store.verify();
    expect(result.problems).toEqual([]);
    expect(result.records).toBe(200);
    // Interleaved, not one writer after the other.
    const switches = records.filter((r, i) => i > 0 && r.writer !== records[i - 1]!.writer).length;
    expect(switches).toBeGreaterThan(1);
    // Content addressing dedups the repeated files.
    expect(result.blobs).toBeLessThan(400);
  });
});

describe('lock', () => {
  it('recovers a lock left by a dead process', async () => {
    const store = new Store(await fresh(), 'p', { staleMs: 60_000, timeoutMs: 3_000 });
    await plantLock(store, { pid: await deadPid(), host: hostname(), at: Date.now() });
    await store.appendSnapshot({ a: '1' }, { writer: 't', seq: 0 });
    expect((await store.verify()).problems).toEqual([]);
  });

  it('recovers an aged lock from another host', async () => {
    const store = new Store(await fresh(), 'p', { staleMs: 1_000, timeoutMs: 3_000 });
    await plantLock(store, { pid: 1, host: 'elsewhere', at: Date.now() - 10_000 });
    await store.appendSnapshot({ a: '1' }, { writer: 't', seq: 0 });
    expect((await store.verify()).problems).toEqual([]);
  });

  it('waits for, and does not steal, a live fresh lock', async () => {
    const store = new Store(await fresh(), 'p', { staleMs: 60_000, timeoutMs: 300 });
    await plantLock(store, { pid: process.pid, host: hostname(), at: Date.now() });
    await expect(store.appendSnapshot({ a: '1' }, { writer: 't', seq: 0 })).rejects.toThrow(/could not take/);
    expect(JSON.parse(await readFile(store.lockPath, 'utf8')).token).toBe('planted');
  });

  it("does not delete someone else's lock on release", async () => {
    const path = join(await fresh(), 'lock');
    await withLock(path, async () => {
      // Simulate our lock being stolen and replaced while we held it.
      await writeFile(path, JSON.stringify({ pid: 1, host: 'x', at: Date.now(), token: 'theirs' }));
    });
    expect(JSON.parse(await readFile(path, 'utf8')).token).toBe('theirs');
  });

  it('lets only one of many racing stealers in at a time', async () => {
    const dir = await fresh();
    const path = join(dir, 'lock');
    await writeFile(path, JSON.stringify({ pid: await deadPid(), host: hostname(), at: Date.now(), token: 'dead' }));
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withLock(
          path,
          async () => {
            inside++;
            maxInside = Math.max(maxInside, inside);
            await new Promise((r) => setTimeout(r, 3));
            inside--;
          },
          { staleMs: 60_000, timeoutMs: 5_000 },
        ),
      ),
    );
    expect(maxInside).toBe(1);
  });

  it('lets exactly one of many concurrent callers in at a time', async () => {
    const path = join(await fresh(), 'lock');
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withLock(path, async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 2));
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });
});
