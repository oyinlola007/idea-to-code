// Real Claude Code sessions through the MCP server, on temp copies of the fictitious
// Toolshed plan. Uses the local `claude` login.
//   plan:  plan a whole feature with the MCP tools only.
//   build: write the code for one step, link it in the plan and mark it done.
// Usage: pnpm --filter idea-to-code-mcp run claude-check -- [--task plan|build|all] [--model sonnet]
import { errorsOf, indexProject, loadFromTexts, validateProject } from '@idea-to-code/core';
import { HistoryStore, NodePlanFiles } from '@idea-to-code/store';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generatedFeature } from '../../core/scripts/agentChecks.js';

const BUNDLE = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const TOOLSHED = fileURLToPath(new URL('../../core/test/fixtures/toolshed/plan', import.meta.url));
const { values } = parseArgs({
  // pnpm passes the "--" along, and everything after one would be ignored as a positional.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { model: { type: 'string', default: 'sonnet' }, task: { type: 'string', default: 'all' } },
  allowPositionals: true,
});

const PLAN_PROMPT = `Add the reminders feature to the project plan. We agreed on: the system finds bookings starting tomorrow, then checks whether the member allows text messages. If yes it builds the reminder and sends it through the SMS service, then logs that it was sent; if no it just logs a skip. Building the reminder deserves its own detailed flow: pick the language, fill in the tool and pickup place, and keep it under 160 characters. Quiet hours mean nothing is sent between 9pm and 8am, because neighbours complained in the pilot.`;

const BUILD_PROMPT = `Build the "Confirm booking" step: create src/bookings/confirm.ts with a function confirmBooking(id: string): string that returns a short confirmation message. Then update the project plan.`;

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(relative(base, full));
  }
  return out.sort();
}

async function readPlan(root: string): Promise<Record<string, string>> {
  const files = new NodePlanFiles(root);
  const texts: Record<string, string> = {};
  for (const path of await files.listPlanFiles()) texts[path] = (await files.read(path)) ?? '';
  return texts;
}

interface StreamEvent {
  type?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  message?: { content?: { type?: string; name?: string; is_error?: boolean }[] };
}

interface Run {
  tools: string[];
  errors: number;
  result?: StreamEvent;
}

function runClaude(cwd: string, config: string, prompt: string, allowed: string[]): Promise<Run> {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    values.model,
    '--mcp-config',
    config,
    '--strict-mcp-config',
    '--allowedTools',
    ...allowed,
    '--permission-mode',
    'acceptEdits',
    '--no-session-persistence',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    const run: Run = { tools: [], errors: 0 };
    let buffer = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 8 * 60_000);
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
          if (part.type === 'tool_use' && part.name) run.tools.push(part.name.replace('mcp__idea-to-code__', ''));
          if (part.type === 'tool_result' && part.is_error) run.errors++;
        }
        if (event.type === 'result') run.result = event;
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(run);
    });
  });
}

/** A temp project holding a Toolshed copy, with history in its own folder and the server configured for it. */
async function withProject(name: string, fn: (project: string, data: string, config: string) => Promise<boolean>): Promise<boolean> {
  const work = await mkdtemp(join(tmpdir(), `itc-claude-${name}-`));
  try {
    const project = join(work, 'project');
    const data = join(work, 'data');
    await cp(TOOLSHED, join(project, 'plan'), { recursive: true });
    const config = join(work, 'mcp.json');
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: { 'idea-to-code': { command: process.execPath, args: [BUNDLE, '--root', project], env: { IDEA_TO_CODE_DATA: data } } },
      }),
    );
    return await fn(project, data, config);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function describeRun(run: Run): void {
  const usage = run.result?.usage;
  console.log(`tool calls: ${run.tools.join(', ') || 'none'}`);
  console.log(`failed calls: ${String(run.errors)}, turns: ${String(run.result?.num_turns ?? '?')}`);
  console.log(
    `tokens: in ${String(usage?.input_tokens ?? '?')}, cache read ${String(usage?.cache_read_input_tokens ?? '?')}, cache write ${String(usage?.cache_creation_input_tokens ?? '?')}, out ${String(usage?.output_tokens ?? '?')}`,
  );
  console.log(`cost: $${run.result?.total_cost_usd?.toFixed(4) ?? '?'}`);
}

function report(task: string, problems: string[]): boolean {
  if (problems.length > 0) console.log(`FAILED (${task}):\n- ${problems.join('\n- ')}`);
  else console.log(`passed: ${task}`);
  return problems.length === 0;
}

const history = async (data: string, project: string) =>
  (await new HistoryStore(data).openProject({ path: project, texts: {} })).project.listSnapshots();

/** Plans the Reminders feature with the MCP tools only. */
function planTask(): Promise<boolean> {
  return withProject('plan', async (project, data, config) => {
    const before = await readPlan(project);
    const filesBefore = (await listFiles(project)).filter((p) => !p.startsWith('plan/'));
    console.log(`Running Claude Code (${values.model}): plan a feature…`);
    const run = await runClaude(project, config, PLAN_PROMPT, ['mcp__idea-to-code']);
    const after = await readPlan(project);
    const filesAfter = (await listFiles(project)).filter((p) => !p.startsWith('plan/'));
    const check = generatedFeature(loadFromTexts(before), loadFromTexts(after), {
      featureId: 'reminders',
      minMainNodes: 5,
      requiredRef: 'sms-service',
      duplicatePattern: /remind/i,
    });
    const byAgent = (await history(data, project)).filter((s) => s.source !== 'external' || s.parent !== null);
    describeRun(run);
    console.log(`snapshots: ${byAgent.map((s) => `${s.source}/${s.actor}`).join(', ') || 'none'}`);
    const problems = [...check.failures, ...check.errors];
    if (byAgent.length === 0) problems.push('nothing was recorded in history');
    if (byAgent.some((s) => s.source !== 'mcp')) problems.push('a change was recorded as something other than mcp');
    if (filesAfter.join() !== filesBefore.join()) problems.push('files outside plan/ changed');
    if (!run.tools.some((t) => t === 'fill_flow' || t === 'add_node')) problems.push('no plan tool was used');
    return report('plan a feature', problems);
  });
}

/** Writes the code for one step, then links it in the plan and marks it done. */
function buildTask(): Promise<boolean> {
  return withProject('build', async (project, data, config) => {
    console.log(`Running Claude Code (${values.model}): build one step and link it…`);
    const run = await runClaude(project, config, BUILD_PROMPT, ['mcp__idea-to-code', 'Write', 'Edit', 'Read']);
    const after = loadFromTexts(await readPlan(project));
    const node = indexProject(after).nodes.get('confirm-booking')?.node;
    const links = node && 'implements' in node ? (node.implements ?? []) : [];
    const status = node && 'status' in node ? node.status : undefined;
    const written = await readFile(join(project, 'src', 'bookings', 'confirm.ts'), 'utf8').catch(() => null);
    describeRun(run);
    console.log(`confirm-booking: status=${status ?? 'none'}, implements=${links.join(' ') || 'none'}`);
    const problems: string[] = [];
    if (written === null) problems.push('src/bookings/confirm.ts was not written');
    if (!links.some((l) => ['src/bookings/confirm.ts', 'src/bookings', 'src/bookings/'].includes(l)))
      problems.push('the step is not linked to its code');
    if (status !== 'done') problems.push(`the step is ${status ?? 'todo'}, not done`);
    if (!run.tools.includes('link_code')) problems.push('link_code was not used');
    if (!(await history(data, project)).some((s) => s.source === 'mcp' && s.actor === 'claude-code'))
      problems.push('no change was recorded as claude-code');
    if (errorsOf(validateProject(after)).length > 0) problems.push('the plan has errors');
    return report('build a step and link it', problems);
  });
}

const results: boolean[] = [];
if (values.task === 'all' || values.task === 'plan') results.push(await planTask());
if (values.task === 'all' || values.task === 'build') results.push(await buildTask());
process.exitCode = results.length > 0 && results.every(Boolean) ? 0 : 1;
