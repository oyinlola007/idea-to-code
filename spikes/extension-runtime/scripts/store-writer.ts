// One writer process for the store stress test. Usage:
//   tsx scripts/store-writer.ts --dir <store> --project <id> --count 500 --tag node
import { parseArgs } from 'node:util';
import { sampleFiles, Store } from '../src/store/cas.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    project: { type: 'string', default: 'stress' },
    count: { type: 'string', default: '500' },
    tag: { type: 'string', default: `node-${process.pid}` },
    'stale-ms': { type: 'string', default: '5000' },
  },
});
if (!values.dir) throw new Error('--dir is required');

const store = new Store(values.dir, values.project!, { staleMs: Number(values['stale-ms']) });
const count = Number(values.count);
const started = Date.now();
let dedup = 0;
for (let seq = 0; seq < count; seq++) {
  dedup += (await store.appendSnapshot(sampleFiles(seq, values.tag!), { writer: values.tag!, seq })).dedup;
}
console.log(`done ${values.tag} ${count} ${Date.now() - started}ms dedup=${dedup}`);
