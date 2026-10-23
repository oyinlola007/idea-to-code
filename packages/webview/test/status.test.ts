import { describe, expect, it } from 'vitest';
import { statusText } from '../src/status.js';

describe('statusText', () => {
  it('names every status', () => {
    expect(statusText('todo')).toBe('To do');
    expect(statusText('in_progress')).toBe('In progress');
    expect(statusText('done')).toBe('Done');
  });
});
