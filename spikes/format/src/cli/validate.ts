// Usage: npm run validate -- <project-dir>
import { resolve } from 'node:path';
import { loadProject } from '../load.js';
import { errorsOf, validateProject } from '../validate.js';

const dir = resolve(process.argv[2] ?? '.');
const issues = validateProject(await loadProject(dir));
for (const i of issues) {
  console.log(`${i.file}:${i.line}:${i.col} ${i.severity} [${i.code}] ${i.message}`);
}
const errors = errorsOf(issues).length;
console.log(`\n${errors} error(s), ${issues.length - errors} warning(s)`);
process.exitCode = errors > 0 ? 1 : 0;
