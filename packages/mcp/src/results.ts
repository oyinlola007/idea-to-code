// What each tool answers. A call the agent can fix comes back as a tool error
// (isError), never a protocol error, so the model reads it and retries. Anything
// quoting plan content is wrapped as data.
import { asPlanData, OVERVIEW, type Issue, type ViewModel } from '@idea-to-code/core';
import type { ApplyResult } from '@idea-to-code/store';

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Same shape as the built-in agent's answers, plus where it was saved. */
export function opResult(result: ApplyResult): ToolResult {
  if (!result.ok) return errorResult(`error [${result.code}]: ${result.message}. Fix the call and try again.`);
  const lines = ['ok.'];
  if (Object.keys(result.created).length > 0) lines.push(`created: ${JSON.stringify(result.created)}`);
  if (result.warnings.length > 0) lines.push(`warnings: ${result.warnings.join('; ')}`);
  const files = [...result.changed, ...result.deleted.map((path) => `${path} (removed)`)];
  if (files.length > 0) lines.push(`saved: ${files.join(', ')}`);
  return textResult(lines.join('\n'));
}

export function issuesResult(issues: readonly Issue[]): ToolResult {
  if (issues.length === 0) return textResult('No problems.');
  const lines = issues.map((i) => `${i.file}:${i.line}:${i.col} ${i.severity} ${i.code}: ${i.message}`);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  const count = (n: number, word: string) => (n === 0 ? `No ${word}s` : `${n} ${word}${n === 1 ? '' : 's'}`);
  return textResult(`${count(errors, 'error')}, ${count(warnings, 'warning').toLowerCase()}:\n${asPlanData(lines.join('\n'))}`);
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The level the user last had open in the chart, with its path from the overview. */
export function viewResult(view: { level: string; at: number } | null, model: ViewModel, now: number): ToolResult {
  const level = view ? model.levels[view.level] : undefined;
  if (!view || !level) return textResult("The app isn't showing a part of the plan right now. Ask the user which part they mean.");
  const path = level.crumbs.map((crumb) => crumb.title).join(' > ');
  return textResult(
    `The user has this level open (id "${level.id}", seen ${ago(now - view.at)}). Read it with ${
      level.id === OVERVIEW ? 'get_outline' : `get_flow {"flowId": "${level.id}"}`
    }.\n${asPlanData(path)}`,
  );
}
