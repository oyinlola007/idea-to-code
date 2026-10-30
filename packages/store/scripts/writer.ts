// One writer process for the concurrency tests. Records `count` different plans
// into one project, or just registers it (count 0), and prints the project id.
import { parseArgs } from 'node:util';
import { HistoryStore } from '../src/history.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    path: { type: 'string', default: '/projects/stress' },
    count: { type: 'string', default: '100' },
    tag: { type: 'string', default: `writer-${process.pid}` },
  },
});
if (!values.dir) throw new Error('--dir is required');

const texts = (seq: number) => ({
  'plan/map.yaml': `project: Stress\nfeatures:\n  - id: shared\n    label: Shared\n# ${values.tag} ${seq}\n`,
  'plan/features/shared.yaml': `feature: shared\nflows:\n  main:\n    label: Shared ${seq % 7}\n`,
});

const store = new HistoryStore(values.dir);
const { project } = await store.openProject({ path: values.path, texts: texts(0), name: 'Stress' });
for (let seq = 0; seq < Number(values.count); seq++) {
  await project.recordSnapshot({ texts: texts(seq), source: 'mcp', actor: values.tag });
}
console.log(project.record.id);
