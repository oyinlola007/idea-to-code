// Runs ELK off the main thread. Webview content is served from another
// origin than the page, and workers must be same-origin, so a worker built
// from a blob URL is tried first, then the extension-local file, then ELK on
// the main thread. Each mode is probed; the one in use is reported.
import ELK from 'elkjs/lib/elk-api.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import workerSource from 'elkjs/lib/elk-worker.min.js?raw';
import type { WorkerMode, WorkerSetting } from '../../../src/shared/messages';

export interface Layouter {
  mode: WorkerMode;
  layout(graph: ElkNode): Promise<ElkNode>;
}

type ElkLike = { layout(graph: ElkNode): Promise<ElkNode>; terminateWorker?: () => void };

const PROBE: ElkNode = {
  id: 'probe',
  layoutOptions: { 'elk.algorithm': 'layered' },
  children: [
    { id: 'a', width: 10, height: 10 },
    { id: 'b', width: 10, height: 10 },
  ],
  edges: [{ id: 'e', sources: ['a'], targets: ['b'] }],
};

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms))]);
}

function workerElk(make: () => Worker): { elk: ElkLike; failed: Promise<never> } {
  let fail: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => (fail = reject));
  const elk = new ELK({
    workerFactory: () => {
      const w = make();
      w.addEventListener('error', (e) => fail(new Error(e.message || 'worker error event')));
      return w;
    },
  }) as unknown as ElkLike;
  return { elk, failed };
}

async function create(mode: WorkerMode, workerUrl: string): Promise<ElkLike> {
  if (mode === 'main') {
    const { default: Bundled } = await import('elkjs/lib/elk.bundled.js');
    return new Bundled() as unknown as ElkLike;
  }
  const make =
    mode === 'blob'
      ? () => new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })))
      : () => new Worker(workerUrl);
  const { elk, failed } = workerElk(make);
  failed.catch(() => {});
  await timeout(Promise.race([elk.layout(structuredClone(PROBE)), failed]), 4_000, `${mode} worker`);
  return elk;
}

export async function createLayouter(setting: WorkerSetting, workerUrl: string, onFail: (mode: WorkerMode, error: string) => void): Promise<Layouter> {
  const order: WorkerMode[] = setting === 'auto' ? ['blob', 'url', 'main'] : [setting];
  for (const mode of order) {
    try {
      const elk = await create(mode, workerUrl);
      return { mode, layout: (g) => elk.layout(g) };
    } catch (err) {
      onFail(mode, err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`no ELK mode worked (${order.join(', ')})`);
}
