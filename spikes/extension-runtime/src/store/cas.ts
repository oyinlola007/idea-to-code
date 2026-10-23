// The concurrency test bed for the history store: content-addressed gzip
// blobs plus an append-only index per project. Blobs need no lock (same
// content, same name); the index append and its parent lookup do.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { withLock, type LockOptions } from './lock.js';

export interface SnapshotRecord {
  id: string;
  parent: string | null;
  at: number;
  writer: string;
  seq: number;
  files: Record<string, string>;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export class Store {
  constructor(
    readonly dir: string,
    readonly projectId: string,
    private readonly lockOptions: LockOptions = {},
  ) {}

  get projectDir() {
    return join(this.dir, 'projects', this.projectId);
  }
  get indexPath() {
    return join(this.projectDir, 'index.jsonl');
  }
  get lockPath() {
    return join(this.projectDir, 'lock');
  }
  blobPath(hash: string) {
    return join(this.dir, 'objects', hash.slice(0, 2), `${hash.slice(2)}.gz`);
  }

  /** Writes a blob once; returns its hash and whether it already existed. */
  async putBlob(content: string): Promise<{ hash: string; existed: boolean }> {
    const hash = sha256(content);
    const path = this.blobPath(hash);
    try {
      await stat(path);
      return { hash, existed: true };
    } catch {
      // not there yet
    }
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${randomUUID()}`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(gzipSync(content));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    return { hash, existed: false };
  }

  async appendSnapshot(files: Record<string, string>, meta: { writer: string; seq: number }): Promise<SnapshotRecord & { dedup: number }> {
    const hashes: Record<string, string> = {};
    let dedup = 0;
    for (const [path, content] of Object.entries(files)) {
      const { hash, existed } = await this.putBlob(content);
      hashes[path] = hash;
      if (existed) dedup++;
    }
    await mkdir(this.projectDir, { recursive: true });
    return withLock(
      this.lockPath,
      async () => {
        const last = await this.lastRecord();
        const record: SnapshotRecord = { id: randomUUID(), parent: last?.id ?? null, at: Date.now(), writer: meta.writer, seq: meta.seq, files: hashes };
        const fh = await open(this.indexPath, 'a');
        try {
          await fh.appendFile(`${JSON.stringify(record)}\n`);
          await fh.sync();
        } finally {
          await fh.close();
        }
        return { ...record, dedup };
      },
      this.lockOptions,
    );
  }

  private async lastRecord(): Promise<SnapshotRecord | null> {
    let text: string;
    try {
      text = await readFile(this.indexPath, 'utf8');
    } catch {
      return null;
    }
    const lines = text.trimEnd().split('\n');
    const last = lines[lines.length - 1];
    return last ? (JSON.parse(last) as SnapshotRecord) : null;
  }

  async readIndex(): Promise<{ records: SnapshotRecord[]; problems: string[] }> {
    const problems: string[] = [];
    const records: SnapshotRecord[] = [];
    let text = '';
    try {
      text = await readFile(this.indexPath, 'utf8');
    } catch {
      return { records, problems };
    }
    if (text && !text.endsWith('\n')) problems.push('index does not end with a newline (torn write)');
    text
      .split('\n')
      .filter(Boolean)
      .forEach((line, i) => {
        try {
          records.push(JSON.parse(line) as SnapshotRecord);
        } catch {
          problems.push(`line ${i + 1} is not valid JSON`);
        }
      });
    return { records, problems };
  }

  /** Every problem found: torn lines, a broken parent chain, missing or corrupt blobs, leftovers. */
  async verify(): Promise<{ records: number; blobs: number; problems: string[] }> {
    const { records, problems } = await this.readIndex();
    const ids = new Set<string>();
    const hashes = new Set<string>();
    records.forEach((r, i) => {
      if (ids.has(r.id)) problems.push(`duplicate id ${r.id}`);
      ids.add(r.id);
      const expected = i === 0 ? null : records[i - 1]!.id;
      if (r.parent !== expected) problems.push(`record ${i + 1} has parent ${r.parent}, expected ${expected}`);
      for (const h of Object.values(r.files)) hashes.add(h);
    });
    for (const h of hashes) {
      try {
        const content = gunzipSync(await readFile(this.blobPath(h)));
        if (sha256(content) !== h) problems.push(`blob ${h} does not match its hash`);
      } catch {
        problems.push(`blob ${h} is missing or unreadable`);
      }
    }
    for (const leftover of await this.leftovers()) problems.push(`leftover ${leftover}`);
    return { records: records.length, blobs: hashes.size, problems };
  }

  private async leftovers(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.includes('.tmp-') || e.name.includes('.stale-') || e.name.endsWith('.steal') || e.name === 'lock') found.push(p);
      }
    };
    await walk(this.dir);
    return found;
  }
}

/** Plan-like content for stress writes; repeats now and then so dedup is exercised. */
export function sampleFiles(seq: number, writer: string): Record<string, string> {
  const shared = `project: Stress\nfeatures:\n${Array.from({ length: 12 }, (_, i) => `  - id: f${i}\n    label: Feature ${i}\n`).join('')}`;
  return {
    'plan/map.yaml': seq % 5 === 0 ? shared : `${shared}# ${writer} ${seq}\n`,
    'plan/features/f1.yaml': `feature: f1\nflows:\n  main:\n    label: F1\n    nodes:\n      - id: s${seq % 7}\n        type: step\n        label: Step ${seq % 7}\n`,
  };
}

export async function appendLog(path: string, line: string) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`);
}
