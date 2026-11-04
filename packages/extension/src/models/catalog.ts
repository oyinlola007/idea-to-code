// The models suggested for each provider, best first: the first is the default. A
// short list on purpose; any other ID can be typed in. Checked against each provider's
// own model and pricing pages on 2026-11-04.
import type { KeyProvider } from './ownKey.js';

export interface CatalogProvider {
  label: string;
  /** A local endpoint such as Ollama needs no key. */
  keyRequired: boolean;
  /** For planning and questions. */
  large: readonly string[];
  /** For the decider and small edits: fast and cheap. */
  small: readonly string[];
}

export const CATALOG: Record<KeyProvider, CatalogProvider> = {
  anthropic: {
    label: 'Anthropic',
    keyRequired: true,
    large: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'],
    small: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
  },
  openai: {
    label: 'OpenAI',
    keyRequired: true,
    // gpt-5.5 stays because it's the one the built-in agent check has passed with.
    large: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5'],
    small: ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.4-mini'],
  },
  google: {
    label: 'Google',
    keyRequired: true,
    // Google recommends 3.8 Flash for new projects; Gemini 4 Argon is newer but not yet marked stable.
    large: ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.1-pro-preview'],
    small: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  },
  custom: { label: 'Custom (OpenAI-compatible)', keyRequired: false, large: [], small: [] },
};
