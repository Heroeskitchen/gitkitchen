// Apply a checked package to a linked target as uncommitted work.
// No branch, no commit, no push, no index change. A failed or cancelled apply is rolled back
// to the bytes captured just before the write. No vscode imports, so this runs under Vitest.

import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, writeSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, sep } from 'path';
import { CheckInput, CheckPass, CheckRefuse, checkTransfer, sameFingerprint, takeFingerprint } from './check';
import { gitBytes } from './exec';
import { mayCheckOrApply } from './identity';

export interface ApplyInput extends CheckInput {
  /** Asks the person. Called once, after a PASS check, before any write. */
  confirm: (message: string) => Promise<boolean>;
  /** Allow the same package to be applied to the same link again. */
  rerun?: boolean;
  /** Scratch parent. Defaults to the OS temp folder. Never inside the target. */
  scratchRoot?: string;
  hooks?: {
    /** Runs after the write. A throw rolls the target back. */
    afterWrite?: () => void | Promise<void>;
  };
}

export interface Evidence {
  patchSha256: string;
  linkId: string;
  check: 'PASS';
  apply: 'success';
  pushed: false;
  /** Last folder name only. */
  target: string;
  files: number;
}

export type ApplyResult =
  | { outcome: 'success'; evidence: Evidence }
  | { outcome: 'refuse'; reason: CheckRefuse; detail?: string }
  | { outcome: 'blocked'; reason: 'actor' | 'disabled' | 'confirm' }
  | { outcome: 'cancel' }
  | { outcome: 'timeout' };

const LOCK_STALE_MS = 60 * 60 * 1000;

export function confirmMessage(pass: Pick<CheckPass, 'patchSha256' | 'targetRoot' | 'linkId' | 'paths'>): string {
  return [
    `Apply transfer patch ${pass.patchSha256} to ${pass.targetRoot}?`,
    `Link ${pass.linkId}. ${pass.paths.length} file(s) change in the working tree.`,
    'Nothing is committed or pushed.',
  ].join('\n');
}

export async function applyTransfer(input: ApplyInput): Promise<ApplyResult> {
  if (!mayCheckOrApply(input.actor)) return { outcome: 'blocked', reason: 'actor' };
  const checked = await checkTransfer(input);
  if (checked.outcome !== 'PASS') return checked;
  const pass = checked;

  const replay = replayKey(pass.linkId, pass.patchSha256);
  if (!input.rerun && readReplay(input.privateOps).has(replay)) return { outcome: 'refuse', reason: 'duplicate' };

  const message = confirmMessage(pass);
  if (!message.includes(pass.patchSha256) || !message.includes(pass.targetRoot)) return { outcome: 'blocked', reason: 'confirm' };
  let ok = false;
  try { ok = (await input.confirm(message)) === true; } catch { ok = false; }
  if (!ok) return { outcome: 'blocked', reason: 'confirm' };
  if (input.signal?.aborted) return { outcome: 'cancel' };

  const lock = acquireLock(input.privateOps, pass.linkId);
  if (!lock) return { outcome: 'refuse', reason: 'locked' };
  const scratch = mkdtempSync(join(input.scratchRoot ?? tmpdir(), 'gk-apply-'));
  try {
    chmodSync(scratch, 0o700);
    if (inside(pass.targetRoot, scratch)) return { outcome: 'refuse', reason: 'path', detail: 'scratch' };

    // The target must be exactly what the check saw.
    const now = await takeFingerprint(pass.targetRoot, pass.paths);
    if (!sameFingerprint(pass.fingerprint, now)) return { outcome: 'refuse', reason: 'target-changed' };

    const snap = snapshot(pass.targetRoot, pass.paths, scratch);
    if (!snap) return { outcome: 'refuse', reason: 'path' };
    if (input.signal?.aborted) return { outcome: 'cancel' };

    try {
      await gitBytes(pass.targetRoot, ['apply', '-p1', '--whitespace=nowarn', '-'], pass.patch);
      await input.hooks?.afterWrite?.();
      if (input.signal?.aborted) throw new Cancelled();
      const after = (await gitBytes(pass.targetRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim().toLowerCase();
      if (after !== pass.targetHead) throw new Error('HEAD moved');
    } catch (err) {
      restore(pass.targetRoot, snap);
      if (err instanceof Cancelled) return { outcome: 'cancel' };
      return { outcome: 'refuse', reason: 'apply-failed' };
    }

    addReplay(input.privateOps, replay);
    return {
      outcome: 'success',
      evidence: {
        patchSha256: pass.patchSha256, linkId: pass.linkId, check: 'PASS', apply: 'success', pushed: false,
        target: basename(pass.targetRoot), files: pass.paths.length,
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    lock.release();
  }
}

class Cancelled extends Error {}

/** Redacted summary the person can copy. No file bytes, no full paths. */
export function formatEvidence(e: Evidence): string {
  return [
    `Package ${e.patchSha256}`,
    `Link ${e.linkId} (${e.target})`,
    `Check ${e.check}. Apply ${e.apply}. ${e.files} file(s).`,
    'Not pushed. Not committed.',
  ].join('\n');
}

// ---------- snapshot and rollback ----------

interface SnapEntry { rel: string; saved: string | null; mode: number; }
interface Snapshot { entries: SnapEntry[]; missingDirs: string[]; }

function snapshot(root: string, paths: string[], scratch: string): Snapshot | undefined {
  const entries: SnapEntry[] = [];
  const missingDirs = new Set<string>();
  let n = 0;
  for (const rel of paths) {
    const abs = join(root, ...rel.split('/'));
    let parent = dirname(abs);
    const chain: string[] = [];
    while (!existsSync(parent) && parent !== root && parent.length > root.length) { chain.push(parent); parent = dirname(parent); }
    for (const d of chain) missingDirs.add(d);
    let st;
    try { st = lstatSync(abs); } catch { entries.push({ rel, saved: null, mode: 0 }); continue; }
    if (!st.isFile()) return undefined;
    const saved = join(scratch, String(n++));
    writeFileSync(saved, readFileSync(abs), { mode: 0o600 });
    entries.push({ rel, saved, mode: st.mode & 0o777 });
  }
  return { entries, missingDirs: [...missingDirs] };
}

function restore(root: string, snap: Snapshot): void {
  for (const e of snap.entries) {
    const abs = join(root, ...e.rel.split('/'));
    if (e.saved === null) { rmSync(abs, { force: true }); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.gk-restore-${process.pid}`;
    writeFileSync(tmp, readFileSync(e.saved), { mode: e.mode });
    chmodSync(tmp, e.mode);
    renameSync(tmp, abs);
  }
  // Remove directories the patch created, deepest first, only when empty.
  for (const d of snap.missingDirs.sort((a, b) => b.length - a.length)) {
    try { if (readdirSync(d).length === 0) rmdirSync(d); } catch { /* already gone */ }
  }
}

// ---------- lock ----------

function acquireLock(privateOps: string, linkId: string): { release: () => void } | undefined {
  const dir = join(privateOps, 'transfer', 'locks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${linkId}.lock`);
  const open = () => openSync(file, 'wx', 0o600);
  let fd: number;
  try { fd = open(); } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs < LOCK_STALE_MS) return undefined;
      rmSync(file, { force: true });
      fd = open();
    } catch { return undefined; }
  }
  try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
  return { release: () => rmSync(file, { force: true }) };
}

// ---------- replay record (private ops, never in the target) ----------

const replayKey = (linkId: string, sha: string) => `${linkId}:${sha}`;
const replayFile = (privateOps: string) => join(privateOps, 'transfer', 'applied.json');

function readReplay(privateOps: string): Set<string> {
  try {
    const v = JSON.parse(readFileSync(replayFile(privateOps), 'utf8'));
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

function addReplay(privateOps: string, key: string): void {
  const set = readReplay(privateOps); set.add(key);
  const file = replayFile(privateOps);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...set].sort(), null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel.split(sep)[0] !== '..' && !/^[A-Za-z]:|^\//.test(rel));
}
