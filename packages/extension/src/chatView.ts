// The chat in the idea-to-code sidebar. The page only draws: the conversation, the
// tool loop and the plan edits all live in the extension host, behind ChatSource.
// Every message is parsed in both directions, like the app tab's.
import { HostMessage, WebviewMessage, type ChatAction, type ChatView, type Reveal, type SettingsTab } from '@idea-to-code/core';
import * as vscode from 'vscode';
import type { ProjectHost } from './projectHost.js';
import { handleSettingsMessage } from './settingsMessages.js';
import { webviewHtml, webviewOptions } from './webviewHtml.js';

export const CHAT_VIEW_ID = 'ideaToCode.chat';

/** What the chat page talks to: the ChatService. */
export interface ChatSource {
  view(): ChatView;
  /** Fires when anything the page shows changes, except streamed text. */
  onDidChange(listener: () => void): { dispose(): void };
  /** Streamed text for an assistant item. */
  onText(listener: (event: { itemId: string; text: string }) => void): { dispose(): void };
  send(text: string): Promise<void>;
  cancel(): void;
  newThread(): Promise<void>;
  openThread(id: string): Promise<void>;
  undo(): Promise<void>;
  /** Shows where a turn's changes are on the chart. */
  showChanges(reveal: Reveal): void;
}

async function runAction(action: ChatAction, session: string | undefined): Promise<void> {
  switch (action) {
    case 'open-model-settings':
      await vscode.commands.executeCommand('ideaToCode.openSettings', 'models');
      break;
    case 'init-plan':
      await vscode.commands.executeCommand('ideaToCode.initPlan');
      break;
    case 'show-history':
      await vscode.commands.executeCommand('ideaToCode.showHistory', session);
      break;
    case 'open-plan':
      await vscode.commands.executeCommand('ideaToCode.openApp');
      break;
    case 'trust':
      await vscode.commands.executeCommand('workbench.trust.manage');
      break;
    case 'open-folder':
      await vscode.commands.executeCommand('vscode.openFolder');
      break;
    case 'undo':
      // The chat's own Undo goes through the chat, which knows which change it means.
      break;
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** For a page still loading, which isn't listening yet. */
  private pending: HostMessage | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly source: ChatSource,
    private readonly host: ProjectHost,
    private readonly log: vscode.LogOutputChannel,
    /** Where page errors are collected for the in-editor tests. */
    private readonly events?: { errors: string[] },
  ) {}

  private post(message: HostMessage): void {
    // A hidden view isn't listening; it gets the whole conversation when it's shown again.
    if (this.view?.visible === true) void this.view.webview.postMessage(HostMessage.parse(message));
  }

  private sendView(): void {
    this.post({ type: 'chat', view: this.source.view() });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const { webview } = view;
    webview.options = webviewOptions(this.context.extensionUri);
    webview.html = webviewHtml(webview, this.context.extensionUri, 'chat');
    const subscription = vscode.Disposable.from(
      this.source.onDidChange(() => {
        this.sendView();
      }),
      this.source.onText((event) => {
        this.post({ type: 'chat-text', ...event });
      }),
      view.onDidChangeVisibility(() => {
        this.sendView();
      }),
      this.host.models.onDidChange(() => {
        if (!this.host.state.trusted) return;
        void this.host.models.view().then((models) => {
          this.post({ type: 'model-settings', view: models });
        });
      }),
      webview.onDidReceiveMessage(async (raw: unknown) => {
        const parsed = WebviewMessage.safeParse(raw);
        if (!parsed.success) {
          this.log.warn(`dropped a bad message from the chat: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
          return;
        }
        const message = parsed.data;
        const post = (reply: HostMessage) => {
          this.post(reply);
        };
        if (await handleSettingsMessage(message, this.host.models, this.host.state.trusted, post)) return;
        switch (message.type) {
          case 'ready':
            this.sendView();
            if (this.pending) this.post(this.pending);
            this.pending = undefined;
            break;
          case 'chat-get':
            this.sendView();
            break;
          case 'settings-shown':
            // The chat's own buttons mean nothing on the settings, so they hide with it.
            view.title = message.shown ? 'Settings' : 'Chat';
            await vscode.commands.executeCommand('setContext', 'ideaToCode.settingsShown', message.shown);
            break;
          case 'log':
            if (message.level === 'error') this.events?.errors.push(`chat: ${message.message}`);
            this.log[message.level](`chat: ${message.message}`);
            break;
          case 'chat-send':
            await this.source.send(message.text);
            break;
          case 'chat-cancel':
            this.source.cancel();
            break;
          case 'chat-new':
            await this.source.newThread();
            break;
          case 'chat-open':
            await this.source.openThread(message.id);
            break;
          case 'chat-action':
            if (message.action === 'undo') await this.source.undo();
            else await runAction(message.action, message.session);
            break;
          case 'chat-show-changes':
            this.source.showChanges(message.reveal);
            break;
          default:
            // The chart's messages don't come from this page.
            break;
        }
      }),
    );
    view.onDidDispose(() => {
      subscription.dispose();
      this.view = undefined;
    });
  }

  /** Brings the chat into view, e.g. from the New Chat command. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  }

  /** Shows settings in the chat's place, where the chat's menu was opened. */
  async showSettings(tab?: SettingsTab): Promise<void> {
    const message: HostMessage = { type: 'show-settings', ...(tab === undefined ? {} : { tab }) };
    const listening = this.view?.visible === true;
    await this.reveal();
    if (listening) this.post(message);
    else this.pending = message;
  }
}

/** Previous Chats: the editor's own picker, newest first. */
export async function pickChat(source: ChatSource, provider: ChatViewProvider): Promise<void> {
  const { threads, current } = source.view();
  const items = [...threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((thread) => ({
      label: thread.title,
      description: thread.id === current?.id ? 'Open now' : new Date(thread.updatedAt).toLocaleDateString(),
      id: thread.id,
    }));
  const picked = await vscode.window.showQuickPick(items, { title: 'Previous chats', placeHolder: 'Open a chat' });
  if (!picked) return;
  await source.openThread(picked.id);
  await provider.reveal();
}
