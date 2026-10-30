// Runs the in-editor suite in each editor and scenario, on fresh copies of the
// Toolshed plan with their own history folders. Usage:
//   pnpm --filter idea-to-code run test:ext -- [--editor vscode|cursor|vscodium|all] [--version 1.90.0] [--scenario plan|empty|restricted]
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Launched from a terminal inside VS Code, this is inherited and would start the editor as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../core/test/fixtures/toolshed', import.meta.url));
const SUITE = join(ROOT, 'out', 'test', 'suite.cjs');
const SCENARIOS = ['plan', 'empty', 'restricted'];

interface Target {
  executable?: string;
  version?: string;
}

const EDITORS: Record<string, Target> = {
  vscode: { version: '1.139.1' },
  cursor: { executable: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
  vscodium: { executable: '/Applications/VSCodium.app/Contents/MacOS/VSCodium' },
};

const { values } = parseArgs({
  options: { editor: { type: 'string', default: 'all' }, version: { type: 'string' }, scenario: { type: 'string' } },
  allowPositionals: true,
});

async function runOne(label: string, target: Target, scenario: string): Promise<boolean> {
  const tmp = await mkdtemp(join(tmpdir(), 'itc-ext-'));
  const workspace = join(tmp, 'toolshed');
  if (scenario === 'empty') await mkdir(workspace);
  else await cp(FIXTURE, workspace, { recursive: true });
  // Forks may reload while setting up a brand-new profile, which ends a run; a persistent one settles.
  const userData = label in EDITORS ? join(tmpdir(), `itc-p-${label}`) : join(tmp, 'u');
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
    }),
  );
  console.log(`\n▶ ${label} / ${scenario}`);
  try {
    await runTests({
      ...(target.executable ? { vscodeExecutablePath: target.executable } : { version: target.version ?? 'stable' }),
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: SUITE,
      launchArgs: [
        workspace,
        '--user-data-dir',
        userData,
        '--extensions-dir',
        join(tmp, 'x'),
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
      ],
      extensionTestsEnv: {
        ITC_SCENARIO: scenario,
        IDEA_TO_CODE_DATA: join(tmp, 'data'),
        // VS Code always trusts a test run, so Restricted Mode has to be simulated.
        ...(scenario === 'restricted' ? { IDEA_TO_CODE_TEST_RESTRICTED: '1' } : {}),
      },
      timeout: 5 * 60_000,
    });
    console.log(`✔ ${label} / ${scenario}`);
    return true;
  } catch (err) {
    console.log(`✘ ${label} / ${scenario}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

await build({
  entryPoints: [join(ROOT, 'test', 'suite', 'index.ts')],
  outfile: SUITE,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  logLevel: 'warning',
});

const targets: [string, Target][] = values.version
  ? [[`vscode-${values.version}`, { version: values.version }]]
  : Object.entries(EDITORS).filter(([name]) => values.editor === 'all' || name === values.editor);
const scenarios = values.scenario ? [values.scenario] : SCENARIOS;

const failed: string[] = [];
for (const [label, target] of targets) {
  for (const scenario of scenarios) {
    if (!(await runOne(label, target, scenario))) failed.push(`${label} / ${scenario}`);
  }
}
console.log(failed.length === 0 ? '\nAll passed.' : `\nFailed: ${failed.join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
