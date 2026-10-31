// Runs ELK off the main thread. Webview content is served from another origin than
// the page and workers must be same-origin, so the worker comes from a blob URL
// (ITC-3: an extension-local worker URL fails in every editor). Main-thread ELK is
// the fallback: slower, still fine. Each mode is probed before it's trusted.
import ELK from 'elkjs/lib/elk-api.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import workerSource from 'elkjs/lib/elk-worker.min.js?raw';

export type WorkerMode = 'blob' | 'main';

export interface Layouter {
  mode: WorkerMode;
  layout(graph: ElkNode): Promise<ElkNode>;
}

interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

const PROBE_TIMEOUT_MS = 4_000;

const probe = (): ElkNode => ({
  id: 'probe',
  layoutOptions: { 'elk.algorithm': 'layered' },
  children: [
    { id: 'a', width: 10, height: 10 },
    { id: 'b', width: 10, height: 10 },
  ],
  edges: [{ id: 'e', sources: ['a'], targets: ['b'] }],
});

async function blobWorkerElk(): Promise<ElkLike> {
  let fail: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const elk = new ELK({
    workerFactory: () => {
      const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
      worker.addEventListener('error', (e) => {
        fail(new Error(e.message || 'worker error'));
      });
      return worker;
    },
  });
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`no answer within ${String(PROBE_TIMEOUT_MS)}ms`));
    }, PROBE_TIMEOUT_MS);
  });
  await Promise.race([elk.layout(probe()), failed, timer]);
  return elk;
}

async function mainThreadElk(): Promise<ElkLike> {
  const { default: Bundled } = await import('elkjs/lib/elk.bundled.js');
  return new Bundled();
}

export async function createLayouter(onFail: (mode: WorkerMode, error: string) => void): Promise<Layouter> {
  try {
    const elk = await blobWorkerElk();
    return { mode: 'blob', layout: (graph) => elk.layout(graph) };
  } catch (err) {
    onFail('blob', err instanceof Error ? err.message : String(err));
  }
  const elk = await mainThreadElk();
  return { mode: 'main', layout: (graph) => elk.layout(graph) };
}
