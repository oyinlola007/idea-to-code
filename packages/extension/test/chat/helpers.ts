import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatFiles } from '../../src/chat/transcript.js';
import { ModelError, type ChatEvent, type ChatRequest, type ModelProvider, type ToolCall } from '../../src/models/provider.js';

/** One scripted model answer: text and tool calls, or a hang until the turn is stopped. */
export type Script = { text?: string; calls?: Omit<ToolCall, 'id'>[] } | 'hang' | ModelError;

let callIds = 0;

/** A model that answers from a script, one entry per call, and keeps every request it was sent. */
export function scripted(script: Script[]): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let at = 0;
  return {
    requests,
    async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const next = script[at++] ?? { text: '(no more script)' };
      if (next instanceof ModelError) throw next;
      if (next === 'hang') {
        yield { type: 'text', text: 'Working on it' };
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          request.signal?.addEventListener('abort', () => {
            resolve();
          });
        });
        throw new ModelError('cancelled', 'Cancelled.');
      }
      if (next.text !== undefined) for (const word of next.text.split(/(?<= )/)) yield { type: 'text', text: word };
      for (const call of next.calls ?? []) yield { type: 'tool-call', call: { ...call, id: `call-${String(++callIds)}` } };
      yield { type: 'finish', inputTokens: 100, outputTokens: 10 };
    },
  };
}

export class MemoryChatFiles implements ChatFiles {
  readonly files = new Map<string, string>();
  read(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }
  write(path: string, text: string): Promise<void> {
    this.files.set(path, text);
    return Promise.resolve();
  }
  append(path: string, text: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? '') + text);
    return Promise.resolve();
  }
}

const FIXTURE = fileURLToPath(new URL('../../../core/test/fixtures/toolshed/plan/', import.meta.url));

/** The fictitious Toolshed plan's files. */
export async function toolshedTexts(): Promise<Record<string, string>> {
  const texts: Record<string, string> = { 'plan/map.yaml': await readFile(join(FIXTURE, 'map.yaml'), 'utf8') };
  for (const name of await readdir(join(FIXTURE, 'features')))
    texts[`plan/features/${name}`] = await readFile(join(FIXTURE, 'features', name), 'utf8');
  return texts;
}

/** A temp project folder holding the Toolshed plan. */
export async function toolshedFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'itc-chat-test-'));
  for (const [path, text] of Object.entries(await toolshedTexts())) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
