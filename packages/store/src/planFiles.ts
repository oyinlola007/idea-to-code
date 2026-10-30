// File access for one project, behind an interface: Node's fs for MCP and tests,
// VS Code's workspace.fs in the extension. Paths are relative to the project, with "/".
export interface PlanFiles {
  /** The plan files that exist now: plan/map.yaml and plan/features/*.yaml. */
  listPlanFiles(): Promise<string[]>;
  /** A file's content, or null if it doesn't exist. */
  read(path: string): Promise<string | null>;
  /** Replaces a file atomically (temp file, then rename), creating folders as needed. */
  write(path: string, content: string): Promise<void>;
  /** Removes a file; a missing file is fine. */
  remove(path: string): Promise<void>;
  /** Calls back whenever a plan file may have changed. Returns a function to stop watching. */
  watch(onChange: () => void): () => void;
}
