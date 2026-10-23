// Runs the in-editor suite (test/suite) in each editor, each in a fresh
// profile on a fresh copy of the career-app plan, then prints the matrix.
// Usage:
//   npm run test:ext -- --editor vscode|cursor|vscodium|all [--themes] [--quick]
//   npm run test:ext -- --version 1.100.0 --quick     (a downloaded VS Code build)
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runTests } from '@vscode/test-electron';

// Launched from a terminal inside VS Code, this is inherited and would start the editor as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, '..', 'format', 'fixtures', 'career-app');
const RESULTS = join(ROOT, 'out', 'results');

const EDITORS: Record<string, { executable?: string; version?: string }> = {
  // A downloaded build of the installed version: this session runs inside the installed app.
  vscode: { version: '1.139.1' },
  cursor: { executable: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
  vscodium: { executable: '/Applications/VSCodium.app/Contents/MacOS/VSCodium' },
};

const { values } = parseArgs({
  options: {
    editor: { type: 'string', default: 'all' },
    version: { type: 'string' },
    themes: { type: 'boolean', default: false },
    quick: { type: 'boolean', default: false },
  },
});

async function runOne(label: string, target: { executable?: string; version?: string }) {
  const tmp = await mkdtemp(join(tmpdir(), `itc-ext-${label}-`));
  const workspace = join(tmp, 'career-app');
  await cp(FIXTURE, workspace, { recursive: true });
  // Forks may reload their window while setting up a brand-new profile (seen in
  // Cursor), which ends a test run; a persistent profile settles after one run.
  const userData = label in EDITORS ? join(tmpdir(), `itc-profile-${label}`) : join(tmp, 'user-data');
  await mkdir(join(userData, 'User'), { recursive: true });
  await writeFile(
    join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'security.workspace.trust.enabled': false,
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'telemetry.telemetryLevel': 'off',
      'workbench.tips.enabled': false,
      'chat.commandCenter.enabled': false,
    }),
  );
  console.log(`\n▶ ${label} (${target.executable ?? `VS Code ${target.version}`})`);
  try {
    await runTests({
      ...(target.executable ? { vscodeExecutablePath: target.executable } : { version: target.version! }),
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: join(ROOT, 'out', 'test', 'suite.cjs'),
      launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', join(tmp, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
      extensionTestsEnv: {
        ITC_TARGET: label,
        ITC_RESULTS_DIR: RESULTS,
        ITC_THEMES_DIR: join(ROOT, 'out', 'themes'),
        ITC_DUMP_THEMES: values.themes ? '1' : '0',
        ITC_QUICK: values.quick ? '1' : '0',
        IDEA_TO_CODE_SPIKE_STORE: join(tmp, 'app-data'),
      },
      timeout: 10 * 60_000,
    });
    console.log(`✔ ${label}: all steps passed`);
  } catch (err) {
    console.log(`✘ ${label}: ${(err as Error).message}`);
  }
}

interface Result {
  target: string;
  app: string;
  steps: { name: string; ok: boolean; ms: number; detail?: unknown; error?: string }[];
}

async function matrix() {
  await mkdir(RESULTS, { recursive: true });
  const files = (await readdir(RESULTS).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
  const results: Result[] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(RESULTS, f), 'utf8')) as Result));
  results.sort((a, b) => a.target.localeCompare(b.target));
  const names = [...new Set(results.flatMap((r) => r.steps.map((s) => s.name)))];
  const lines = [`| step | ${results.map((r) => `${r.target} (${r.app})`).join(' | ')} |`, `|---|${results.map(() => '---').join('|')}|`];
  for (const n of names) {
    lines.push(
      `| ${n} | ${results
        .map((r) => {
          const s = r.steps.find((x) => x.name === n);
          if (!s) return '–';
          if (s.name.endsWith('(finding)')) {
            return Object.entries(s.detail as Record<string, { works: boolean }>)
              .map(([k, v]) => `${k} ${v.works ? '✅' : '❌'}`)
              .join(' · ');
          }
          if (s.name.startsWith('runtime report') && s.ok) {
            const d = s.detail as { lm: { present: boolean; models: unknown[] }; mcp: { present: boolean } };
            return `✅ LM API ${d.lm.present ? `yes (${d.lm.models.length} models)` : 'no'} · MCP API ${d.mcp.present ? 'yes' : 'no'}`;
          }
          return s.ok ? '✅' : `❌ ${(s.error ?? '').slice(0, 80).replace(/\|/g, '/')}`;
        })
        .join(' | ')} |`,
    );
  }
  const md = lines.join('\n');
  await writeFile(join(RESULTS, 'matrix.md'), `${md}\n`);
  console.log(`\n${md}`);
}

const targets = values.version
  ? { [`vscode-${values.version}`]: { version: values.version } }
  : values.editor === 'all'
    ? EDITORS
    : { [values.editor!]: EDITORS[values.editor!]! };
for (const [label, target] of Object.entries(targets)) await runOne(label, target);
await matrix();
