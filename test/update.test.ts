import { describe, it, expect } from 'vitest';
import * as U from '../src/update';

describe('editor command line tool candidates', () => {
  it('finds Cursor and VS Code tools under the install folder on Windows', () => {
    const c = U.editorCliCandidates({ platform: 'win32', appRoot: 'C:\\Users\\a\\AppData\\Local\\Programs\\cursor\\resources\\app', execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\cursor\\Cursor.exe', env: { Path: 'C:\\Windows;C:\\Tools' } });
    expect(c).toContain('C:\\Users\\a\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd');
    expect(c).toContain('C:\\Users\\a\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\code.cmd');
    expect(c).toContain('C:\\Tools\\code.cmd');
  });
  it('also looks on PATH on Linux', () => {
    const c = U.editorCliCandidates({ platform: 'linux', appRoot: '/opt/code/resources/app', execPath: '/opt/code/code', env: { PATH: '/usr/bin:/usr/local/bin' } });
    expect(c).toContain('/usr/local/bin/code'); expect(c).toContain('/opt/code/bin/code');
  });
});

describe('friendly network errors', () => {
  const fetchFailed = (code: string, message = '') => Object.assign(new TypeError('fetch failed'), { cause: { code, message } });
  it('never shows the bare "fetch failed"', () => {
    expect(U.friendlyNetworkError(fetchFailed('ENOTFOUND'), 'check for updates')).toMatch(/GitHub could not be reached \(ENOTFOUND\)/);
    expect(U.friendlyNetworkError(new TypeError('fetch failed'), 'check for updates')).toMatch(/Could not check for updates/);
  });
  it('explains certificate problems', () => {
    expect(U.friendlyNetworkError(fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'download the update')).toMatch(/proxy or antivirus/);
  });
  it('passes other errors through', () => { expect(U.friendlyNetworkError(new Error('boom'), 'x')).toBe('boom'); });
});
