import { describe, expect, it } from 'vitest';
import { progressText, statusText } from '../src/status.js';

describe('statusText', () => {
  it('names every status', () => {
    expect(statusText('todo')).toBe('To do');
    expect(statusText('in_progress')).toBe('In progress');
    expect(statusText('done')).toBe('Done');
  });
});

describe('progressText', () => {
  it('says when there is nothing to count', () => {
    expect(progressText(0, 0)).toBe('No steps yet');
    expect(progressText(7, 15)).toBe('7 of 15 done');
  });
});
