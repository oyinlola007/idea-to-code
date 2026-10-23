import { describe, expect, it } from 'vitest';
import { serverInfo } from '../src/index.js';

describe('serverInfo', () => {
  it('names the published package and carries its version', () => {
    expect(serverInfo.name).toBe('idea-to-code-mcp');
    expect(serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
