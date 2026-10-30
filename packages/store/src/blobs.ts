// Content-addressed file versions: each distinct content is stored once, named
// by its hash. No lock needed, because the same content always gets the same name.
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { atomicWrite } from './files.js';

export function hashOf(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function blobPath(dataDir: string, hash: string): string {
  return join(dataDir, 'objects', hash.slice(0, 2), `${hash.slice(2)}.gz`);
}

export async function putBlob(dataDir: string, content: string): Promise<string> {
  const hash = hashOf(content);
  const path = blobPath(dataDir, hash);
  try {
    await access(path);
  } catch {
    await atomicWrite(path, gzipSync(content));
  }
  return hash;
}

/** A blob's content, or null when it's missing or doesn't match its hash. */
export async function readBlob(dataDir: string, hash: string): Promise<string | null> {
  try {
    const content = gunzipSync(await readFile(blobPath(dataDir, hash)));
    return hashOf(content) === hash ? content.toString('utf8') : null;
  } catch {
    return null;
  }
}
