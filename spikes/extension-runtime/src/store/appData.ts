// The shared app data folder. The spike uses its own "idea-to-code-spike"
// folder so it never touches the real store.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function appDataDir(): string {
  const override = process.env.IDEA_TO_CODE_SPIKE_STORE;
  if (override) return override;
  const name = 'idea-to-code-spike';
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), name);
}
