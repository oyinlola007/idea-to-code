// The model settings' side of the editor: its settings, secret storage, Language Model API and key prompt.
import type { ModelSettingsPatch, ModelSettingsView, ModelTestResult } from '@idea-to-code/core';
import * as vscode from 'vscode';
import { CATALOG } from './catalog.js';
import type { LmApi, LmModel } from './languageModel.js';
import { isKeyProvider, ModelService } from './modelService.js';

const SECTION = 'ideaToCode.models';

/** The API as far as this editor has it; newer than the engine floor, so looked at through a narrow cast. */
interface VsCodeLm {
  lm?: {
    selectChatModels?: () => Thenable<readonly LmModel[]>;
    onDidChangeChatModels?: vscode.Event<void>;
  };
  LanguageModelChatMessage?: { User?: (parts: unknown[]) => unknown; Assistant?: (parts: unknown[]) => unknown };
  LanguageModelTextPart?: new (value: string) => { value: string };
  LanguageModelToolCallPart?: new (id: string, name: string, input: unknown) => { callId: string; name: string; input: unknown };
  LanguageModelToolResultPart?: new (id: string, content: unknown[]) => unknown;
}

/** Undefined unless all of it is there, including tool calling, which the chat can't work without. */
export function editorLmApi(api: VsCodeLm = vscode as unknown as VsCodeLm): LmApi | undefined {
  const {
    lm,
    LanguageModelChatMessage: message,
    LanguageModelTextPart: Text,
    LanguageModelToolCallPart: Call,
    LanguageModelToolResultPart: Result,
  } = api;
  const select = lm?.selectChatModels;
  const user = message?.User;
  const assistant = message?.Assistant;
  if (!lm || !select || !user || !assistant || !Text || !Call || !Result) return undefined;
  return {
    selectChatModels: () => select.call(lm),
    user: (parts) => user.call(message, parts),
    assistant: (parts) => assistant.call(message, parts),
    textPart: (text) => new Text(text),
    toolCallPart: (id, name, input) => new Call(id, name, input),
    toolResultPart: (id, text) => new Result(id, [new Text(text)]),
    isTextPart: (part): part is { value: string } => part instanceof Text,
    isToolCallPart: (part): part is { callId: string; name: string; input: unknown } => part instanceof Call,
    token: (signal) => {
      const source = new vscode.CancellationTokenSource();
      const cancel = () => {
        source.cancel();
      };
      signal?.addEventListener('abort', cancel);
      return {
        token: source.token,
        dispose: () => {
          signal?.removeEventListener('abort', cancel);
          source.dispose();
        },
      };
    },
  };
}

export class ModelHost implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly onDidChange = this.changed.event;
  readonly service: ModelService;

  constructor(secrets: vscode.SecretStorage) {
    const lm = editorLmApi();
    this.service = new ModelService(
      {
        // The manifest scopes these to the application; reading only the user's value holds even if an editor doesn't honour that.
        get: (key) => vscode.workspace.getConfiguration(SECTION).inspect(key)?.globalValue,
        set: (key, value) => vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global),
      },
      secrets,
      () => lm,
    );
    const fire = () => {
      this.changed.fire(undefined);
    };
    this.subscriptions.push(
      this.changed,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(SECTION)) fire();
      }),
      secrets.onDidChange((event) => {
        if (event.key.startsWith('ideaToCode.key.')) fire();
      }),
    );
    const onModels = (vscode as unknown as VsCodeLm).lm?.onDidChangeChatModels;
    if (onModels) this.subscriptions.push(onModels(fire));
  }

  view(): Promise<ModelSettingsView> {
    return this.service.view();
  }

  update(patch: ModelSettingsPatch): Promise<void> {
    return this.service.update(patch);
  }

  /** Asks in the editor's own password box, so a key never passes through the page. */
  async promptForKey(provider: string): Promise<void> {
    if (!isKeyProvider(provider)) return;
    const key = await vscode.window.showInputBox({
      title: `${CATALOG[provider].label} API key`,
      prompt: "Saved in your system's keychain. It's sent only to this provider.",
      password: true,
      ignoreFocusOut: true,
    });
    if (key?.trim()) await this.service.saveKey(provider, key);
  }

  removeKey(provider: string): Promise<void> {
    return isKeyProvider(provider) ? this.service.removeKey(provider) : Promise.resolve();
  }

  test(): Promise<ModelTestResult[]> {
    return this.service.test();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
