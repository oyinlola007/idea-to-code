// A local server that speaks the OpenAI streaming format, so the real SDK runs in the
// real editor's runtime with no key and no cost. It records what it was sent.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted answer: tool calls and/or text, sent after an optional pause. */
export interface ScriptedAnswer {
  text?: string;
  calls?: { name: string; input: unknown }[];
  delayMs?: number;
}

export interface FakeModelServer {
  baseUrl: string;
  /** Answers given in order to requests that offer tools, instead of the default one. */
  script: ScriptedAnswer[];
  authorizations: (string | undefined)[];
  bodies: unknown[];
  close(): Promise<void>;
}

const sse = (chunks: unknown[]) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
const chunk = (delta: unknown, finish: string | null = null) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fake',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

export async function startFakeModelServer(acceptedKey: string): Promise<FakeModelServer> {
  const authorizations: (string | undefined)[] = [];
  const bodies: unknown[] = [];
  const script: ScriptedAnswer[] = [];
  let calls = 0;
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (data: Buffer) => (text += data.toString()));
    req.on('end', () => {
      const body = JSON.parse(text) as { tools?: unknown[]; model?: string };
      authorizations.push(req.headers.authorization);
      bodies.push(body);
      if (req.headers.authorization !== `Bearer ${acceptedKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization ?? 'none'}` } }));
        return;
      }
      if (body.model === 'missing') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'no such model' } }));
        return;
      }
      const scripted = (body.tools?.length ?? 0) > 0 ? script.shift() : undefined;
      if (scripted) {
        const chunks = [
          chunk({ role: 'assistant', content: scripted.text ?? '' }),
          ...(scripted.calls ?? []).map((c, index) =>
            chunk({
              tool_calls: [
                { index, id: `call-${String(++calls)}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } },
              ],
            }),
          ),
          chunk({}, (scripted.calls ?? []).length > 0 ? 'tool_calls' : 'stop'),
        ];
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(sse(chunks));
        }, scripted.delayMs ?? 0);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const call = { index: 0, id: 'call-1', type: 'function', function: { name: 'add_feature', arguments: '{"label":"Fees"}' } };
      res.end(
        sse(
          (body.tools?.length ?? 0) > 0
            ? [chunk({ role: 'assistant', content: 'Adding it.' }), chunk({ tool_calls: [call] }), chunk({}, 'tool_calls')]
            : [chunk({ role: 'assistant', content: 'O' }), chunk({ content: 'K' }), chunk({}, 'stop')],
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`,
    script,
    authorizations,
    bodies,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
