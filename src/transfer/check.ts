// Retrieve a pinned package and check it against a linked target. Writes nothing to the target.
// No vscode imports, so this runs under Vitest.

import { createHash } from 'crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative, sep } from 'path';
import { Actor, mayCheckOrApply } from './identity';
import { gitBytes, gitText } from './exec';
import { resolveLink } from './links';
import { globDenied, validateProducerPackage } from './package';
import { PACKAGE_ROOT } from './produce';
import { scanCandidate } from './scrub';

export type CheckRefuse =
  | 'link' | 'package' | 'hash' | 'scrub' | 'target' | 'target-moved' | 'dirty' | 'path' | 'protected'
  | 'symlink' | 'case-collision' | 'eol' | 'binary' | 'preimage' | 'apply-check' | 'duplicate'
  | 'target-changed' | 'locked' | 'apply-failed' | 'missing' | 'input';

export interface PatchEntry {
  oldPath: string | null;
  newPath: string | null;
}

export interface Fingerprint {
  head: string;
  porcelain: string;
  hashes: Record<string, string | null>;
}

export interface CheckPass {
  outcome: 'PASS';
  patchSha256: string;
  linkId: string;
  targetRoot: string;
  targetHead: string;
  /** Every path the patch touches (old and new names). */
  paths: string[];
  fingerprint: Fingerprint;
  patch: Buffer;
}

export type CheckResult =
  | CheckPass
  | { outcome: 'refuse'; reason: CheckRefuse; detail?: string }
  | { outcome: 'blocked'; reason: 'actor' | 'disabled' | 'confirm' }
  | { outcome: 'cancel' }
  | { outcome: 'timeout' };

export interface CheckInput {
  privateOps: string;
  linkId: string;
  /** A local package directory: a retrieved copy or a sidecar drop. */
  packageDir: string;
  /** The hash from the review notice. The package must match it. */
  expectedPatchSha256: string;
  actor: Actor;
  signal?: AbortSignal;
}

/** Paths a package may never touch, whatever its manifest says. */
export const PROTECTED_GLOBS = ['.git/**', 'AGENTS.md', 'CLAUDE.md', '.cursor/**', '.claude/**', 'context-outbox/**'];

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');
const FULL_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;

// ---------- retrieve ----------

export type RetrieveResult =
  | { outcome: 'ok'; dir: string; cleanup: () => void }
  | { outcome: 'refuse'; reason: 'input' | 'missing' | 'hash' }
  | { outcome: 'timeout' };

export interface RetrieveInput {
  hkRepo: string;
  /** Full commit sha of the package, from the review notice. */
  commit: string;
  /** Package folder inside the commit, under transfer/patches/. */
  packagePath: string;
  patchSha256: string;
  attempts?: number;
  /** Injectable blob read. Defaults to git. Return null when the path is not in the commit. */
  readBlob?: (repo: string, commit: string, path: string) => Promise<Buffer | null>;
}

/** Read a package out of an HK commit with git show. The HK worktree, index and refs are not touched. */
export async function retrievePackage(input: RetrieveInput): Promise<RetrieveResult> {
  const sha = input.commit.toLowerCase();
  if (!FULL_SHA.test(sha) || !HASH.test(input.patchSha256)) return { outcome: 'refuse', reason: 'input' };
  const pkgPath = input.packagePath.replace(/\/+$/, '');
  if (!pkgPath.startsWith(PACKAGE_ROOT + '/') || !safeRel(pkgPath)) return { outcome: 'refuse', reason: 'input' };
  const read = input.readBlob ?? defaultReadBlob;
  const attempts = Math.max(1, input.attempts ?? 3);
  const files = new Map<string, Buffer>();
  for (const name of ['changes.patch', 'manifest.json', 'SHA256SUMS']) {
    let buf: Buffer | null | undefined;
    for (let i = 0; i < attempts; i++) {
      try { buf = await read(input.hkRepo, sha, `${pkgPath}/${name}`); break; } catch { buf = undefined; }
    }
    if (buf === undefined) return { outcome: 'timeout' };
    if (buf === null) return { outcome: 'refuse', reason: 'missing' };
    files.set(name, buf);
  }
  if (sha256(files.get('changes.patch')!) !== input.patchSha256) return { outcome: 'refuse', reason: 'hash' };
  const dir = mkdtempSync(join(tmpdir(), 'gk-retrieve-'));
  try {
    chmodSync(dir, 0o700);
    for (const [name, buf] of files) writeFileSync(join(dir, name), buf, { mode: 0o600 });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return { outcome: 'timeout' };
  }
  return { outcome: 'ok', dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function defaultReadBlob(repo: string, commit: string, path: string): Promise<Buffer | null> {
  try { await gitBytes(repo, ['rev-parse', '--verify', `${commit}^{commit}`]); } catch { return null; }
  let type: string;
  try { type = (await gitText(repo, ['cat-file', '-t', `${commit}:${path}`])).trim(); } catch { return null; }
  if (type !== 'blob') return null;
  return gitBytes(repo, ['cat-file', 'blob', `${commit}:${path}`]);
}

// ---------- patch reading ----------

export function parsePatchEntries(text: string): PatchEntry[] | undefined {
  const entries: PatchEntry[] = [];
  let cur: PatchEntry | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      if (rest.includes('"')) return undefined;
      const m = /^a\/(.+) b\/(.+)$/.exec(rest);
      if (!m) return undefined;
      cur = { oldPath: m[1], newPath: m[2] };
      if (m[1] !== m[2]) {
        const half = (rest.length - 5) / 2;
        if (Number.isInteger(half) && rest.slice(2, 2 + half) === rest.slice(5 + half)) cur = { oldPath: rest.slice(2, 2 + half), newPath: rest.slice(5 + half) };
      }
      entries.push(cur);
    } else if (cur) {
      // Metadata lines start with a letter. Hunk lines start with a space, +, - or a backslash.
      if (line.startsWith('rename from ')) cur.oldPath = line.slice(12);
      else if (line.startsWith('rename to ')) cur.newPath = line.slice(10);
      else if (line.startsWith('new file mode')) cur.oldPath = null;
      else if (line.startsWith('deleted file mode')) cur.newPath = null;
    }
  }
  return entries.length > 0 ? entries : undefined;
}

export function touchedPaths(entries: PatchEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) { if (e.oldPath) set.add(e.oldPath); if (e.newPath) set.add(e.newPath); }
  return [...set];
}

function safeRel(rel: string): boolean {
  if (rel === '' || rel.includes('\\') || rel.includes('\0') || rel.includes('\n')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every(p => p !== '' && p !== '.' && p !== '..');
}

// ---------- check ----------

export async function checkTransfer(input: CheckInput): Promise<CheckResult> {
  // The actor comes first. Nothing about a link or target is read for anyone else.
  if (!mayCheckOrApply(input.actor)) return { outcome: 'blocked', reason: 'actor' };
  const stop = () => (input.signal?.aborted ? ({ outcome: 'cancel' } as const) : undefined);
  const early = stop(); if (early) return early;

  const link = resolveLink(input.privateOps, input.linkId);
  if (link.outcome === 'blocked') return { outcome: 'blocked', reason: 'disabled' };
  if (link.outcome === 'refuse') return { outcome: 'refuse', reason: 'link', detail: link.reason };

  // Package: structure, hash against the notice, trace scan.
  const validated = validateProducerPackage(input.packageDir);
  if (validated.outcome !== 'PASS') return { outcome: 'refuse', reason: 'package', detail: validated.reason };
  if (validated.patchSha256 !== input.expectedPatchSha256) return { outcome: 'refuse', reason: 'hash' };
  if (validated.linkId !== input.linkId) return { outcome: 'refuse', reason: 'link', detail: 'package-link' };
  const scanned = scanCandidate(input.packageDir);
  if (scanned.outcome !== 'PASS') return { outcome: 'refuse', reason: 'scrub', detail: scanned.reason };
  const manifest = JSON.parse(readFileSync(join(input.packageDir, 'manifest.json'), 'utf8')) as { eol: 'lf' | 'crlf' | 'auto'; denyGlobs: string[]; targetBaseSha?: string; preimageBlobs?: Record<string, string> };
  const patch = readFileSync(join(input.packageDir, 'changes.patch'));
  const patchText = patch.toString('utf8');

  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(patchText)) return { outcome: 'refuse', reason: 'binary' };
  if (/^(?:new file mode|deleted file mode|old mode|new mode) 120000$|^index \S+ 120000$/m.test(patchText)) return { outcome: 'refuse', reason: 'symlink' };
  const entries = parsePatchEntries(patchText);
  if (!entries) return { outcome: 'refuse', reason: 'path' };
  const paths = touchedPaths(entries);
  const globs = [...PROTECTED_GLOBS, ...manifest.denyGlobs];
  const lower = new Map<string, string>();
  for (const p of paths) {
    if (!safeRel(p)) return { outcome: 'refuse', reason: 'path' };
    if (globDenied(globs, p)) return { outcome: 'refuse', reason: 'protected', detail: p };
    const key = p.toLowerCase();
    if (lower.has(key) && lower.get(key) !== p) return { outcome: 'refuse', reason: 'case-collision', detail: p };
    lower.set(key, p);
  }

  const mid = stop(); if (mid) return mid;

  // Target: a real repo root, at the pinned base, clean.
  const root = link.path;
  let head: string;
  try {
    const top = realpathSync((await gitText(root, ['rev-parse', '--show-toplevel'])).trim());
    if (top !== realpathSync(root)) return { outcome: 'refuse', reason: 'target' };
    head = (await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim().toLowerCase();
  } catch { return { outcome: 'refuse', reason: 'target' }; }
  let pinned: string;
  try { pinned = (await gitText(root, ['rev-parse', '--verify', `${link.targetBaseSha}^{commit}`])).trim().toLowerCase(); } catch { return { outcome: 'refuse', reason: 'target-moved' }; }
  if (pinned !== head) return { outcome: 'refuse', reason: 'target-moved' };
  if (manifest.targetBaseSha !== undefined && manifest.targetBaseSha.toLowerCase() !== head) return { outcome: 'refuse', reason: 'target-moved' };
  const porcelain = await gitText(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (porcelain !== '') return { outcome: 'refuse', reason: 'dirty' };

  // Containment and per-file facts.
  const tracked = (await gitText(root, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const trackedLower = new Map(tracked.map(f => [f.toLowerCase(), f]));
  for (const e of entries) {
    if (e.newPath && e.newPath !== e.oldPath) {
      const existing = trackedLower.get(e.newPath.toLowerCase());
      if (existing !== undefined && existing !== e.newPath) return { outcome: 'refuse', reason: 'case-collision', detail: e.newPath };
    }
  }
  const hashes: Record<string, string | null> = {};
  for (const p of paths) {
    const walk = containment(root, p);
    if (walk === 'symlink') return { outcome: 'refuse', reason: 'symlink', detail: p };
    if (walk === 'escape') return { outcome: 'refuse', reason: 'path', detail: p };
    const abs = join(root, ...p.split('/'));
    let st; try { st = lstatSync(abs); } catch { hashes[p] = null; continue; }
    if (!st.isFile()) return { outcome: 'refuse', reason: 'path', detail: p };
    const bytes = readFileSync(abs);
    hashes[p] = sha256(bytes);
    if (manifest.eol === 'lf' && bytes.includes(Buffer.from('\r\n'))) return { outcome: 'refuse', reason: 'eol', detail: p };
    if (manifest.eol === 'crlf' && /(^|[^\r])\n/.test(bytes.toString('latin1'))) return { outcome: 'refuse', reason: 'eol', detail: p };
  }
  if (manifest.preimageBlobs) {
    for (const [p, blob] of Object.entries(manifest.preimageBlobs)) {
      let actual = ''; try { actual = (await gitText(root, ['rev-parse', `HEAD:${p}`])).trim().toLowerCase(); } catch { /* missing */ }
      if (actual !== blob) return { outcome: 'refuse', reason: 'preimage', detail: p };
    }
  }

  const late = stop(); if (late) return late;
  try {
    await gitBytes(root, ['apply', '--check', '-p1', '--whitespace=nowarn', '-'], patch);
  } catch { return { outcome: 'refuse', reason: 'apply-check' }; }

  return {
    outcome: 'PASS',
    patchSha256: validated.patchSha256,
    linkId: input.linkId,
    targetRoot: root,
    targetHead: head,
    paths,
    fingerprint: { head, porcelain, hashes },
    patch,
  };
}

/** Recompute the facts a check recorded. Used right before a write. */
export async function takeFingerprint(root: string, paths: string[]): Promise<Fingerprint> {
  const head = (await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim().toLowerCase();
  const porcelain = await gitText(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const hashes: Record<string, string | null> = {};
  for (const p of paths) {
    try { hashes[p] = sha256(readFileSync(join(root, ...p.split('/')))); } catch { hashes[p] = null; }
  }
  return { head, porcelain, hashes };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  if (a.head !== b.head || a.porcelain !== b.porcelain) return false;
  const keys = new Set([...Object.keys(a.hashes), ...Object.keys(b.hashes)]);
  for (const k of keys) if (a.hashes[k] !== b.hashes[k]) return false;
  return true;
}

/** Walk every existing component under root. A symlink anywhere on the way is refused. */
function containment(root: string, rel: string): 'ok' | 'symlink' | 'escape' {
  const target = join(root, ...rel.split('/'));
  const back = relative(root, target);
  if (back.split(sep)[0] === '..' || isAbsolute(back)) return 'escape';
  let cur = root;
  for (const part of rel.split('/')) {
    cur = join(cur, part);
    let st; try { st = lstatSync(cur); } catch { return 'ok'; }
    if (st.isSymbolicLink()) return 'symlink';
  }
  return 'ok';
}
