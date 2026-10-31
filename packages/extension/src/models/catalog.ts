// The models suggested for each provider. Any other ID can be typed in. `tested` means
// it passed the built-in agent check (at least 90% of plans valid), and nothing else.
import type { KeyProvider } from './ownKey.js';

export interface CatalogModel {
  id: string;
  tested: boolean;
}

export interface CatalogProvider {
  label: string;
  /** A local endpoint such as Ollama needs no key. */
  keyRequired: boolean;
  large: readonly CatalogModel[];
  small: readonly CatalogModel[];
}

export const CATALOG: Record<KeyProvider, CatalogProvider> = {
  anthropic: {
    label: 'Anthropic',
    keyRequired: true,
    large: [
      { id: 'claude-opus-5-5', tested: false },
      { id: 'claude-sonnet-5-5', tested: false },
    ],
    small: [{ id: 'claude-haiku-5-5', tested: false }],
  },
  openai: {
    label: 'OpenAI',
    keyRequired: true,
    large: [{ id: 'gpt-5.5', tested: true }],
    small: [
      { id: 'gpt-5.4-mini', tested: false },
      { id: 'gpt-5.4-nano', tested: false },
    ],
  },
  google: {
    label: 'Google',
    keyRequired: true,
    large: [{ id: 'gemini-pro-latest', tested: false }],
    small: [
      { id: 'gemini-flash-latest', tested: false },
      { id: 'gemini-flash-lite-latest', tested: false },
    ],
  },
  custom: { label: 'Custom (OpenAI-compatible)', keyRequired: false, large: [], small: [] },
};
