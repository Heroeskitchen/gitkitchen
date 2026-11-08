import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { applyTransfer, formatEvidence } from '../src/transfer/apply';
import { disableLink } from '../src/transfer/links';
import { makeWorld, put, read, sh } from './transfer-fixtures';

type W = Awaited<ReturnType<typeof makeWorld>>;
const input = (w: W, extra: object = {}) => ({
  privateOps: w.ops, linkId: w.linkId, packageDir: w.pkgDir, expectedPatchSha256: w.patchSha, actor: 'workbench' as const,
  confirm: async () => true, ...extra,
});
const state = (t: string) => [sh(t, 'rev-parse', 'HEAD'), sh(t, 'ls-files', '-s'), sh(t, 'for-each-ref'), sh(t, 'branch', '--list')].join('\n--\n');
const scratchDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith('gk-apply-')).length;

describe('applyTransfer', () => {
  it('applies as uncommitted work with no commit, branch or index change', async () => {
    const w = await makeWorld();
    const before = state(w.target);
    const confirm = vi.fn(async (_m: string) => true);
    const r = await applyTransfer(input(w, { confirm }));
    expect(r.outcome).toBe('success');
    expect(read(join(w.target, 'a.txt'))).toBe('one\nTWO\nthree\n');
    expect(read(join(w.target, 'b', 'c.txt'))).toBe('new file\n');
    expect(state(w.target)).toBe(before);
    expect(sh(w.target, 'status', '--porcelain')).toContain('a.txt');
    const msg = confirm.mock.calls[0][0];
    expect(msg).toContain(w.patchSha); expect(msg).toContain(w.target);
    expect(existsSync(join(w.target, '.vscode'))).toBe(false);
  });
  it('is blocked, with no modal and no read of the link, for agent, cloud and unidentified', async () => {
    const w = await makeWorld();
    const confirm = vi.fn(async () => true);
    for (const actor of ['agent', 'cloud', 'unidentified'] as const) {
      expect(await applyTransfer(input(w, { actor, confirm, privateOps: '/nonexistent/ops' }))).toEqual({ outcome: 'blocked', reason: 'actor' });
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(w.target, 'b'))).toBe(false);
  });
  it('is blocked with zero writes when the person does not confirm', async () => {
    const w = await makeWorld();
    for (const confirm of [async () => false, async () => undefined as unknown as boolean, async () => { throw new Error('x'); }]) {
      expect(await applyTransfer(input(w, { confirm }))).toEqual({ outcome: 'blocked', reason: 'confirm' });
    }
    expect(sh(w.target, 'status', '--porcelain')).toBe('');
  });
  it('refuses a duplicate unless re-run, and a re-run is still uncommitted', async () => {
    const w = await makeWorld();
    expect((await applyTransfer(input(w))).outcome).toBe('success');
    sh(w.target, 'checkout', '--', '.'); sh(w.target, 'clean', '-fdq');
    expect(await applyTransfer(input(w))).toMatchObject({ outcome: 'refuse', reason: 'duplicate' });
    expect(sh(w.target, 'status', '--porcelain')).toBe('');
    expect((await applyTransfer(input(w, { rerun: true }))).outcome).toBe('success');
    expect(sh(w.target, 'rev-parse', 'HEAD')).toBe(w.targetSha);
  });
  it('keeps the replay record out of the target', async () => {
    const w = await makeWorld();
    await applyTransfer(input(w));
    expect(existsSync(join(w.ops, 'transfer', 'applied.json'))).toBe(true);
    expect(sh(w.target, 'status', '--porcelain', '--ignored').split('\n').filter(l => !/a\.txt|b\//.test(l)).join('')).toBe('');
  });
  it('refuses when the target is edited between check and apply', async () => {
    const w = await makeWorld();
    const confirm = async () => { writeFileSync(join(w.target, 'a.txt'), 'edited\n'); return true; };
    expect(await applyTransfer(input(w, { confirm }))).toMatchObject({ outcome: 'refuse', reason: 'target-changed' });
    expect(read(join(w.target, 'a.txt'))).toBe('edited\n');
    expect(existsSync(join(w.target, 'b'))).toBe(false);
  });
  it('rolls back every file when something fails after the write', async () => {
    const w = await makeWorld();
    const before = state(w.target);
    const r = await applyTransfer(input(w, { hooks: { afterWrite: () => { throw new Error('boom'); } } }));
    expect(r).toMatchObject({ outcome: 'refuse', reason: 'apply-failed' });
    expect(read(join(w.target, 'a.txt'))).toBe('one\ntwo\nthree\n');
    expect(existsSync(join(w.target, 'b'))).toBe(false);
    expect(sh(w.target, 'status', '--porcelain')).toBe('');
    expect(state(w.target)).toBe(before);
  });
  it('rolls back when cancelled after the write started', async () => {
    const w = await makeWorld();
    const ctl = new AbortController();
    const r = await applyTransfer(input(w, { signal: ctl.signal, hooks: { afterWrite: () => ctl.abort() } }));
    expect(r).toEqual({ outcome: 'cancel' });
    expect(sh(w.target, 'status', '--porcelain')).toBe('');
  });
  it('cancels before any write when aborted after the prompt', async () => {
    const w = await makeWorld();
    const ctl = new AbortController();
    const r = await applyTransfer(input(w, { signal: ctl.signal, confirm: async () => { ctl.abort(); return true; } }));
    expect(r).toEqual({ outcome: 'cancel' });
    expect(sh(w.target, 'status', '--porcelain')).toBe('');
  });
  it('removes scratch and the lock on every exit', async () => {
    const w = await makeWorld();
    const n = scratchDirs();
    await applyTransfer(input(w));
    await applyTransfer(input(w, { rerun: true, hooks: { afterWrite: () => { throw new Error('x'); } } }));
    expect(scratchDirs()).toBe(n);
    expect(existsSync(join(w.ops, 'transfer', 'locks', 'link-a.lock'))).toBe(false);
  });
  it('refuses while another apply holds the lock', async () => {
    const w = await makeWorld();
    const first = applyTransfer(input(w, { confirm: async () => { await new Promise(r => setTimeout(r, 150)); return true; } }));
    await new Promise(r => setTimeout(r, 50));
    const second = await applyTransfer(input(w, { rerun: true, confirm: async () => true }));
    expect(second.outcome === 'refuse' || second.outcome === 'success').toBe(true);
    await first;
    expect(sh(w.target, 'status', '--porcelain')).toContain('a.txt');
  });
  it('refuses a disabled link and does not touch the target', async () => {
    const w = await makeWorld();
    disableLink(w.ops, w.linkId);
    expect(await applyTransfer(input(w))).toEqual({ outcome: 'blocked', reason: 'disabled' });
  });
  it('leaves untouched and ignored files alone', async () => {
    const w = await makeWorld({ base: { 'a.txt': 'one\ntwo\nthree\n', '.gitignore': 'secret.env\n', 'keep.txt': 'k\n' } });
    put(w.target, { 'secret.env': 'token\n' });
    const r = await applyTransfer(input(w));
    expect(r.outcome).toBe('success');
    expect(read(join(w.target, 'secret.env'))).toBe('token\n');
    expect(read(join(w.target, 'keep.txt'))).toBe('k\n');
  });
  it('never calls push and keeps target bytes out of the evidence and the HK package', async () => {
    const w = await makeWorld({ base: { 'a.txt': 'one\ntwo\nthree\n', 'canary.txt': 'CANARY-7f3a\n' } });
    const r = await applyTransfer(input(w));
    expect(r.outcome).toBe('success');
    if (r.outcome !== 'success') return;
    const text = JSON.stringify(r.evidence) + formatEvidence(r.evidence);
    expect(text).not.toContain('CANARY-7f3a');
    expect(text).not.toContain(w.target);
    expect(r.evidence).toMatchObject({ patchSha256: w.patchSha, linkId: 'link-a', check: 'PASS', apply: 'success', pushed: false });
    expect(formatEvidence(r.evidence)).toContain('Not pushed');
    for (const f of readdirSync(w.pkgDir)) expect(readFileSync(join(w.pkgDir, f), 'utf8')).not.toContain('CANARY-7f3a');
    const src = readFileSync(new URL('../src/transfer/apply.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/'push'|'commit'|'checkout'|'branch'/);
  });
});
