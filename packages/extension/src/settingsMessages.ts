// The settings' side of the chat page's messages: models, only in a trusted folder,
// since Restricted Mode has no chat.
import type { HostMessage, WebviewMessage } from '@idea-to-code/core';
import type { ModelHost } from './models/modelHost.js';

/** Handles a settings message, if it is one. Answers whether it was. */
export async function handleSettingsMessage(
  message: WebviewMessage,
  models: ModelHost,
  trusted: boolean,
  post: (message: HostMessage) => void,
): Promise<boolean> {
  switch (message.type) {
    case 'model-settings-get':
      if (trusted) post({ type: 'model-settings', view: await models.view() });
      return true;
    case 'model-settings-set':
      if (trusted) await models.update(message.patch);
      return true;
    case 'model-key':
      if (!trusted) return true;
      if (message.action === 'set') await models.promptForKey(message.provider);
      else await models.removeKey(message.provider);
      return true;
    case 'model-test':
      if (trusted) post({ type: 'model-test-result', results: await models.test() });
      return true;
    default:
      return false;
  }
}
