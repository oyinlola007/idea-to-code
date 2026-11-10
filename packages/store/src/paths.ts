// What the app may write in a user's project: the plan folder, nothing else. Every
// write is checked here, so a bad path from a webview message or an agent can't
// reach anywhere else on disk.

export class UnsafePathError extends Error {
  constructor(path: string, reason: string) {
    super(`refused to write "${path}": ${reason}`);
    this.name = 'UnsafePathError';
  }
}

/** Throws unless a project-relative path is safe to write. */
export function checkProjectPath(path: string): void {
  if (path.includes('\\') || path.includes('\0')) throw new UnsafePathError(path, 'invalid characters');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new UnsafePathError(path, 'it must be relative to the project');
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new UnsafePathError(path, 'it must not leave the project folder');
  if (parts[0] !== 'plan') throw new UnsafePathError(path, 'only files in plan/ can be written');
}
