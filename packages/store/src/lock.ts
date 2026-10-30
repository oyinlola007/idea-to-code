// A lock file shared by every process that writes to the store (the extension
// in any editor, the MCP server). Creating it with "wx" is the mutual exclusion.
// A stale lock is removed under a guard file: two processes can both judge the
// same lock stale, and the second must not remove the first one's fresh lock.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { StoreError } from './errors.js';

export interface LockInfo {
  pid: number;
  host: string;
  at: number;
  token: string;
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return codeOf(err) === 'EPERM';
  }
}

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.at === 'number') return parsed as LockInfo;
  } catch {
    // Missing, empty (a writer between open and write) or unparsable.
  }
  return null;
}

export async function isStale(path: string, staleMs: number): Promise<boolean> {
  const info = await readLock(path);
  if (!info) {
    // Unreadable: judge by age, so a crash between open and write still recovers.
    try {
      return Date.now() - (await stat(path)).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
  if (info.host === hostname() && !pidAlive(info.pid)) return true;
  return Date.now() - info.at > staleMs;
}

async function tryAcquire(path: string): Promise<LockInfo | null> {
  const info: LockInfo = { pid: process.pid, host: hostname(), at: Date.now(), token: randomUUID() };
  try {
    const fh = await open(path, 'wx');
    try {
      await fh.writeFile(JSON.stringify(info));
      await fh.sync();
    } finally {
      await fh.close();
    }
    return info;
  } catch (err) {
    if (codeOf(err) === 'EEXIST') return null;
    throw err;
  }
}

async function steal(path: string, staleMs: number): Promise<void> {
  const guard = `${path}.steal`;
  let fh;
  try {
    fh = await open(guard, 'wx');
  } catch (err) {
    if (codeOf(err) !== 'EEXIST') throw err;
    // Another stealer is on it. A guard left by a crash is cleared once it's old.
    const age = await stat(guard).then(
      (s) => Date.now() - s.mtimeMs,
      () => 0,
    );
    if (age > staleMs) await unlink(guard).catch(() => undefined);
    return;
  }
  try {
    if (!(await isStale(path, staleMs))) return;
    const aside = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, aside);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return;
      throw err;
    }
    await unlink(aside).catch(() => undefined);
  } finally {
    await fh.close();
    await unlink(guard).catch(() => undefined);
  }
}

async function release(path: string, token: string): Promise<void> {
  const info = await readLock(path);
  if (info?.token === token) await unlink(path).catch(() => undefined);
}

export async function withLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  let held = await tryAcquire(path);
  while (!held) {
    if (await isStale(path, staleMs)) {
      await steal(path, staleMs);
      await sleep(Math.random() * 3);
    } else {
      if (Date.now() > deadline) throw new StoreError('lock-timeout', `could not take ${path} within ${timeoutMs}ms`);
      await sleep(2 + Math.random() * 13);
    }
    held = await tryAcquire(path);
  }
  try {
    return await fn();
  } finally {
    await release(path, held.token);
  }
}
