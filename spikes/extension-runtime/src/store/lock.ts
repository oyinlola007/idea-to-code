// A per-project lock file shared by every process that writes to the store
// (the extension in any editor, the MCP server, scripts). Creation with "wx"
// is the mutual exclusion; a stale lock is stolen by renaming it away, which
// only one stealer can win.
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';

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

export class LockTimeout extends Error {
  constructor(path: string, ms: number) {
    super(`could not take ${path} within ${ms}ms`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as LockInfo;
    if (typeof parsed.pid === 'number' && typeof parsed.at === 'number') return parsed;
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
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
}

/**
 * Removes a stale lock. Two processes can both judge the same lock stale; if
 * the first steals it and takes a fresh lock, the second must not remove that
 * fresh one. So stealers serialise on a guard file and re-check staleness
 * while holding it. A guard left by a crash is cleared once it's older than
 * staleMs (the window is a few file operations long).
 */
async function steal(path: string, staleMs: number): Promise<void> {
  const guard = `${path}.steal`;
  let fh;
  try {
    fh = await open(guard, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const age = await stat(guard).then((s) => Date.now() - s.mtimeMs, () => 0);
    if (age > staleMs) await unlink(guard).catch(() => {});
    return; // another stealer is on it; retry the lock
  }
  try {
    if (!(await isStale(path, staleMs))) return;
    const aside = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    await unlink(aside).catch(() => {});
  } finally {
    await fh.close();
    await unlink(guard).catch(() => {});
  }
}

async function release(path: string, token: string): Promise<void> {
  const info = await readLock(path);
  if (info?.token === token) await unlink(path).catch(() => {});
}

export async function withLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let held: LockInfo | null = null;
  while (!(held = await tryAcquire(path))) {
    if (await isStale(path, staleMs)) {
      await steal(path, staleMs);
      await sleep(Math.random() * 3);
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeout(path, timeoutMs);
    await sleep(2 + Math.random() * 13);
  }
  try {
    return await fn();
  } finally {
    await release(path, held.token);
  }
}
