import { describe, it, expect } from 'vitest';
import * as G from '../src/ghsetup';
import { CmdError } from '../src/git';

describe('gh error classification', () => {
  it('spots a missing gh from the spawn error', () => {
    expect(G.isGhMissing(new CmdError('gh pr failed: spawn gh ENOENT', '', 'ENOENT'))).toBe(true);
    expect(G.isGhMissing(new Error('gh pr failed: spawn gh ENOENT'))).toBe(true);
    expect(G.isGhMissing(new Error('git log failed: bad revision'))).toBe(false);
    expect(G.classifyGhError(new Error('gh pr failed: spawn gh ENOENT'))).toBe('missing');
  });
  it('spots a signed-out gh', () => {
    const e = new CmdError('gh pr failed: To get started with GitHub CLI, please run:  gh auth login', 'To get started with GitHub CLI, please run:  gh auth login', 4);
    expect(G.classifyGhError(e)).toBe('signedOut');
    expect(G.classifyGhError(new Error('You are not logged into any GitHub hosts.'))).toBe('signedOut');
    expect(G.classifyGhError(new Error('no git remotes found'))).toBeUndefined();
  });
  it('gives plain-language text instead of the raw error', () => {
    expect(G.friendlyGhError(new Error('gh pr failed: spawn gh ENOENT'))).toMatch(/not installed/);
    expect(G.friendlyGhError(new Error('gh pr failed: spawn gh ENOENT'))).not.toMatch(/ENOENT/);
    expect(G.friendlyGhError(new Error('other'))).toBeUndefined();
  });
});

describe('gh install locations', () => {
  it('covers the Windows installers', () => {
    const c = G.ghCandidates('win32', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a');
    expect(c).toContain('C:\\Program Files\\GitHub CLI\\gh.exe');
    expect(c).toContain('C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.exe');
    expect(c).toContain('C:\\Users\\a\\scoop\\shims\\gh.exe');
    expect(c).toContain('C:\\ProgramData\\chocolatey\\bin\\gh.exe');
  });
  it('covers Homebrew on macOS and common Linux paths', () => {
    expect(G.ghCandidates('darwin', {}, '/Users/a')).toEqual(expect.arrayContaining(['/opt/homebrew/bin/gh', '/usr/local/bin/gh']));
    expect(G.ghCandidates('darwin', {}, '/Users/a')).not.toContain('/snap/bin/gh');
    expect(G.ghCandidates('linux', {}, '/home/a')).toEqual(expect.arrayContaining(['/usr/bin/gh', '/snap/bin/gh', '/home/a/.local/bin/gh']));
  });
});

describe('setup plan', () => {
  it('does nothing when ready', () => {
    expect(G.setupPlan({ platform: 'win32', state: 'ready' })).toBeUndefined();
  });
  it('installs with winget, reloads PATH and signs in on Windows', () => {
    const p = G.setupPlan({ platform: 'win32', state: 'missing' });
    expect(p).toMatchObject({ kind: 'terminal', shell: 'powershell.exe' });
    const cmd = (p as any).command as string;
    expect(cmd.indexOf('winget install --id GitHub.cli')).toBeLessThan(cmd.indexOf('$env:Path'));
    expect(cmd.indexOf('$env:Path')).toBeLessThan(cmd.indexOf('gh auth login'));
  });
  it('only signs in when gh is installed but signed out', () => {
    const p = G.setupPlan({ platform: 'win32', state: 'signedOut', gh: 'C:\\Program Files\\GitHub CLI\\gh.exe' }) as any;
    expect(p.command).toBe("& 'C:\\Program Files\\GitHub CLI\\gh.exe' auth login --hostname github.com --git-protocol https --web");
    expect(p.command).not.toMatch(/winget/);
    expect((G.setupPlan({ platform: 'linux', state: 'signedOut', gh: '/usr/bin/gh' }) as any).command).toBe("'/usr/bin/gh' auth login --hostname github.com --git-protocol https --web");
  });
  it('uses Homebrew on macOS, or the install page without it', () => {
    const p = G.setupPlan({ platform: 'darwin', state: 'missing', brew: '/opt/homebrew/bin/brew' }) as any;
    expect(p.command).toBe("'/opt/homebrew/bin/brew' install gh && '/opt/homebrew/bin/gh' auth login --hostname github.com --git-protocol https --web");
    expect(G.setupPlan({ platform: 'darwin', state: 'missing' })).toMatchObject({ kind: 'docs', url: G.INSTALL_DOCS });
  });
  it('links the install page on Linux', () => {
    expect(G.setupPlan({ platform: 'linux', state: 'missing' })).toMatchObject({ kind: 'docs', url: G.LINUX_DOCS });
  });
});
