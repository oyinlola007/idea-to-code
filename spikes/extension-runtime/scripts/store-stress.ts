// Local stress run for the store: two Node writers at once, then the two
// stale-lock cases. Exits non-zero on any problem. Usage: npm run store:stress
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/cas.js';

const writer = fileURLToPath(new URL('./store-writer.ts', import.meta.url));

export function runWriter(dir: string, args: { count: number; tag: string; project?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', writer, '--dir', dir, '--project', args.project ?? 'stress', '--count', String(args.count), '--tag', args.tag], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${args.tag} exited ${code}`))));
  });
}

export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid!;
  await new Promise((r) => child.on('exit', r));
  return pid;
}

export async function plantLock(store: Store, info: { pid: number; host: string; at: number }) {
  await mkdir(store.projectDir, { recursive: true });
  await writeFile(store.lockPath, JSON.stringify({ ...info, token: 'planted' }));
}

async function main() {
  const failures: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'itc-store-'));
  const count = Number(process.argv[2] ?? 500);

  const started = Date.now();
  const outs = await Promise.all([runWriter(dir, { count, tag: 'a' }), runWriter(dir, { count, tag: 'b' })]);
  const store = new Store(dir, 'stress');
  const result = await store.verify();
  console.log(outs.join('\n'));
  console.log(`interleaved: ${result.records} records, ${result.blobs} blobs, ${result.problems.length} problems, ${Date.now() - started}ms`);
  if (result.records !== count * 2) failures.push(`expected ${count * 2} records, got ${result.records}`);
  failures.push(...result.problems);

  const { hostname } = await import('node:os');
  for (const [name, info] of [
    ['dead pid', { pid: await deadPid(), host: hostname(), at: Date.now() }],
    ['aged lock from another host', { pid: 1, host: 'some-other-host', at: Date.now() - 60_000 }],
  ] as const) {
    const s = new Store(dir, `stale-${name.replace(/\W+/g, '-')}`, { staleMs: 2_000, timeoutMs: 5_000 });
    await plantLock(s, info);
    const t = Date.now();
    try {
      await s.appendSnapshot({ 'plan/map.yaml': name }, { writer: 'stale-test', seq: 0 });
      const v = await s.verify();
      console.log(`stale lock (${name}): recovered in ${Date.now() - t}ms, ${v.problems.length} problems`);
      failures.push(...v.problems);
    } catch (err) {
      failures.push(`stale lock (${name}) not recovered: ${(err as Error).message}`);
    }
  }

  if (failures.length) {
    console.error(`FAIL\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`PASS (store at ${dir})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
