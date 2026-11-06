import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as links from '../src/transfer/links';
import {
  addLink,
  AGENT_TARGET_ACCESS,
  disableLink,
  LINKS_SETTING_KEY,
  LINKS_SETTING_SCOPE,
  loadRegistry,
  registryPath,
  resolveLink,
  updateLink,
} from '../src/transfer/links';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const SHA2 = '89abcdef0123456789abcdef0123456789abcdef';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isSymbolicLink()) { out.push(relative(dir, p) + '@'); continue; }
      if (ent.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

function digest(dir: string): string {
  const hash = createHash('sha256');
  for (const rel of listFiles(dir)) {
    hash.update(rel);
    hash.update('\0');
    if (!rel.endsWith('@')) hash.update(readFileSync(join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function targetState(dir: string) {
  return {
    vscode: existsSync(join(dir, '.vscode')),
    gitConfig: readFileSync(join(dir, '.git', 'config'), 'utf8'),
    gitFiles: listFiles(join(dir, '.git')),
    digest: digest(dir),
  };
}

describe('transfer links', () => {
  let tmp: string;
  let root: string;
  let target: string;
  let privateOps: string;
  let before: ReturnType<typeof targetState>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gk-pt4-'));
    root = join(tmp, 'root');
    target = join(root, 'target-repo');
    privateOps = join(tmp, 'private-ops');
    mkdirSync(root);
    initRepo(target);
    before = targetState(target);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function untouched() {
    const after = targetState(target);
    expect(after.vscode).toBe(false);
    expect(after.gitConfig).toBe(before.gitConfig);
    expect(after.gitFiles).toEqual(before.gitFiles);
    expect(after.digest).toBe(before.digest);
    expect(existsSync(join(target, '.vscode'))).toBe(false);
  }

  it('resolves a link inside the root and returns the stored targetBaseSha', () => {
    addLink(privateOps, root, { linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA, policy: { lane: 'synthetic' } });
    const resolved = resolveLink(privateOps, 'lnk-1');
    expect(resolved).toEqual({
      outcome: 'resolved',
      path: target,
      policy: { lane: 'synthetic' },
      targetBaseSha: SHA,
      agentLaunch: 'denied',
      agentApply: 'denied',
    });
    untouched();
  });

  it('refuses a missing file and an empty registry without writing', () => {
    expect(resolveLink(privateOps, 'lnk-1')).toEqual({ outcome: 'refuse', reason: 'empty-registry' });
    expect(existsSync(registryPath(privateOps))).toBe(false);
    mkdirSync(join(privateOps, 'transfer'), { recursive: true });
    writeFileSync(registryPath(privateOps), JSON.stringify({ root, links: [] }));
    const bytes = readFileSync(registryPath(privateOps));
    expect(resolveLink(privateOps, 'lnk-1')).toEqual({ outcome: 'refuse', reason: 'empty-registry' });
    expect(readFileSync(registryPath(privateOps))).toEqual(bytes);
    untouched();
  });

  it('refuses a missing id', () => {
    addLink(privateOps, root, { linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA });
    expect(resolveLink(privateOps, 'lnk-2')).toEqual({ outcome: 'refuse', reason: 'missing-id' });
    untouched();
  });

  it('refuses a missing target directory and does not create it', () => {
    const bareRoot = join(tmp, 'bare');
    const missing = join(bareRoot, 'target-repo');
    const ops = join(tmp, 'private-ops-bare');
    mkdirSync(bareRoot);
    addLink(ops, bareRoot, { linkId: 'lnk-missing', targetPath: missing, targetBaseSha: SHA });
    expect(resolveLink(ops, 'lnk-missing')).toEqual({ outcome: 'refuse', reason: 'missing-target' });
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(missing, '.git'))).toBe(false);
    expect(existsSync(join(missing, '.vscode'))).toBe(false);
    untouched();
  });

  it('refuses a path that escapes the root and does not create it', () => {
    const outside = join(tmp, 'outside');
    addLink(privateOps, root, { linkId: 'lnk-esc', targetPath: join(target, '..', '..', 'outside'), targetBaseSha: SHA });
    expect(resolveLink(privateOps, 'lnk-esc')).toEqual({ outcome: 'refuse', reason: 'path-escape' });
    expect(existsSync(outside)).toBe(false);
    untouched();
  });

  it('refuses a relative path that escapes the stored root', () => {
    const outside = join(tmp, 'outside');
    mkdirSync(join(privateOps, 'transfer'), { recursive: true });
    writeFileSync(registryPath(privateOps), JSON.stringify({
      root,
      links: [{ linkId: 'lnk-rel', targetPath: '../outside', targetBaseSha: SHA, disabled: false, policy: {} }],
    }));
    expect(resolveLink(privateOps, 'lnk-rel')).toEqual({ outcome: 'refuse', reason: 'path-escape' });
    expect(existsSync(outside)).toBe(false);
    untouched();
  });

  it('refuses a symlink whose real path leaves the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gk-pt4-out-'));
    try {
      const alias = join(root, 'alias-target');
      symlinkSync(outside, alias, 'dir');
      addLink(privateOps, root, { linkId: 'lnk-sym', targetPath: alias, targetBaseSha: SHA });
      expect(resolveLink(privateOps, 'lnk-sym')).toEqual({ outcome: 'refuse', reason: 'path-escape' });
      expect(readdirSync(outside)).toEqual([]);
      untouched();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a credential-bearing remote URL stored as the target', () => {
    const withPassword = 'https://user:example-token@example.com/org/repo.git';
    const tokenOnly = 'https://example-token@example.com/org/repo.git';
    const queryToken = 'https://example.com/org/repo.git?token=example-token';
    addLink(privateOps, root, { linkId: 'lnk-cred', targetPath: withPassword, targetBaseSha: SHA });
    addLink(privateOps, root, { linkId: 'lnk-token', targetPath: tokenOnly, targetBaseSha: SHA });
    addLink(privateOps, root, { linkId: 'lnk-query', targetPath: queryToken, targetBaseSha: SHA });
    expect(resolveLink(privateOps, 'lnk-cred')).toEqual({ outcome: 'refuse', reason: 'credential-url' });
    expect(resolveLink(privateOps, 'lnk-token')).toEqual({ outcome: 'refuse', reason: 'credential-url' });
    expect(resolveLink(privateOps, 'lnk-query')).toEqual({ outcome: 'refuse', reason: 'credential-url' });
    const stored = readFileSync(registryPath(privateOps), 'utf8');
    expect(stored).toContain(withPassword);
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).not.toContain('example-token');
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).not.toContain('example.com');
    untouched();
  });

  it('refuses a remote URL that is not a directory inside the root', () => {
    addLink(privateOps, root, { linkId: 'lnk-url', targetPath: 'https://example.com/org/repo.git', targetBaseSha: SHA });
    expect(resolveLink(privateOps, 'lnk-url')).toEqual({ outcome: 'refuse', reason: 'path-escape' });
    expect(existsSync(join(root, 'https://example.com/org/repo.git'))).toBe(false);
    untouched();
  });

  it('blocks a disabled link and does not write the target', () => {
    addLink(privateOps, root, { linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA, policy: { lane: 'synthetic' } });
    disableLink(privateOps, 'lnk-1');
    expect(resolveLink(privateOps, 'lnk-1')).toEqual({ outcome: 'blocked', reason: 'disabled' });
    untouched();
  });

  it('refuses an escaping path even when the link is disabled', () => {
    addLink(privateOps, root, { linkId: 'lnk-esc', targetPath: join(tmp, 'outside'), targetBaseSha: SHA });
    disableLink(privateOps, 'lnk-esc');
    expect(resolveLink(privateOps, 'lnk-esc')).toEqual({ outcome: 'refuse', reason: 'path-escape' });
    expect(existsSync(join(tmp, 'outside'))).toBe(false);
    untouched();
  });

  it('persists add, update, and disable only in the private registry', () => {
    const added = addLink(privateOps, root, { linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA, policy: { lane: 'a' } });
    expect(added).toMatchObject({ linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA, disabled: false, policy: { lane: 'a' } });
    expect(loadRegistry(privateOps).links).toEqual([added]);

    const updated = updateLink(privateOps, 'lnk-1', { targetBaseSha: SHA2, policy: { lane: 'b' } });
    expect(updated.targetBaseSha).toBe(SHA2);
    expect(updated.policy).toEqual({ lane: 'b' });
    expect(loadRegistry(privateOps).links[0]).toMatchObject({ targetBaseSha: SHA2, policy: { lane: 'b' }, disabled: false });

    const disabled = disableLink(privateOps, 'lnk-1');
    expect(disabled.disabled).toBe(true);
    const reloaded = loadRegistry(privateOps);
    expect(reloaded.root).toBe(root);
    expect(reloaded.links).toEqual([{
      linkId: 'lnk-1',
      targetPath: target,
      targetBaseSha: SHA2,
      disabled: true,
      policy: { lane: 'b' },
      agentLaunch: 'denied',
      agentApply: 'denied',
    }]);

    const file = registryPath(privateOps);
    expect(file.endsWith(join('transfer', 'links.json'))).toBe(true);
    expect((statSync(file).mode & 0o777)).toBe(0o600);
    expect((statSync(join(privateOps, 'transfer')).mode & 0o777)).toBe(0o700);
    expect(readFileSync(file, 'utf8')).not.toContain('dualRemote');
    expect(listFiles(tmp).filter(rel => rel.endsWith('settings.json') || rel.includes('.vscode'))).toEqual([]);
    untouched();
  });

  it('does not use dualRemote workspace settings as the store', () => {
    const src = readFileSync(new URL('../src/transfer/links.ts', import.meta.url), 'utf8');
    const ext = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('dualRemote');
    expect(src).not.toContain('getConfiguration');
    expect(src).not.toContain('WorkspaceFolder');
    expect(src).not.toContain('ConfigurationTarget');
    expect(ext).not.toContain('gitKitchen.transfer');
    expect(ext).not.toContain('transfer.links');
    addLink(privateOps, root, { linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA });
    const saved = readFileSync(registryPath(privateOps), 'utf8');
    expect(saved).not.toContain('dualRemote');
    expect(saved).not.toContain('.vscode');
    expect(existsSync(join(target, '.vscode', 'settings.json'))).toBe(false);
    expect(existsSync(join(root, '.vscode'))).toBe(false);
    untouched();
  });

  it('contributes gitKitchen.transfer.links at application scope', () => {
    const props = pkg.contributes.configuration.properties;
    const links = props[LINKS_SETTING_KEY];
    expect(LINKS_SETTING_KEY).toBe('gitKitchen.transfer.links');
    expect(LINKS_SETTING_SCOPE).toBe('application');
    expect(links.scope).toBe('application');
    expect(links.scope).not.toBe('resource');
    expect(links.scope).not.toBe('window');
    expect(props['gitKitchen.dualRemote.source'].scope).toBe('resource');
    expect(props['gitKitchen.dualRemote.target'].scope).toBe('resource');
    expect(links.properties.root.type).toBe('string');
    expect(links.properties.links.type).toBe('array');
    const item = links.properties.links.items.properties;
    expect(item.agentLaunch.enum).toEqual(['denied']);
    expect(item.agentLaunch.default).toBe('denied');
    expect(item.agentApply.enum).toEqual(['denied']);
    expect(item.agentApply.default).toBe('denied');
  });

  it('keeps a named target denied for agent launch and apply', () => {
    const added = addLink(privateOps, root, {
      linkId: 'lnk-1',
      targetPath: target,
      targetBaseSha: SHA,
      policy: { lane: 'synthetic', launch: 'allow', apply: 'allow', allowLocalAgentApply: true },
    });
    expect(AGENT_TARGET_ACCESS).toBe('denied');
    expect(added.agentLaunch).toBe('denied');
    expect(added.agentApply).toBe('denied');
    expect(added.targetPath).toBe(target);
    expect(added.policy).toEqual({ lane: 'synthetic' });

    const updated = updateLink(privateOps, 'lnk-1', { policy: { lane: 'synthetic', permitLaunch: 'allow', agentApply: 'allow' } });
    expect(updated.policy).toEqual({ lane: 'synthetic' });
    expect(updated.agentLaunch).toBe('denied');
    expect(updated.agentApply).toBe('denied');
    const saved = readFileSync(registryPath(privateOps), 'utf8');
    expect(saved).toContain('"agentLaunch": "denied"');
    expect(saved).toContain('"agentApply": "denied"');
    expect(saved).not.toContain('allow');

    const parsed = JSON.parse(saved);
    parsed.links[0].agentLaunch = 'allow';
    parsed.links[0].agentApply = 'allow';
    parsed.links[0].policy = { lane: 'synthetic', apply: 'allow', launch: true };
    writeFileSync(registryPath(privateOps), JSON.stringify(parsed));
    const resolved = resolveLink(privateOps, 'lnk-1');
    expect(resolved).toMatchObject({
      outcome: 'resolved',
      path: target,
      policy: { lane: 'synthetic' },
      agentLaunch: 'denied',
      agentApply: 'denied',
    });
    expect(loadRegistry(privateOps).links[0]).toMatchObject({ agentLaunch: 'denied', agentApply: 'denied', policy: { lane: 'synthetic' } });

    const src = readFileSync(new URL('../src/transfer/links.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/child_process|spawn\(|execFile|execSync|git apply/);
    const exported = Object.keys(links).filter(name => /^(launch|apply|spawn|exec)/i.test(name));
    expect(exported).toEqual([]);
    untouched();
  });

  it('leaves an unknown id and a mismatched root unwritten', () => {
    expect(() => updateLink(privateOps, 'lnk-1', { targetBaseSha: SHA2 })).toThrow(/Unknown link id/);
    expect(existsSync(registryPath(privateOps))).toBe(false);
    addLink(privateOps, root, { linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA });
    const bytes = readFileSync(registryPath(privateOps));
    expect(() => addLink(privateOps, join(tmp, 'other-root'), {
      linkId: 'lnk-2',
      targetPath: join(tmp, 'other-root', 'target-repo'),
      targetBaseSha: SHA,
    })).toThrow(/root does not match/);
    expect(() => disableLink(privateOps, 'missing')).toThrow(/Unknown link id/);
    expect(readFileSync(registryPath(privateOps))).toEqual(bytes);
    untouched();
  });

  it('refuses a corrupt registry without replacing it', () => {
    mkdirSync(join(privateOps, 'transfer'), { recursive: true });
    writeFileSync(registryPath(privateOps), '{');
    const bytes = readFileSync(registryPath(privateOps));
    expect(resolveLink(privateOps, 'lnk-1')).toEqual({ outcome: 'refuse', reason: 'invalid-registry' });
    expect(() => loadRegistry(privateOps)).toThrow(/invalid/);
    expect(readFileSync(registryPath(privateOps))).toEqual(bytes);
    untouched();
  });

  it('refuses to place the registry inside the target repo', () => {
    const insideOps = join(target, 'private-ops');
    expect(() => addLink(insideOps, root, { linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA })).toThrow(/inside a target/);
    expect(existsSync(insideOps)).toBe(false);
    expect(existsSync(join(target, '.vscode'))).toBe(false);
    untouched();
  });

  it('does not follow a registry symlink into the target', () => {
    const plant = join(target, '.git', 'plant.json');
    writeFileSync(plant, '{"root":"","links":[]}\n');
    before = targetState(target);
    mkdirSync(join(privateOps, 'transfer'), { recursive: true });
    symlinkSync(plant, registryPath(privateOps));
    expect(lstatSync(registryPath(privateOps)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(registryPath(privateOps))).toBe(plant);
    expect(() => addLink(privateOps, root, { linkId: 'lnk-1', targetPath: target, targetBaseSha: SHA })).toThrow(/inside a target/);
    expect(readFileSync(plant, 'utf8')).toBe('{"root":"","links":[]}\n');
    untouched();
  });
});
