import { describe, expect, it } from 'vitest';
import { conversation, KEEP_TURNS, latestMessage, summarizeEarlier } from '../../src/chat/context.js';
import type { Turn } from '../../src/chat/transcript.js';

function turn(n: number, summary?: string): Turn {
  return {
    id: `t${String(n)}`,
    at: n,
    user: `Message ${String(n)}`,
    outcome: 'done',
    ...(summary === undefined ? {} : { summary }),
    messages: [
      { role: 'assistant', text: '', toolCalls: [{ id: `c${String(n)}`, name: 'get_flow', input: { flowId: 'bookings' } }] },
      { role: 'tool', callId: `c${String(n)}`, name: 'get_flow', result: '<plan>\nFlow bookings: a long result…\n</plan>' },
      { role: 'assistant', text: `Reply ${String(n)}` },
    ],
  };
}

describe('the conversation sent each turn', () => {
  it('shrinks past tool results to a line, keeping each call paired with its result', () => {
    const messages = conversation([turn(1)]);
    expect(messages).toEqual([
      { role: 'user', text: 'Message 1' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'get_flow', input: { flowId: 'bookings' } }] },
      { role: 'tool', callId: 'c1', name: 'get_flow', result: 'get_flow bookings → ok' },
      { role: 'assistant', text: 'Reply 1' },
    ]);
  });

  it('never carries the plan in earlier messages', () => {
    const sent = JSON.stringify(conversation([turn(1), turn(2)]));
    expect(sent).not.toContain('<plan>');
  });

  it('summarizes turns older than the last few, from what they changed', () => {
    const turns = Array.from({ length: KEEP_TURNS + 2 }, (_, i) => turn(i + 1, i === 0 ? "Added feature 'Fees'" : undefined));
    const messages = conversation(turns);
    expect(messages[0]).toEqual({ role: 'user', text: summarizeEarlier(turns.slice(0, 2)) });
    expect(messages[0]?.role === 'user' && messages[0].text).toBe(
      'Earlier in this chat:\n- "Message 1" → Added feature \'Fees\'\n- "Message 2" → no changes',
    );
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(KEEP_TURNS + 1);
  });
});

describe('the latest message', () => {
  it('carries the plan as data, then what the user wrote', () => {
    const message = latestMessage('Mark it done', { mapView: 'MAP', since: "'Pick dates' → done", recent: '- Chat: 3 changes' });
    expect(message.role === 'user' && message.text).toBe(
      "<plan>\nMAP\n</plan>\n\n<plan>\nRecent work on this plan:\n- Chat: 3 changes\n</plan>\n\n<plan>\nChanged by someone else since your last turn: 'Pick dates' → done\n</plan>\n\nMark it done",
    );
  });

  it('leaves out what has nothing to say', () => {
    const message = latestMessage('Hi', { mapView: 'MAP' });
    expect(message.role === 'user' && message.text).toBe('<plan>\nMAP\n</plan>\n\nHi');
  });
});
