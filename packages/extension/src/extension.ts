// The idea-to-code extension: wires the plan host to the views, tabs and commands.
import type { SettingsTab } from '@idea-to-code/core';
import * as vscode from 'vscode';
import { AppPanel } from './appPanel.js';
import { ChatService } from './chat/chatService.js';
import { ChatStore } from './chat/transcript.js';
import { VsCodeChatFiles } from './chat/vscodeChatFiles.js';
import { CHAT_VIEW_ID, ChatViewProvider, pickChat } from './chatView.js';
import { detectOptionalApis, type OptionalApis } from './detect.js';
import { exportWebPage } from './exportPage.js';
import { registerMcpServer } from './mcpServer.js';
import { initPlan } from './initPlan.js';
import { ModelHost } from './models/modelHost.js';
import { PlanEditor, reopenAsText } from './planEditor.js';
import { ProjectHost } from './projectHost.js';
import { WorkspaceTrust } from './trust.js';
import { WebviewEvents } from './webviewConnection.js';

/** Returned from activate() for the in-editor tests. */
export interface ExtensionApi {
  host: ProjectHost;
  trust: WorkspaceTrust;
  events: WebviewEvents;
  optionalApis: OptionalApis;
  chat: ChatService;
  /** Where this editor keeps chats for the workspace. */
  chatStorage: vscode.Uri;
  closeApp(): void;
  showLevel(level: string): void;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const log = vscode.window.createOutputChannel('idea-to-code', { log: true });
  const optionalApis = detectOptionalApis();
  log.info(`activated in ${vscode.env.appName} ${vscode.version}; optional APIs: ${JSON.stringify(optionalApis)}`);

  const trust = new WorkspaceTrust();
  const models = new ModelHost(context.secrets);
  const host = new ProjectHost(log, trust, models);
  const events = new WebviewEvents();
  const app = new AppPanel(context, host, events, log);
  const editor = new PlanEditor(context, host, events, log);
  // Chats stay in this editor's storage for the workspace; without a workspace there's no plan to chat about.
  const chatStorage = context.storageUri ?? context.globalStorageUri;
  const chatService = new ChatService({
    host: {
      service: () => host.service,
      state: () => host.state,
      hasFolder: () => (vscode.workspace.workspaceFolders ?? []).length > 0,
      level: () => host.currentLevel,
      setPreview: (texts) => {
        host.setPreview(texts);
      },
      setBusy: (busy) => {
        host.setAgentBusy(busy);
      },
      undo: (latest) => host.undo(latest),
      reveal: (reveal, bringForward) => {
        app.reveal(reveal, bringForward);
      },
      // The chart opens beside the chat, so the plan is seen being made.
      startPlan: async () => {
        const started = await initPlan(host, trust);
        if (started) app.show();
        return started;
      },
      onDidChange: (listener) => host.onDidChange(listener),
    },
    models: { model: (tier) => models.service.model(tier), onDidChange: (listener) => models.onDidChange(listener) },
    store: new ChatStore(new VsCodeChatFiles(chatStorage)),
    editor: vscode.env.appName,
    log,
  });
  const chat = new ChatViewProvider(context, chatService, host, log, events);
  // Claude Code or another agent changed the plan: point it out, as the built-in agent's changes are.
  const outside = host.onDidReveal((reveal) => {
    app.reveal(reveal, false);
  });
  const mcp = registerMcpServer(context, host, trust);
  if (mcp) context.subscriptions.push(mcp);

  context.subscriptions.push(
    log,
    trust,
    models,
    host,
    events,
    app.register(),
    editor.register(),
    chatService,
    outside,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chat),
    vscode.commands.registerCommand('ideaToCode.newChat', async () => {
      await chatService.newThread();
      await chat.reveal();
    }),
    vscode.commands.registerCommand('ideaToCode.openChat', () => pickChat(chatService, chat)),
    vscode.commands.registerCommand('ideaToCode.openApp', () => {
      app.show();
    }),
    vscode.commands.registerCommand('ideaToCode.exportWebPage', (target?: vscode.Uri) => exportWebPage(context.extensionUri, host, target)),
    vscode.commands.registerCommand('ideaToCode.showHistory', (session?: string) => {
      app.showHistory(session);
    }),
    vscode.commands.registerCommand('ideaToCode.openSettings', (tab?: SettingsTab) => chat.showSettings(tab)),
    vscode.commands.registerCommand('ideaToCode.initPlan', async () => {
      await initPlan(host, trust);
      if (host.state.kind === 'plan') app.show();
    }),
    vscode.commands.registerCommand('ideaToCode.reopenAsText', (uri?: vscode.Uri) => reopenAsText(uri)),
    vscode.commands.registerCommand('ideaToCode.openPreviewToSide', (uri?: vscode.Uri) => editor.openToSide(uri)),
  );
  void host.refresh();
  void chatService.start().catch((err: unknown) => {
    log.error(`couldn't open the chat: ${err instanceof Error ? err.message : String(err)}`);
  });
  return {
    host,
    trust,
    events,
    optionalApis,
    chat: chatService,
    chatStorage,
    closeApp: () => {
      app.close();
    },
    showLevel: (level) => {
      app.showLevel(level);
    },
  };
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}
