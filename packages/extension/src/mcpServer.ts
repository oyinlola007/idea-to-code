// Offers the bundled MCP server to the editor's own agents (Copilot in VS Code),
// where the editor has the API: newer than the engine floor, so detected at runtime
// through narrow types. Restricted Mode is view-only, so it offers nothing there.
import * as vscode from 'vscode';
import { MCP_LABEL, MCP_PROVIDER_ID, serverLaunch } from './mcpLaunch.js';
import type { ProjectHost } from './projectHost.js';
import type { WorkspaceTrust } from './trust.js';

type StdioDefinition = object;

interface McpProvider {
  onDidChangeMcpServerDefinitions: vscode.Event<void>;
  provideMcpServerDefinitions(): StdioDefinition[];
}

interface McpApi {
  lm?: { registerMcpServerDefinitionProvider?: (id: string, provider: McpProvider) => vscode.Disposable };
  McpStdioServerDefinition?: new (
    label: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    version: string,
  ) => StdioDefinition;
}

export function registerMcpServer(
  context: vscode.ExtensionContext,
  host: ProjectHost,
  trust: WorkspaceTrust,
): vscode.Disposable | undefined {
  const api = vscode as unknown as McpApi;
  const register = api.lm?.registerMcpServerDefinitionProvider;
  const Definition = api.McpStdioServerDefinition;
  if (!register || !Definition) return undefined;

  const version = (context.extension.packageJSON as { version: string }).version;
  const changed = new vscode.EventEmitter<void>();
  const rootOf = () => (host.activeFolder ?? vscode.workspace.workspaceFolders?.[0])?.uri;
  let root = rootOf()?.toString();

  const provider: McpProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const folder = rootOf();
      if (!trust.isTrusted || folder?.scheme !== 'file') return [];
      const launch = serverLaunch(context.extensionPath, folder.fsPath, version);
      return [new Definition(MCP_LABEL, launch.command, launch.args, launch.env, launch.version)];
    },
  };

  const registration = register.call(api.lm, MCP_PROVIDER_ID, provider);
  return vscode.Disposable.from(
    registration,
    changed,
    trust.onDidGrant(() => {
      changed.fire();
    }),
    // The plan's folder decides the project the server works on.
    host.onDidChange(() => {
      const next = rootOf()?.toString();
      if (next === root) return;
      root = next;
      changed.fire();
    }),
  );
}
