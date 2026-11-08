import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { checkTransfer, retrievePackage } from '../src/transfer/check';
import { disableLink, updateLink } from '../src/transfer/links';
import { makeWorld, put, sh } from './transfer-fixtures';

const snap = (t: string) => [sh(t, 'rev-parse', 'HEAD'), sh(t, 'status', '--porcelain'), sh(t, 'ls-files', '-s'), sh(t, 'for-each-ref')].join('\n--\n');
const base = (w: Awaited<ReturnType<typeof makeWorld>>) => ({ privateOps: w.ops, linkId: w.linkId, packageDir: w.pkgDir, expectedPatchSha256: w.patchSha, actor: 'workbench' as const });

describe('checkTransfer', () => {
  it('passes and leaves the target untouched', async () => {
    const w = await makeWorld();
    const before = snap(w.target);
    const r = await checkTransfer(base(w));
    expect(r.outcome).toBe('PASS');
    expect(snap(w.target)).toBe(before);
    expect(existsSync(join(w.target, 'b'))).toBe(false);
  });
  it('blocks every actor but the workbench before reading the link', async () => {
    const w = await makeWorld();
    for (const actor of ['agent', 'cloud', 'unidentified'] as const) {
      expect(await checkTransfer({ ...base(w), actor, privateOps: '/nonexistent/ops' })).toEqual({ outcome: 'blocked', reason: 'actor' });
    }
  });
  it('blocks a disabled link and refuses an unknown one', async () => {
    const w = await makeWorld();
    expect(await checkTransfer({ ...base(w), linkId: 'nope' })).toMatchObject({ outcome: 'refuse', reason: 'link' });
    disableLink(w.ops, w.linkId);
    expect(await checkTransfer(base(w))).toEqual({ outcome: 'blocked', reason: 'disabled' });
  });
  it('refuses a hash that differs from the notice', async () => {
    const w = await makeWorld();
    expect(await checkTransfer({ ...base(w), expectedPatchSha256: 'a'.repeat(64) })).toMatchObject({ outcome: 'refuse', reason: 'hash' });
  });
  it('refuses a package for a different link', async () => {
    const w = await makeWorld();
    expect(await checkTransfer({ ...base(w), linkId: 'other' })).toMatchObject({ outcome: 'refuse', reason: 'link' });
  });
  it('refuses a dirty target', async () => {
    const w = await makeWorld();
    writeFileSync(join(w.target, 'stray.txt'), 'x');
    expect(await checkTransfer(base(w))).toMatchObject({ outcome: 'refuse', reason: 'dirty' });
  });
  it('refuses when the target moved even if the patch would apply', async () => {
    const w = await makeWorld();
    put(w.target, { 'other.txt': 'z\n' });
    sh(w.target, 'add', '-A'); sh(w.target, 'commit', '-qm', 'move');
    expect(await checkTransfer(base(w))).toMatchObject({ outcome: 'refuse', reason: 'target-moved' });
    updateLink(w.ops, w.linkId, { targetBaseSha: sh(w.target, 'rev-parse', 'HEAD') });
    expect((await checkTransfer(base(w))).outcome).toBe('PASS');
  });
  it('refuses when git apply --check fails', async () => {
    const w = await makeWorld();
    put(w.target, { 'a.txt': 'different\n' });
    sh(w.target, 'commit', '-qam', 'diverge');
    updateLink(w.ops, w.linkId, { targetBaseSha: sh(w.target, 'rev-parse', 'HEAD') });
    expect(await checkTransfer(base(w))).toMatchObject({ outcome: 'refuse', reason: 'apply-check' });
  });
  it('refuses a patch path that goes through a symlink', async () => {
    const w = await makeWorld({ base: { 'a.txt': 'x\n' }, tip: { 'a.txt': 'x\n', 'dir/f.txt': 'n\n' } });
    mkdirSync(join(w.base, 'outside'));
    symlinkSync(join(w.base, 'outside'), join(w.target, 'dir'));
    sh(w.target, 'add', '-A'); sh(w.target, 'commit', '-qm', 'link');
    updateLink(w.ops, w.linkId, { targetBaseSha: sh(w.target, 'rev-parse', 'HEAD') });
    expect(await checkTransfer(base(w))).toMatchObject({ outcome: 'refuse', reason: 'symlink' });
    expect(existsSync(join(w.base, 'outside', 'f.txt'))).toBe(false);
  });
  it('refuses a case-folded name collision with a tracked file', async () => {
    const w = await makeWorld({ base: { 'Readme.md': 'x\n' }, tip: { 'Readme.md': 'x\n', 'other.txt': 'n\n' } });
    // Target tracks Other.txt while the patch adds other.txt.
    put(w.target, { 'Other.txt': 'n\n' });
    sh(w.target, 'add', '-A'); sh(w.target, 'commit', '-qm', 'case');
    updateLink(w.ops, w.linkId, { targetBaseSha: sh(w.target, 'rev-parse', 'HEAD') });
    expect(await checkTransfer(base(w))).toMatchObject({ outcome: 'refuse', reason: 'case-collision' });
  });
  it('refuses an EOL mismatch', async () => {
    const w = await makeWorld();
    const { createHash } = await import('crypto');
    const m = JSON.parse(readFileSync(join(w.pkgDir, 'manifest.json'), 'utf8')); m.eol = 'crlf';
    const body = JSON.stringify(m, null, 2) + '\n';
    writeFileSync(join(w.pkgDir, 'manifest.json'), body);
    writeFileSync(join(w.pkgDir, 'SHA256SUMS'), `${w.patchSha}  changes.patch\n${createHash('sha256').update(body).digest('hex')}  manifest.json\n`);
    expect(await checkTransfer(base(w))).toMatchObject({ outcome: 'refuse', reason: 'eol' });
  });
  it('can be cancelled before any read of the target', async () => {
    const w = await makeWorld();
    const ctl = new AbortController(); ctl.abort();
    expect(await checkTransfer({ ...base(w), signal: ctl.signal })).toEqual({ outcome: 'cancel' });
  });
});

describe('retrievePackage', () => {
  const commitPackage = (w: Awaited<ReturnType<typeof makeWorld>>) => {
    sh(w.hk, 'add', '-A'); sh(w.hk, 'commit', '-qm', 'package');
    return sh(w.hk, 'rev-parse', 'HEAD');
  };
  it('reads a committed package by sha and hash without touching the HK worktree', async () => {
    const w = await makeWorld();
    const commit = commitPackage(w);
    // Remove the files from the worktree: retrieve must still work, and must not restore them.
    rmSync(w.pkgDir, { recursive: true });
    const status = sh(w.hk, 'status', '--porcelain');
    const r = await retrievePackage({ hkRepo: w.hk, commit, packagePath: 'transfer/patches/link-a/2026-11-08-sample', patchSha256: w.patchSha });
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') {
      expect((await checkTransfer({ ...base(w), packageDir: r.dir })).outcome).toBe('PASS');
      r.cleanup();
    }
    expect(sh(w.hk, 'status', '--porcelain')).toBe(status);
    expect(existsSync(w.pkgDir)).toBe(false);
  });
  it('refuses a missing path, a wrong hash, and input outside transfer/patches', async () => {
    const w = await makeWorld();
    const commit = commitPackage(w);
    const p = 'transfer/patches/link-a/2026-11-08-sample';
    expect(await retrievePackage({ hkRepo: w.hk, commit, packagePath: p + '-no', patchSha256: w.patchSha })).toEqual({ outcome: 'refuse', reason: 'missing' });
    expect(await retrievePackage({ hkRepo: w.hk, commit, packagePath: p, patchSha256: 'b'.repeat(64) })).toEqual({ outcome: 'refuse', reason: 'hash' });
    expect(await retrievePackage({ hkRepo: w.hk, commit, packagePath: 'src', patchSha256: w.patchSha })).toEqual({ outcome: 'refuse', reason: 'input' });
    expect(await retrievePackage({ hkRepo: w.hk, commit: 'HEAD', packagePath: p, patchSha256: w.patchSha })).toEqual({ outcome: 'refuse', reason: 'input' });
  });
  it('retries three times, then reports a timeout', async () => {
    let calls = 0;
    const r = await retrievePackage({ hkRepo: '/x', commit: 'a'.repeat(40), packagePath: 'transfer/patches/l/d', patchSha256: 'a'.repeat(64), readBlob: async () => { calls++; throw new Error('offline'); } });
    expect(r).toEqual({ outcome: 'timeout' });
    expect(calls).toBe(3);
  });
});
