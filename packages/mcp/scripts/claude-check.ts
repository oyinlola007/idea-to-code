// Real Claude Code sessions through the MCP server, on temp copies of the fictitious
// Toolshed plan. Uses the local `claude` login.
//   plan:  plan a whole feature with the MCP tools only.
//   build: write the code for one step, link it in the plan and mark it done.
//   map:   map the fictitious Pantry app into a new plan, with read-only file tools.
//   merge: map Pantry into a half-written plan, keeping what's planned.
// Usage: pnpm --filter idea-to-code-mcp run claude-check -- [--task plan|build|map|merge|all] [--model sonnet]
import { errorsOf, indexProject, loadFromTexts, validateProject } from '@idea-to-code/core';
import { HistoryStore, NodePlanFiles } from '@idea-to-code/store';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generatedFeature } from '../../core/scripts/agentChecks.js';

const BUNDLE = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const TOOLSHED = fileURLToPath(new URL('../../core/test/fixtures/toolshed/plan', import.meta.url));
const PANTRY = fileURLToPath(new URL('fixtures/pantry', import.meta.url));
const PANTRY_PLAN = fileURLToPath(new URL('fixtures/pantry-plan/plan', import.meta.url));
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
    // Only the temp project's own settings: personal settings may open other folders to every session,
    // and the agent must see nothing but the project it's checking.
    '--setting-sources',
    'project',
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

/**
 * A temp project with history in its own folder and the server configured for it. It holds a Toolshed plan,
 * or a sample app's code (`from`), with or without a plan of its own (`plan`).
 */
async function withProject(
  name: string,
  fn: (project: string, data: string, config: string) => Promise<boolean>,
  source: { from?: string; plan?: string } = { plan: TOOLSHED },
): Promise<boolean> {
  const work = await mkdtemp(join(tmpdir(), `itc-claude-${name}-`));
  try {
    const project = join(work, 'project');
    const data = join(work, 'data');
    if (source.from !== undefined) await cp(source.from, project, { recursive: true });
    if (source.plan !== undefined) await cp(source.plan, join(project, 'plan'), { recursive: true });
    await mkdir(project, { recursive: true });
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

const MAP_PROMPT = 'Map this codebase into the project plan.';
const MERGE_PROMPT = 'Map this codebase into the project plan. The plan already has some of it.';
/** Read-only file tools: mapping must not change the code. */
const READ_ONLY = ['mcp__idea-to-code', 'Read', 'Glob', 'Grep'];

/** Each area of Pantry, and how a feature for it might be named. */
const AREAS: { area: string; folder: string; name: RegExp }[] = [
  { area: 'accounts', folder: 'src/accounts', name: /account|sign|log ?in|user/i },
  { area: 'recipes', folder: 'src/recipes', name: /recipe/i },
  { area: 'shopping', folder: 'src/shopping', name: /shop/i },
  { area: 'pantry', folder: 'src/pantry', name: /pantry|stock|expir|food/i },
];

async function fingerprint(project: string): Promise<string> {
  const files = (await listFiles(project)).filter((p) => !p.startsWith('plan/') && !p.startsWith('.'));
  const hash = createHash('sha256');
  for (const path of files) hash.update(path).update(await readFile(join(project, path)));
  return hash.digest('hex');
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** What a map of Pantry has to get right, whether it started from nothing or from a partial plan. */
async function checkMap(project: string, data: string, run: Run, codeBefore: string): Promise<string[]> {
  const plan = loadFromTexts(await readPlan(project));
  const index = indexProject(plan);
  const problems: string[] = [];
  const errors = errorsOf(validateProject(plan));
  if (!plan.map) problems.push('no plan was made');
  if (errors.length > 0) problems.push(`the plan has errors: ${errors.map((e) => e.code).join(', ')}`);

  const features = [...index.features.entries()].map(([id, f]) => `${id} ${f.label}`);
  for (const { area, name } of AREAS) if (!features.some((f) => name.test(f))) problems.push(`no feature for ${area}`);

  const nodes = [...index.nodes.values()].map((r) => r.node).filter((n) => n.type === 'step' || n.type === 'component');
  const sharedLinks = [...index.components.values()].flatMap((c) => c.implements ?? []);
  const nodeLinks = nodes.flatMap((n) => n.implements ?? []);
  const links = [...nodeLinks, ...sharedLinks];
  for (const link of links) if (!(await exists(join(project, link)))) problems.push(`a link points at nothing: ${link}`);
  const done = nodes.filter((n) => n.status === 'done');
  for (const n of done) if (!n.implements?.length) problems.push(`"${n.label}" is done but not linked to code`);
  for (const n of done)
    if (n.implements?.some((l) => l.startsWith('src/meal-plan'))) problems.push(`"${n.label}" is done but meal planning isn't built`);
  const mealFeatures = [...index.flows.values()].filter((f) => /meal/i.test(`${f.featureId} ${f.flow.label}`)).map((f) => f.id);
  for (const ref of index.nodes.values())
    if (mealFeatures.includes(ref.flowId) && 'status' in ref.node && ref.node.status === 'done')
      problems.push(`meal planning has a done step: "${ref.node.label}"`);
  if ((await fingerprint(project)) !== codeBefore) problems.push('the code changed');
  const snapshots = (await history(data, project)).filter((s) => s.source !== 'external' || s.parent !== null);
  if (snapshots.some((s) => s.source !== 'mcp' || s.actor !== 'claude-code')) problems.push('a change was not made through MCP');

  describeRun(run);
  const perArea = AREAS.map(({ area, folder }) => `${area} ${String(links.filter((l) => l.startsWith(folder)).length)}`).join(', ');
  console.log(
    `map: ${String(index.features.size)} features, ${String(index.flows.size)} flows, ${String(nodes.length)} steps/components, ${String(links.length)} links (${perArea}), ${String(done.length)} done`,
  );
  console.log(`features: ${features.join(' | ')}`);
  return problems;
}

/** Maps the Pantry app from nothing, with read-only file tools. */
function mapTask(): Promise<boolean> {
  return withProject(
    'map',
    async (project, data, config) => {
      const before = await fingerprint(project);
      console.log(`Running Claude Code (${values.model}): map a codebase into a new plan…`);
      const run = await runClaude(project, config, MAP_PROMPT, READ_ONLY);
      return report('map a codebase', await checkMap(project, data, run, before));
    },
    { from: PANTRY },
  );
}

/** Maps the Pantry app into a half-written plan: what's planned stays, linked and marked. */
function mergeTask(): Promise<boolean> {
  return withProject(
    'merge',
    async (project, data, config) => {
      const before = await fingerprint(project);
      console.log(`Running Claude Code (${values.model}): map a codebase into an existing plan…`);
      const run = await runClaude(project, config, MERGE_PROMPT, READ_ONLY);
      const problems = await checkMap(project, data, run, before);
      const index = indexProject(loadFromTexts(await readPlan(project)));
      const kept = [
        ['search-recipes', 'Search recipes by name or ingredient'],
        ['save-recipe', 'Save a favourite'],
      ];
      for (const [id, label] of kept) {
        const node = index.nodes.get(id ?? '')?.node;
        if (!node) problems.push(`the planned step ${id ?? ''} was removed`);
        else if (node.label !== label) problems.push(`the planned step ${id ?? ''} was renamed to "${node.label ?? ''}"`);
        else if (!('implements' in node) || !node.implements?.some((l) => l.startsWith('src/recipes')))
          problems.push(`the planned step ${id ?? ''} was not linked to its code`);
      }
      for (const id of ['recipes', 'shopping']) if (!index.features.has(id)) problems.push(`the planned feature ${id} was removed`);
      return report('map a codebase into an existing plan', problems);
    },
    { from: PANTRY, plan: PANTRY_PLAN },
  );
}

const results: boolean[] = [];
if (values.task === 'all' || values.task === 'plan') results.push(await planTask());
if (values.task === 'all' || values.task === 'build') results.push(await buildTask());
if (values.task === 'all' || values.task === 'map') results.push(await mapTask());
if (values.task === 'all' || values.task === 'merge') results.push(await mergeTask());
process.exitCode = results.length > 0 && results.every(Boolean) ? 0 : 1;
