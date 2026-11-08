// Produce an HK-only transfer package from two commits of a source repo.
// Output is written only under <repo>/transfer/patches/<opaque>/<date>-<slug>/.
// This module never opens a linked target and never commits.

import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { gitBytes, gitText } from './exec';
import { Eol, validateProducerPackage } from './package';
import { scanCandidate } from './scrub';

export const PACKAGE_ROOT = 'transfer/patches';

/** Paths that never travel in a package. Applied as deny globs in the manifest. */
export const DEFAULT_DENY_GLOBS = [
  'AGENTS.md', 'CLAUDE.md', '.cursor/**', '.claude/**', 'context-outbox/**', 'transfer/patches/**',
];

export interface ProduceOptions {
  sourceRepo: string;
  base: string;
  tip: string;
  /** Opaque link id. Also the first folder under transfer/patches/. */
  linkId: string;
  slug: string;
  /** yyyy-mm-dd. Defaults to today (UTC). */
  date?: string;
  denyGlobs?: string[];
  eol?: Eol;
  /** Must resolve inside <sourceRepo>/transfer/patches/. Defaults to the nested layout. */
  outDir?: string;
}

export type ProduceRefuse =
  | 'input' | 'revision' | 'zero-diff' | 'binary' | 'destination' | 'exists' | 'validate' | 'scrub' | 'error';

export type ProduceResult =
  | { outcome: 'PASS'; dir: string; relDir: string; patchSha256: string; sourceBaseSha: string; sourceTipSha: string }
  | { outcome: 'refuse'; reason: ProduceRefuse };

const LINK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

function refuse(reason: ProduceRefuse): ProduceResult {
  return { outcome: 'refuse', reason };
}

export async function produceTransferPackage(opts: ProduceOptions): Promise<ProduceResult> {
  if (!LINK_ID.test(opts.linkId) || !SLUG.test(opts.slug)) return refuse('input');
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  if (!DATE.test(date)) return refuse('input');
  const eol: Eol = opts.eol ?? 'auto';
  if (eol !== 'lf' && eol !== 'crlf' && eol !== 'auto') return refuse('input');
  const denyGlobs = opts.denyGlobs ?? DEFAULT_DENY_GLOBS;

  let repo: string;
  try { repo = realpathSync(opts.sourceRepo); } catch { return refuse('input'); }

  const relDir = `${PACKAGE_ROOT}/${opts.linkId}/${date}-${opts.slug}`;
  const dest = resolve(opts.outDir ?? join(repo, ...relDir.split('/')));
  const pkgRoot = join(repo, ...PACKAGE_ROOT.split('/'));
  if (!insideStrict(pkgRoot, dest)) return refuse('destination');
  if (existsSync(dest)) return refuse('exists');
  // The parent chain must not leave the repo through a symlink.
  const parent = nearestExisting(dirname(dest));
  if (!insideOrEqual(repo, safeReal(parent))) return refuse('destination');

  let baseSha: string;
  let tipSha: string;
  try {
    baseSha = (await gitText(repo, ['rev-parse', '--verify', `${opts.base}^{commit}`])).trim().toLowerCase();
    tipSha = (await gitText(repo, ['rev-parse', '--verify', `${opts.tip}^{commit}`])).trim().toLowerCase();
  } catch { return refuse('revision'); }
  if (baseSha === tipSha) return refuse('zero-diff');

  let patch: Buffer;
  try {
    patch = await gitBytes(repo, [
      '-c', 'core.quotepath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.renames=true',
      'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
      baseSha, tipSha, '--', '.', `:(exclude)${PACKAGE_ROOT}`,
    ]);
  } catch { return refuse('error'); }
  if (patch.length === 0) return refuse('zero-diff');
  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(patch.toString('latin1'))) return refuse('binary');

  const patchSha = sha256(patch);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    sourceBaseSha: baseSha,
    sourceTipSha: tipSha,
    patchSha256: patchSha,
    linkId: opts.linkId,
    stripComponents: 1,
    eol,
    denyGlobs,
    mode: 'apply',
  }, null, 2) + '\n');
  const sums = Buffer.from(`${patchSha}  changes.patch\n${sha256(manifest)}  manifest.json\n`);

  // Stage outside the repo, check there, then copy the three files in.
  const stage = mkdtempSync(join(tmpdir(), 'gk-produce-'));
  try {
    writeFileSync(join(stage, 'changes.patch'), patch);
    writeFileSync(join(stage, 'manifest.json'), manifest);
    writeFileSync(join(stage, 'SHA256SUMS'), sums);
    if (validateProducerPackage(stage).outcome !== 'PASS') return refuse('validate');
    if (scanCandidate(stage).outcome !== 'PASS') return refuse('scrub');
    mkdirSync(dest, { recursive: true });
    try {
      for (const name of ['changes.patch', 'manifest.json', 'SHA256SUMS']) copyFileSync(join(stage, name), join(dest, name));
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      throw err;
    }
  } catch { return refuse('error'); }
  finally { rmSync(stage, { recursive: true, force: true }); }

  return { outcome: 'PASS', dir: dest, relDir: relative(repo, dest).split(sep).join('/'), patchSha256: patchSha, sourceBaseSha: baseSha, sourceTipSha: tipSha };
}

function insideStrict(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
}
function insideOrEqual(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
}
function nearestExisting(p: string): string {
  let cur = p;
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) break; cur = up; }
  return cur;
}
function safeReal(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}
