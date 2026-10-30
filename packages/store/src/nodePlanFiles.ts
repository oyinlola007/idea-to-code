// PlanFiles on Node's fs, for the MCP server and tests.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { atomicWrite, readTextOrNull } from './files.js';
import { checkProjectPath, UnsafePathError } from './paths.js';
import type { PlanFiles } from './planFiles.js';

const MAP = 'plan/map.yaml';
const FEATURES = 'plan/features';

export class NodePlanFiles implements PlanFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private full(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  async listPlanFiles(): Promise<string[]> {
    const paths: string[] = [];
    if ((await readTextOrNull(this.full(MAP))) !== null) paths.push(MAP);
    const names = await readdir(this.full(FEATURES)).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith('.yaml')).sort()) paths.push(`${FEATURES}/${name}`);
    return paths;
  }

  read(path: string): Promise<string | null> {
    return readTextOrNull(this.full(path));
  }

  /** A symlink inside the project could point anywhere, so check where the folder really is. */
  private async checkStaysInside(path: string): Promise<void> {
    const root = await realpath(this.root);
    await mkdir(dirname(this.full(path)), { recursive: true });
    const folder = await realpath(dirname(this.full(path)));
    const rel = relative(root, folder);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new UnsafePathError(path, 'it leads outside the project through a symbolic link');
  }

  async write(path: string, content: string): Promise<void> {
    checkProjectPath(path);
    await this.checkStaysInside(path);
    await atomicWrite(this.full(path), content);
  }

  async remove(path: string): Promise<void> {
    checkProjectPath(path);
    await this.checkStaysInside(path);
    await unlink(this.full(path)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }

  watch(onChange: () => void): () => void {
    let planWatcher: FSWatcher | undefined;
    const watchPlan = () => {
      if (planWatcher) return;
      try {
        planWatcher = watch(this.full('plan'), { recursive: true }, () => {
          onChange();
        });
        planWatcher.on('error', () => undefined);
      } catch {
        // No plan folder yet; the watcher on the project root picks it up when it appears.
      }
    };
    watchPlan();
    const rootWatcher = watch(this.root, (_event, name) => {
      if (name === 'plan') {
        watchPlan();
        onChange();
      }
    });
    rootWatcher.on('error', () => undefined);
    return () => {
      planWatcher?.close();
      rootWatcher.close();
    };
  }
}
