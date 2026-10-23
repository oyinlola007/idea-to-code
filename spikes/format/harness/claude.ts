// Outside-agent route: headless Claude Code gets only plan/, GUIDE.md and the
// skill file, and is asked to change the plan. Uses the local `claude` login.
//   npm run harness:claude -- [--runs 3] [--tasks mark-done,child-flow,new-feature] [--name-skill]
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProject } from '../src/load.js';
import { addChildFlow, generatedFeature, markDone, type Check } from './assertions.js';
import type { Project } from '../src/load.js';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = join(ROOT, 'fixtures/career-app');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const RUNS = Number(arg('runs') ?? 3);
const NAME_SKILL = process.argv.includes('--name-skill');
const MODEL = arg('model') ?? 'sonnet';
const CONCURRENCY = Number(arg('concurrency') ?? 3);

async function interviewSummary(): Promise<string> {
  const text = await readFile(join(ROOT, 'fixtures/conversations/interview-prep.md'), 'utf8');
  const summary = text.split('\n\n').find((p) => p.startsWith('Assistant: Summary for the plan'));
  return (summary ?? '').replace(/^Assistant: Summary for the plan: /, '');
}

interface Task {
  id: string;
  prompt: string;
  check: (before: Project, after: Project) => Check;
}

async function tasks(): Promise<Task[]> {
  const all: Task[] = [
    {
      id: 'mark-done',
      prompt: 'We finished exporting tailored CVs to PDF and Word. Update the project plan to reflect that.',
      check: (b, a) => markDone(b, a, 'export-cv'),
    },
    {
      id: 'child-flow',
      prompt: "In the project plan, add a more detailed flow under the 'Submit application' step of job search, with 4 to 6 steps.",
      check: (b, a) => addChildFlow(b, a, 'submit-application', 4, 8),
    },
    {
      id: 'new-feature',
      prompt: `Add the interview prep feature to the project plan. We agreed on: ${await interviewSummary()}`,
      check: (b, a) => generatedFeature(b, a, { featureId: 'interview-prep', requireLlm: true, duplicatePattern: /interview/i }),
    },
  ];
  const wanted = arg('tasks')?.split(',');
  return wanted ? all.filter((t) => wanted.includes(t.id)) : all;
}

async function prepare(): Promise<string> {
  const base = process.env.PLAN_HARNESS_TMP ?? tmpdir();
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'itc-plan-'));
  await cp(join(FIXTURE, 'plan'), join(dir, 'plan'), { recursive: true });
  await cp(join(ROOT, 'guide/GUIDE.md'), join(dir, 'plan/GUIDE.md'));
  await mkdir(join(dir, '.claude/skills/plan'), { recursive: true });
  await cp(join(ROOT, 'guide/SKILL.md'), join(dir, '.claude/skills/plan/SKILL.md'));
  return dir;
}

interface RunInfo {
  usedSkill: boolean;
  readGuide: boolean;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  resultText?: string;
  exitCode: number | null;
}

function runClaude(cwd: string, prompt: string): Promise<RunInfo> {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--model', MODEL,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  return new Promise((resolvePromise) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const info: RunInfo = { usedSkill: false, readGuide: false, exitCode: null };
    let buffer = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 6 * 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          for (const part of event.message?.content ?? []) {
            if (part.type !== 'tool_use') continue;
            if (part.name === 'Skill') info.usedSkill = true;
            if (part.name === 'Read' && String(part.input?.file_path ?? '').endsWith('GUIDE.md')) info.readGuide = true;
          }
          if (event.type === 'result') {
            info.costUsd = event.total_cost_usd;
            info.turns = event.num_turns;
            info.durationMs = event.duration_ms;
            info.resultText = String(event.result ?? '').slice(0, 400);
          }
        } catch {
          // Ignore non-JSON lines.
        }
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      info.exitCode = code;
      resolvePromise(info);
    });
  });
}

interface Result extends RunInfo {
  task: string;
  run: number;
  dir: string;
  passed: boolean;
  failures: string[];
  errors: string[];
}

async function pool<T>(jobs: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]!();
      }
    }),
  );
  return out;
}

async function main() {
  const before = await loadProject(FIXTURE);
  const list = await tasks();
  const jobs = list.flatMap((task) =>
    Array.from({ length: RUNS }, (_, r) => async (): Promise<Result> => {
      const dir = await prepare();
      const prompt = NAME_SKILL ? `Use the plan skill. ${task.prompt}` : task.prompt;
      const info = await runClaude(dir, prompt);
      const check = task.check(before, await loadProject(dir));
      const result: Result = { task: task.id, run: r + 1, dir, ...info, ...check };
      console.log(`${task.id} #${r + 1}: ${check.passed ? 'PASS' : 'FAIL'} (skill ${info.usedSkill ? 'yes' : 'no'}, guide ${info.readGuide ? 'yes' : 'no'}, ${info.turns ?? '?'} turns, $${info.costUsd?.toFixed(3) ?? '?'})${check.passed ? '' : `\n   ${[...check.failures, ...check.errors].join('\n   ')}`}`);
      return result;
    }),
  );
  const results = await pool(jobs, CONCURRENCY);

  const rows = list.map((t) => {
    const rs = results.filter((r) => r.task === t.id);
    const pass = rs.filter((r) => r.passed).length;
    return `| ${t.id} | ${pass}/${rs.length} | ${rs.filter((r) => r.usedSkill).length}/${rs.length} | ${rs.filter((r) => r.readGuide).length}/${rs.length} | ${(rs.reduce((s, r) => s + (r.turns ?? 0), 0) / rs.length).toFixed(1)} | $${rs.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(2)} |`;
  });
  const total = results.filter((r) => r.passed).length;
  const table = [
    `Claude Code route (model: ${MODEL}${NAME_SKILL ? ', skill named in prompt' : ''})`,
    '',
    '| task | passed | used skill | read GUIDE.md | avg turns | cost |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    `Overall: ${total}/${results.length} (${Math.round((100 * total) / results.length)}%)`,
  ].join('\n');
  const outDir = join(ROOT, 'out/results');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(join(outDir, `claude-${stamp}.json`), JSON.stringify(results, null, 2));
  await writeFile(join(outDir, `claude-${stamp}.md`), table);
  console.log(`\n${table}`);
}

await main();
