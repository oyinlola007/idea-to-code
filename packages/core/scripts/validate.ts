// Validates a plan folder and prints every issue with its file and line.
// Usage: pnpm validate-plan <project-dir>   (the folder that contains plan/)
import { resolve } from 'node:path';
import { loadFromTexts } from '../src/load.js';
import { rollup, OVERVIEW } from '../src/progress.js';
import { validateProject } from '../src/validate.js';
import { readPlanTexts } from './readPlan.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: pnpm validate-plan <project-dir>');
  process.exit(2);
}
const root = resolve(process.env.INIT_CWD ?? process.cwd(), dir);
const project = loadFromTexts(await readPlanTexts(root));
const issues = validateProject(project);
for (const i of issues) console.log(`${i.file}:${i.line}:${i.col}  ${i.severity.padEnd(7)}  ${i.code}  ${i.message}`);
const errors = issues.filter((i) => i.severity === 'error').length;
const overview = rollup(project).get(OVERVIEW);
console.log(
  `\n${root}: ${errors} error(s), ${issues.length - errors} warning(s), ${project.features.length} feature file(s)` +
    (overview ? `, ${overview.done}/${overview.total} done` : ''),
);
process.exit(errors > 0 ? 1 : 0);
