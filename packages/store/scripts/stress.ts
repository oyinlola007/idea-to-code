// Several processes writing to one store at once, then checks nothing was lost
// or corrupted. Exits non-zero on any problem. Usage: pnpm --filter @idea-to-code/store run stress
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryStore } from '../src/history.js';

const WRITER = fileURLToPath(new URL('./writer.ts', import.meta.url));

export function runWriter(dir: string, args: { count: number; tag: string; path?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        WRITER,
        '--dir',
        dir,
        '--count',
        String(args.count),
        '--tag',
        args.tag,
        '--path',
        args.path ?? '/projects/stress',
      ],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${args.tag} exited with ${code}`));
    });
  });
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'itc-store-stress-'));
  const count = Number(process.argv[2] ?? 500);
  const started = Date.now();
  const ids = await Promise.all([runWriter(dir, { count, tag: 'a' }), runWriter(dir, { count, tag: 'b' })]);
  const projects = await new HistoryStore(dir).listProjects();
  const failures: string[] = [];
  if (new Set(ids).size !== 1 || projects.length !== 1) failures.push(`expected one project, got ${projects.length}`);
  const opened = await new HistoryStore(dir).openProject({ path: '/projects/stress', texts: {} });
  const result = await opened.project.verify();
  const snapshots = await opened.project.listSnapshots();
  const switches = snapshots.filter((s, i) => i > 0 && s.actor !== snapshots[i - 1]?.actor).length;
  console.log(
    `${result.snapshots} snapshots, ${result.blobs} blobs, ${switches} writer switches, ${result.problems.length} problems, ${Date.now() - started}ms`,
  );
  if (result.snapshots !== count * 2) failures.push(`expected ${count * 2} snapshots, got ${result.snapshots}`);
  failures.push(...result.problems);
  if (failures.length > 0) {
    console.error(`FAIL\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
