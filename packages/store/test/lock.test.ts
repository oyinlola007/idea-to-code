import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StoreError } from '../src/errors.js';
import { withLock } from '../src/lock.js';
import { tempDir } from './helpers.js';

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid ?? 0;
}

describe('lock', () => {
  it('lets one caller in at a time', async () => {
    const path = join(await tempDir(), 'lock');
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withLock(path, async () => {
          inside++;
          most = Math.max(most, inside);
          await new Promise((r) => setTimeout(r, 2));
          inside--;
        }),
      ),
    );
    expect(most).toBe(1);
  });

  it('recovers a lock left by a dead process', async () => {
    const path = join(await tempDir(), 'lock');
    await writeFile(path, JSON.stringify({ pid: await deadPid(), host: hostname(), at: Date.now(), token: 'dead' }));
    await expect(withLock(path, () => Promise.resolve('in'), { staleMs: 60_000, timeoutMs: 3_000 })).resolves.toBe('in');
  });

  it('recovers an old lock from another machine', async () => {
    const path = join(await tempDir(), 'lock');
    await writeFile(path, JSON.stringify({ pid: 1, host: 'elsewhere', at: Date.now() - 10_000, token: 'old' }));
    await expect(withLock(path, () => Promise.resolve('in'), { staleMs: 1_000, timeoutMs: 3_000 })).resolves.toBe('in');
  });

  it('recovers an empty lock from a crash between creating and writing it', async () => {
    const path = join(await tempDir(), 'lock');
    await writeFile(path, '');
    await new Promise((r) => setTimeout(r, 30));
    await expect(withLock(path, () => Promise.resolve('in'), { staleMs: 10, timeoutMs: 3_000 })).resolves.toBe('in');
  });

  it('waits for, and does not steal, a live lock', async () => {
    const path = join(await tempDir(), 'lock');
    await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token: 'live' }));
    const failure = await withLock(path, () => Promise.resolve(), { staleMs: 60_000, timeoutMs: 200 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as StoreError).code).toBe('lock-timeout');
    expect((JSON.parse(await readFile(path, 'utf8')) as { token: string }).token).toBe('live');
  });

  it("does not delete someone else's lock on release", async () => {
    const path = join(await tempDir(), 'lock');
    await withLock(path, () => writeFile(path, JSON.stringify({ pid: 1, host: 'x', at: Date.now(), token: 'theirs' })));
    expect((JSON.parse(await readFile(path, 'utf8')) as { token: string }).token).toBe('theirs');
  });

  it('lets only one of many racing stealers in at a time', async () => {
    const path = join(await tempDir(), 'lock');
    await writeFile(path, JSON.stringify({ pid: await deadPid(), host: hostname(), at: Date.now(), token: 'dead' }));
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withLock(
          path,
          async () => {
            inside++;
            most = Math.max(most, inside);
            await new Promise((r) => setTimeout(r, 3));
            inside--;
          },
          { staleMs: 60_000, timeoutMs: 5_000 },
        ),
      ),
    );
    expect(most).toBe(1);
  });
});
