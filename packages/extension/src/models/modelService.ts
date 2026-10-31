// Which model the chat uses, and how the settings view sees it. Keys go in and are used
// here, but no method returns one: the view only ever says whether a key is saved.
import type { ModelSettingsPatch, ModelSettingsView, ModelTestResult, ModelTier } from '@idea-to-code/core';
import { z } from 'zod';
import { CATALOG } from './catalog.js';
import { LanguageModelProvider, listEditorModels, type LmApi, type LmModel } from './languageModel.js';
import { KEY_PROVIDERS, OwnKeyProvider, type KeyProvider } from './ownKey.js';
import { ModelError, type ModelProvider } from './provider.js';

/** Settings read and written at user level. A workspace value must never count: a cloned repo could send the user's key to its own address. */
export interface UserConfig {
  get(key: string): unknown;
  set(key: string, value: unknown): Thenable<void>;
}

export interface Secrets {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const Tiers = z.record(z.string(), z.object({ large: z.string().optional(), small: z.string().optional() }));
const EDITOR = 'editor';
const secretName = (provider: KeyProvider) => `ideaToCode.key.${provider}`;

export function isKeyProvider(value: unknown): value is KeyProvider {
  return KEY_PROVIDERS.includes(value as KeyProvider);
}

/** What's wrong with an address, if anything. */
function addressProblem(text: string): string | undefined {
  if (text === '') return 'Enter the address of the endpoint, like http://localhost:11434/v1.';
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:' ? undefined : 'The address must start with http:// or https://.';
  } catch {
    return "That isn't a valid address.";
  }
}

/** A key sent over plain http can be read on the way, unless it stays on this machine. */
function sendsInClear(text: string): boolean {
  try {
    const { protocol, hostname } = new URL(text);
    return protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export class ModelService {
  constructor(
    private readonly config: UserConfig,
    private readonly secrets: Secrets,
    private readonly lm: () => LmApi | undefined,
  ) {}

  private provider(): KeyProvider {
    const stored = this.config.get('provider');
    return isKeyProvider(stored) ? stored : 'anthropic';
  }

  private baseUrl(): string {
    const stored = this.config.get('baseUrl');
    return typeof stored === 'string' ? stored : '';
  }

  private tiers(): z.infer<typeof Tiers> {
    return Tiers.safeParse(this.config.get('tiers')).data ?? {};
  }

  /** The guaranteed fallback: without models in the editor, the own-key route is what's used, whatever was chosen before. */
  private usesEditor(editorModels: readonly LmModel[]): boolean {
    return editorModels.length > 0 && this.config.get('source') !== 'key';
  }

  private chosen(route: string, tier: ModelTier, editorModels: readonly LmModel[]): string {
    const stored = this.tiers()[route]?.[tier];
    if (stored) return stored;
    if (route === EDITOR) {
      // Nothing smaller is known about the editor's models, so the small tier follows the main one.
      const main = this.tiers()[route]?.large;
      return main ?? editorModels[0]?.id ?? '';
    }
    return isKeyProvider(route) ? (CATALOG[route][tier][0]?.id ?? '') : '';
  }

  async view(): Promise<ModelSettingsView> {
    const editorModels = await listEditorModels(this.lm());
    const usesEditor = this.usesEditor(editorModels);
    const provider = this.provider();
    const route = usesEditor ? EDITOR : provider;
    const baseUrl = this.baseUrl();
    const hasKey = async (id: KeyProvider) => (await this.secrets.get(secretName(id))) !== undefined;
    const problem = addressProblem(baseUrl);
    return {
      source: usesEditor ? 'editor' : 'key',
      editorModels: editorModels.map((model) => ({ id: model.id, label: model.vendor ? `${model.name} (${model.vendor})` : model.name })),
      provider,
      providers: await Promise.all(
        KEY_PROVIDERS.map(async (id) => ({
          id,
          label: CATALOG[id].label,
          keyRequired: CATALOG[id].keyRequired,
          hasKey: await hasKey(id),
          large: [...CATALOG[id].large],
          small: [...CATALOG[id].small],
        })),
      ),
      baseUrl,
      ...(provider === 'custom' && problem !== undefined ? { baseUrlProblem: problem } : {}),
      ...(provider === 'custom' && sendsInClear(baseUrl) && (await hasKey('custom')) ? { sendsKeyInClear: true } : {}),
      large: this.chosen(route, 'large', editorModels),
      small: this.chosen(route, 'small', editorModels),
    };
  }

  async update(patch: ModelSettingsPatch): Promise<void> {
    if (patch.source !== undefined) await this.config.set('source', patch.source);
    if (patch.provider !== undefined) await this.config.set('provider', patch.provider);
    if (patch.baseUrl !== undefined) await this.config.set('baseUrl', patch.baseUrl.trim());
    if (patch.large === undefined && patch.small === undefined) return;
    const route = this.usesEditor(await listEditorModels(this.lm())) ? EDITOR : this.provider();
    const tiers = this.tiers();
    const current = { ...tiers[route] };
    if (patch.large !== undefined) current.large = patch.large.trim();
    if (patch.small !== undefined) current.small = patch.small.trim();
    await this.config.set('tiers', { ...tiers, [route]: current });
  }

  async saveKey(provider: KeyProvider, key: string): Promise<void> {
    await this.secrets.store(secretName(provider), key.trim());
  }

  async removeKey(provider: KeyProvider): Promise<void> {
    await this.secrets.delete(secretName(provider));
  }

  /** What the chat calls: the provider and model for a tier, or a ModelError saying what's missing. */
  async model(tier: ModelTier): Promise<{ provider: ModelProvider; model: string }> {
    const lm = this.lm();
    const editorModels = await listEditorModels(lm);
    if (lm && this.usesEditor(editorModels))
      return { provider: new LanguageModelProvider(lm), model: this.chosen(EDITOR, tier, editorModels) };

    const provider = this.provider();
    const key = await this.secrets.get(secretName(provider));
    if (CATALOG[provider].keyRequired && key === undefined)
      throw new ModelError('not-set-up', `Add your ${CATALOG[provider].label} API key first.`);
    const baseUrl = this.baseUrl();
    if (provider === 'custom') {
      const problem = addressProblem(baseUrl);
      if (problem !== undefined) throw new ModelError('not-set-up', problem);
    }
    const model = this.chosen(provider, tier, editorModels);
    if (model === '') throw new ModelError('not-set-up', 'Choose a model first.');
    return {
      provider: new OwnKeyProvider({ provider, key, ...(provider === 'custom' ? { baseUrl } : {}) }),
      model,
    };
  }

  /** Sends one short message to each configured model. It costs a few tokens, so it only runs when asked. */
  async test(): Promise<ModelTestResult[]> {
    const results: ModelTestResult[] = [];
    const seen = new Map<string, ModelTestResult>();
    for (const tier of ['large', 'small'] as const) {
      try {
        const { provider, model } = await this.model(tier);
        const earlier = seen.get(model);
        if (earlier) {
          results.push({ ...earlier, tier });
          continue;
        }
        const request = {
          model,
          system: '',
          messages: [{ role: 'user' as const, text: 'Reply with: OK' }],
          tools: [],
          maxOutputTokens: 64,
        };
        // Getting through without an error is the answer; the words don't matter.
        const answer = provider.chat(request)[Symbol.asyncIterator]();
        while (!(await answer.next()).done);
        const result = { tier, model, ok: true };
        seen.set(model, result);
        results.push(result);
      } catch (err) {
        results.push({ tier, model: '', ok: false, message: err instanceof ModelError ? err.message : 'The test failed unexpectedly.' });
      }
    }
    return results;
  }
}
