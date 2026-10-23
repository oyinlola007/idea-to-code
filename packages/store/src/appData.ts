// The shared app data folder where history lives (outside every project), so
// the extension in any editor and the MCP server see the same store. Pure:
// the platform, environment and home folder are passed in.
import { posix, win32 } from 'node:path';

export interface Host {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

export function appDataDir(host: Host, name = 'idea-to-code'): string {
  const override = host.env.IDEA_TO_CODE_DATA;
  if (override) return override;
  if (host.platform === 'win32') return win32.join(host.env.APPDATA ?? win32.join(host.home, 'AppData', 'Roaming'), name);
  if (host.platform === 'darwin') return posix.join(host.home, 'Library', 'Application Support', name);
  return posix.join(host.env.XDG_DATA_HOME ?? posix.join(host.home, '.local', 'share'), name);
}
