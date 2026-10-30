// Optional APIs newer than the engine floor, detected at runtime and never assumed:
// forks lag behind VS Code. A narrow cast, so nothing else can use them by accident.
import * as vscode from 'vscode';

interface LmLike {
  selectChatModels?: unknown;
  registerMcpServerDefinitionProvider?: unknown;
}

export interface OptionalApis {
  languageModels: boolean;
  mcpRegistration: boolean;
}

export function detectOptionalApis(): OptionalApis {
  const lm = (vscode as unknown as { lm?: LmLike }).lm;
  return {
    languageModels: typeof lm?.selectChatModels === 'function',
    mcpRegistration: typeof lm?.registerMcpServerDefinitionProvider === 'function',
  };
}
