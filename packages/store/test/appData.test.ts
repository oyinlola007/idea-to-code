import { describe, expect, it } from 'vitest';
import { appDataDir } from '../src/appData.js';

describe('appDataDir', () => {
  it('uses Application Support on macOS', () => {
    expect(appDataDir({ platform: 'darwin', env: {}, home: '/Users/ada' })).toBe('/Users/ada/Library/Application Support/idea-to-code');
  });

  it('uses APPDATA on Windows, with a fallback', () => {
    expect(appDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, home: 'C:\\Users\\ada' })).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\idea-to-code',
    );
    expect(appDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\ada' })).toBe('C:\\Users\\ada\\AppData\\Roaming\\idea-to-code');
  });

  it('follows XDG on Linux, with a fallback', () => {
    expect(appDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/ada' })).toBe('/data/idea-to-code');
    expect(appDataDir({ platform: 'linux', env: {}, home: '/home/ada' })).toBe('/home/ada/.local/share/idea-to-code');
  });

  it('can be overridden, e.g. for tests', () => {
    expect(appDataDir({ platform: 'darwin', env: { IDEA_TO_CODE_DATA: '/tmp/x' }, home: '/Users/ada' })).toBe('/tmp/x');
  });
});
