import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { addLink } from '../src/transfer/links';
import { produceTransferPackage } from '../src/transfer/produce';

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd }).toString().trim();

export function initRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'core.autocrlf', 'false');
  put(dir, files);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  return sh(dir, 'rev-parse', 'HEAD');
}

export function put(dir: string, files: Record<string, string | null>) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    if (body === null) { execFileSync('rm', ['-f', abs]); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

export interface World {
  base: string;
  hk: string;
  target: string;
  ops: string;
  linkRoot: string;
  baseSha: string;
  targetSha: string;
  tipSha: string;
}

/** An HK source repo with a base and a tip commit, a separate target repo at the same content, and a link. */
export async function makeWorld(opts: { base?: Record<string, string>; tip?: Record<string, string | null>; linkId?: string; denyGlobs?: string[] } = {}): Promise<World & { pkgDir: string; patchSha: string; linkId: string }> {
  const base = mkdtempSync(join(tmpdir(), 'gk-world-'));
  const files = opts.base ?? { 'a.txt': 'one\ntwo\nthree\n' };
  const hk = join(base, 'hk');
  const baseSha = initRepo(hk, files);
  put(hk, opts.tip ?? { 'a.txt': 'one\nTWO\nthree\n', 'b/c.txt': 'new file\n' });
  sh(hk, 'add', '-A');
  sh(hk, 'commit', '-q', '-m', 'tip');
  const tipSha = sh(hk, 'rev-parse', 'HEAD');
  const linkRoot = join(base, 'clients');
  const target = join(linkRoot, 'target-repo');
  const targetSha = initRepo(target, files);
  const ops = join(base, 'ops');
  const linkId = opts.linkId ?? 'link-a';
  addLink(ops, linkRoot, { linkId, targetPath: target, targetBaseSha: targetSha });
  const produced = await produceTransferPackage({ sourceRepo: hk, base: baseSha, tip: tipSha, linkId, slug: 'sample', date: '2026-11-08', ...(opts.denyGlobs ? { denyGlobs: opts.denyGlobs } : {}) });
  if (produced.outcome !== 'PASS') throw new Error('fixture produce failed: ' + produced.reason);
  return { base, hk, target, ops, linkRoot, baseSha, targetSha, tipSha, pkgDir: produced.dir, patchSha: produced.patchSha256, linkId };
}

export const read = (p: string) => readFileSync(p, 'utf8');
