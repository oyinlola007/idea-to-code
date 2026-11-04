import { describe, expect, it } from 'vitest';
import { ModelDecider, NO_DECISION, parseKind } from '../../src/chat/decider.js';
import { ModelError } from '../../src/models/provider.js';
import { scripted } from './helpers.js';

describe('deciding how much model a message needs', () => {
  it('reads the one word, however it is written', () => {
    expect(parseKind('Plan.')).toBe('plan');
    expect(parseKind('EDIT')).toBe('edit');
    expect(parseKind('question\n')).toBe('question');
    expect(parseKind('  edit - it is small')).toBe('edit');
    expect(parseKind('I think this is a plan')).toBeUndefined();
  });

  it('asks the fast model with the message alone, and no tools', async () => {
    const model = scripted([{ text: 'edit' }]);
    expect(await new ModelDecider(model, 'fast').decide('Rename Pick dates to Choose dates')).toEqual({ kind: 'edit', by: 'model' });
    expect(model.requests[0]).toMatchObject({
      model: 'fast',
      tools: [],
      messages: [{ role: 'user', text: 'Rename Pick dates to Choose dates' }],
    });
  });

  it('falls back to the main model when the answer is unclear or the call fails', async () => {
    expect(await new ModelDecider(scripted([{ text: 'hmm' }]), 'fast').decide('x')).toEqual({ kind: 'plan', by: 'fallback' });
    const failing = scripted([new ModelError('rate-limited', 'Too many')]);
    expect(await new ModelDecider(failing, 'fast').decide('x')).toEqual({ kind: 'plan', by: 'fallback' });
  });

  it('stops when the turn is stopped', async () => {
    const stopped = scripted([new ModelError('cancelled', 'Cancelled.')]);
    await expect(new ModelDecider(stopped, 'fast').decide('x')).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('decides nothing when there is only one model', async () => {
    expect(await NO_DECISION.decide('anything')).toEqual({ kind: 'plan', by: 'skipped' });
  });
});
