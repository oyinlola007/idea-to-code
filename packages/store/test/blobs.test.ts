import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blobPath, hashOf, putBlob, readBlob } from '../src/blobs.js';
import { tempDir } from './helpers.js';

describe('blobs', () => {
  it('stores content by hash under objects/ab/cdef….gz, and reads it back', async () => {
    const dir = await tempDir();
    const hash = await putBlob(dir, 'hello');
    expect(hash).toBe(hashOf('hello'));
    expect(blobPath(dir, hash)).toBe(join(dir, 'objects', hash.slice(0, 2), `${hash.slice(2)}.gz`));
    await expect(readBlob(dir, hash)).resolves.toBe('hello');
  });

  it('stores identical content once', async () => {
    const dir = await tempDir();
    const hash = await putBlob(dir, 'same');
    await putBlob(dir, 'same');
    await expect(readdir(join(dir, 'objects', hash.slice(0, 2)))).resolves.toHaveLength(1);
  });

  it('treats a missing or damaged blob as unavailable', async () => {
    const dir = await tempDir();
    await expect(readBlob(dir, hashOf('never written'))).resolves.toBeNull();
    const hash = await putBlob(dir, 'hello');
    await writeFile(blobPath(dir, hash), 'not gzip');
    await expect(readBlob(dir, hash)).resolves.toBeNull();
  });
});
