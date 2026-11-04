// One real Claude Code session that plans a feature through the MCP tools only,
// on a temp copy of the fictitious Toolshed plan. Uses the local `claude` login.
// Usage: pnpm --filter idea-to-code-mcp run claude-check -- [--model sonnet]
import { loadFromTexts } from '@idea-to-code/core';
import { HistoryStore, NodePlanFiles } from '@idea-to-code/store';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generatedFeature } from '../../core/scripts/agentChecks.js';

const BUNDLE = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const TOOLSHED = fileURLToPath(new URL('../../core/test/fixtures/toolshed/plan', import.meta.url));
const { values } = parseArgs({ options: { model: { type: 'string', default: 'sonnet' } }, allowPositionals: true });

const PROMPT = `Add the reminders feature to the project plan. We agreed on: the system finds bookings starting tomorrow, then checks whether the member allows text messages. If yes it builds the reminder and sends it through the SMS service, then logs that it was sent; if no it just logs a skip. Building the reminder deserves its own detailed flow: pick the language, fill in the tool and pickup place, and keep it under 160 characters. Quiet hours mean nothing is sent between 9pm and 8am, because neighbours complained in the pilot.`;

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

function runClaude(cwd: string, config: string): Promise<{ tools: string[]; errors: number; result?: StreamEvent }> {
  const args = [
    '-p',
    PROMPT,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    values.model,
    '--mcp-config',
    config,
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__idea-to-code',
    '--no-session-persistence',
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    const run: { tools: string[]; errors: number; result?: StreamEvent } = { tools: [], errors: 0 };
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

const work = await mkdtemp(join(tmpdir(), 'itc-claude-check-'));
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
  const before = await readPlan(project);
  const filesBefore = (await listFiles(project)).filter((p) => !p.startsWith('plan/'));

  console.log(`Running Claude Code (${values.model}) on a Toolshed copy…`);
  const run = await runClaude(project, config);
  const after = await readPlan(project);
  const filesAfter = (await listFiles(project)).filter((p) => !p.startsWith('plan/'));

  const check = generatedFeature(loadFromTexts(before), loadFromTexts(after), {
    featureId: 'reminders',
    minMainNodes: 5,
    requiredRef: 'sms-service',
    duplicatePattern: /remind/i,
  });
  const history = (await new HistoryStore(data).openProject({ path: project, texts: after })).project;
  const snapshots = await history.listSnapshots();
  const byAgent = snapshots.filter((s) => s.source !== 'external' || s.parent !== null);

  const usage = run.result?.usage;
  console.log(`tool calls: ${run.tools.join(', ') || 'none'}`);
  console.log(`failed calls: ${run.errors}, turns: ${run.result?.num_turns ?? '?'}`);
  console.log(
    `tokens: in ${usage?.input_tokens ?? '?'}, cache read ${usage?.cache_read_input_tokens ?? '?'}, cache write ${usage?.cache_creation_input_tokens ?? '?'}, out ${usage?.output_tokens ?? '?'}`,
  );
  console.log(`cost: $${run.result?.total_cost_usd?.toFixed(4) ?? '?'}`);
  console.log(`snapshots: ${byAgent.map((s) => `${s.source}/${s.actor}`).join(', ') || 'none'}`);

  const problems = [...check.failures, ...check.errors];
  if (byAgent.length === 0) problems.push('nothing was recorded in history');
  if (byAgent.some((s) => s.source !== 'mcp')) problems.push('a change was recorded as something other than mcp');
  if (filesAfter.join() !== filesBefore.join()) problems.push('files outside plan/ changed');
  if (!run.tools.some((t) => t === 'fill_flow' || t === 'add_node')) problems.push('no plan tool was used');
  if (problems.length > 0) {
    console.log(`FAILED:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('claude-check passed');
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
