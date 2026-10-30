// Can a real coding agent keep a plan correct from the generated files alone?
// Headless Claude Code, given only plan/, GUIDE.md and the skill, in a temp folder.
// The prompts never mention the guide. Uses the local `claude` login.
// Usage: pnpm --filter @idea-to-code/core run agent-check -- [--runs 3] [--model sonnet]
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addConnector } from '../src/connectors.js';
import { generateGuide } from '../src/guide.js';
import { loadFromTexts, type Project } from '../src/load.js';
import { addChildFlow, generatedFeature, markDone, type Check } from './agentChecks.js';
import { readPlanTexts } from './readPlan.js';

const FIXTURE = fileURLToPath(new URL('../test/fixtures/toolshed', import.meta.url));
const PASS_BAR = 0.9;

const { values } = parseArgs({
  options: { runs: { type: 'string', default: '3' }, model: { type: 'string', default: 'sonnet' } },
  allowPositionals: true,
});

const REMINDERS_SUMMARY = `the system finds bookings starting tomorrow, then checks whether the member allows text messages. If yes it builds the reminder and sends it through the SMS service, then logs that it was sent; if no it just logs a skip. Building the reminder deserves its own detailed flow: pick the language, fill in the tool and pickup place, and keep it under 160 characters. Quiet hours mean nothing is sent between 9pm and 8am, because neighbours complained in the pilot.`;

interface Task {
  id: string;
  prompt: string;
  check: (before: Project, after: Project) => Check;
}

const TASKS: Task[] = [
  {
    id: 'mark-done',
    prompt: 'We finished recording deposits once a payment succeeds. Update the project plan to reflect that.',
    check: (b, a) => markDone(b, a, 'record-deposit'),
  },
  {
    id: 'child-flow',
    prompt: "In the project plan, add a more detailed flow under the 'Join the waitlist' step of bookings, with 4 to 6 steps.",
    check: (b, a) => addChildFlow(b, a, 'join-waitlist'),
  },
  {
    id: 'new-feature',
    prompt: `Add the reminders feature to the project plan. We agreed on: ${REMINDERS_SUMMARY}`,
    check: (b, a) =>
      generatedFeature(b, a, { featureId: 'reminders', minMainNodes: 5, requiredRef: 'sms-service', duplicatePattern: /remind/i }),
  },
];

async function prepare(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'itc-agent-check-'));
  await cp(join(FIXTURE, 'plan'), join(dir, 'plan'), { recursive: true });
  await writeFile(join(dir, 'plan/GUIDE.md'), generateGuide());
  const skill = addConnector('claude-skill', null);
  if (skill.status === 'refused' || skill.text === null) throw new Error('could not generate the skill');
  const skillPath = join(dir, '.claude/skills/plan/SKILL.md');
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, skill.text);
  return dir;
}

interface RunInfo {
  usedSkill: boolean;
  readGuide: boolean;
  turns?: number;
}

interface StreamEvent {
  type?: string;
  num_turns?: number;
  message?: { content?: { type?: string; name?: string; input?: { file_path?: string } }[] };
}

function runClaude(cwd: string, prompt: string): Promise<RunInfo> {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    values.model,
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'Skill',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const info: RunInfo = { usedSkill: false, readGuide: false };
    let buffer = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 6 * 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        let event: StreamEvent;
        try {
          event = JSON.parse(line) as StreamEvent;
        } catch {
          continue;
        }
        for (const part of event.message?.content ?? []) {
          if (part.type !== 'tool_use') continue;
          if (part.name === 'Skill') info.usedSkill = true;
          if (part.name === 'Read' && (part.input?.file_path ?? '').endsWith('GUIDE.md')) info.readGuide = true;
        }
        if (event.type === 'result' && event.num_turns !== undefined) info.turns = event.num_turns;
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

const before = loadFromTexts(await readPlanTexts(FIXTURE));
const runs = Number(values.runs);
const jobs = TASKS.flatMap((task) => Array.from({ length: runs }, (_, run) => ({ task, run: run + 1 })));

const results = await Promise.all(
  jobs.map(async ({ task, run }) => {
    const dir = await prepare();
    const info = await runClaude(dir, task.prompt);
    const check = task.check(before, loadFromTexts(await readPlanTexts(dir)));
    console.log(
      `${task.id} #${run}: ${check.passed ? 'PASS' : 'FAIL'} (skill ${info.usedSkill ? 'yes' : 'no'}, guide ${info.readGuide ? 'yes' : 'no'}, ${info.turns ?? '?'} turns) ${[...check.failures, ...check.errors].join('; ')}`,
    );
    return { task: task.id, check, info, dir };
  }),
);

console.log('\n| task | passed | found the skill | read GUIDE.md |\n|---|---|---|---|');
for (const task of TASKS) {
  const rows = results.filter((r) => r.task === task.id);
  console.log(
    `| ${task.id} | ${rows.filter((r) => r.check.passed).length}/${rows.length} | ${rows.filter((r) => r.info.usedSkill).length}/${rows.length} | ${rows.filter((r) => r.info.readGuide).length}/${rows.length} |`,
  );
}
const passed = results.filter((r) => r.check.passed).length;
console.log(`\nOverall: ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%), bar ${PASS_BAR * 100}%`);
process.exit(passed / results.length >= PASS_BAR ? 0 : 1);
