import { createHash } from 'crypto';
import { lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { clientFolderLaunchOrApply, validateProducerPackage, validateReceiverPackage } from '../src/transfer/package';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const pin = (ch: string) => ch.repeat(40);

function unified(file: string, added: string): string {
  const quote = /[\s"]/.test(file);
  const a = quote ? `"a/${file}"` : `a/${file}`;
  const b = quote ? `"b/${file}"` : `b/${file}`;
  return [
    `diff --git ${a} ${b}`,
    'index 1111111..2222222 100644',
    `--- ${a}`,
    `+++ ${b}`,
    '@@ -1 +1 @@',
    '-old',
    `+${added}`,
    '',
  ].join('\n');
}

interface Fixture {
  root: string;
  dir: string;
  patchSha256: string;
  sourceBaseSha: string;
  sourceTipSha: string;
  targetBaseSha?: string;
  linkId: string;
}

function writeFixture(opts: {
  patch?: string;
  overlay?: Record<string, unknown>;
  remove?: string[];
  rawManifest?: string;
  omitSums?: boolean;
  omitManifest?: boolean;
  sums?: string;
  extra?: Record<string, string>;
  withTarget?: boolean;
  targetBaseSha?: string;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gitkitchen-pt1-'));
  roots.push(root);
  const dir = join(root, 'package');
  mkdirSync(dir);
  const patch = opts.patch ?? unified('src/note.txt', 'hello');
  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  const sourceBaseSha = pin('a');
  const sourceTipSha = pin('b');
  const linkId = 'link-opaque-1';
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    sourceBaseSha,
    sourceTipSha,
    patchSha256,
    linkId,
    stripComponents: 1,
    eol: 'lf',
    denyGlobs: [],
    mode: 'apply',
  };
  if (opts.withTarget || opts.targetBaseSha !== undefined) manifest.targetBaseSha = opts.targetBaseSha ?? pin('c');
  for (const [key, value] of Object.entries(opts.overlay ?? {})) manifest[key] = value;
  for (const key of opts.remove ?? []) delete manifest[key];
  writeFileSync(join(dir, 'changes.patch'), patch);
  if (!opts.omitManifest) {
    const body = opts.rawManifest ?? JSON.stringify(manifest, null, 2) + '\n';
    writeFileSync(join(dir, 'manifest.json'), body);
  }
  if (!opts.omitSums) writeFileSync(join(dir, 'SHA256SUMS'), opts.sums ?? `${patchSha256}  changes.patch\n`);
  for (const [name, body] of Object.entries(opts.extra ?? {})) writeFileSync(join(dir, name), body);
  return {
    root,
    dir,
    patchSha256,
    sourceBaseSha,
    sourceTipSha,
    targetBaseSha: typeof manifest.targetBaseSha === 'string' ? manifest.targetBaseSha : undefined,
    linkId: typeof manifest.linkId === 'string' ? manifest.linkId : linkId,
  };
}

function snapshotTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) { out.push(`link ${rel}`); continue; }
      if (st.isDirectory()) { out.push(`dir ${rel}`); walk(abs); continue; }
      const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
      out.push(`file ${rel} ${hash}`);
    }
  };
  walk(root);
  return out;
}

function expectUntouched(fx: Fixture, run: () => void) {
  const before = snapshotTree(fx.root);
  run();
  expect(snapshotTree(fx.root)).toEqual(before);
  expect(readdirSync(fx.root)).toEqual(['package']);
}

describe('producer stage', () => {
  it('passes a fixture without targetBaseSha and returns the recorded hash and source pins', () => {
    const fx = writeFixture();
    expectUntouched(fx, () => {
      expect(validateProducerPackage(fx.dir)).toEqual({
        outcome: 'PASS',
        patchSha256: fx.patchSha256,
        sourceBaseSha: fx.sourceBaseSha,
        sourceTipSha: fx.sourceTipSha,
        linkId: fx.linkId,
      });
    });
  });

  it('accepts a quoted path and a lowercase-normalized source pin', () => {
    const sourceBaseSha = pin('a').toUpperCase();
    const fx = writeFixture({ patch: unified('src/my note.txt', 'hello'), overlay: { sourceBaseSha } });
    expect(validateProducerPackage(fx.dir)).toMatchObject({
      outcome: 'PASS',
      patchSha256: fx.patchSha256,
      sourceBaseSha: sourceBaseSha.toLowerCase(),
      sourceTipSha: fx.sourceTipSha,
    });
  });

  it('refuses invalid schema', () => {
    expect(validateProducerPackage(writeFixture({ rawManifest: '{' }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'manifest.json' });
    expect(validateProducerPackage(writeFixture({ rawManifest: '[]' }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema' });
    expect(validateProducerPackage(writeFixture({ overlay: { schemaVersion: 2 } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'schemaVersion' });
    expect(validateProducerPackage(writeFixture({ overlay: { mode: 'copy' } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'mode' });
    expect(validateProducerPackage(writeFixture({ overlay: { linkId: 'https://example.invalid/target-repo' } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'linkId' });
    expect(validateProducerPackage(writeFixture({ overlay: { linkId: 'target-repo/secret' } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'linkId' });
    expect(validateProducerPackage(writeFixture({ overlay: { denyGlobs: '**' } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'denyGlobs' });
    expect(validateProducerPackage(writeFixture({ overlay: { denyGlobs: ['!keep'] } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'denyGlobs' });
    expect(validateProducerPackage(writeFixture({ overlay: { note: 'extra' } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'note' });
    expect(validateProducerPackage(writeFixture({ extra: { 'notes.txt': 'nope' } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema' });
    expect(validateProducerPackage(writeFixture({ omitManifest: true }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema' });
    const linked = writeFixture();
    symlinkSync('target-repo', join(linked.dir, 'alias'));
    expect(validateProducerPackage(linked.dir)).toMatchObject({ outcome: 'refuse', reason: 'schema' });
  });

  it('refuses a missing SHA256SUMS', () => {
    const fx = writeFixture({ omitSums: true });
    expectUntouched(fx, () => {
      expect(validateProducerPackage(fx.dir)).toEqual({ outcome: 'refuse', reason: 'sha256sums', field: 'SHA256SUMS' });
    });
  });

  it('refuses a hash mismatch', () => {
    const wrong = '0'.repeat(64);
    expect(validateProducerPackage(writeFixture({ overlay: { patchSha256: wrong } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'hash', field: 'patchSha256' });
    const fx = writeFixture();
    expect(validateProducerPackage(writeFixture({ sums: `${wrong}  changes.patch\n` }).dir)).toMatchObject({ outcome: 'refuse', reason: 'hash' });
    const manifestHash = createHash('sha256').update(readFileSync(join(fx.dir, 'manifest.json'))).digest('hex');
    const badManifest = writeFixture({ sums: `${fx.patchSha256}  changes.patch\n${'1'.repeat(64)}  manifest.json\n` });
    expect(validateProducerPackage(badManifest.dir)).toMatchObject({ outcome: 'refuse', reason: 'hash', field: 'manifest.json' });
    const goodManifest = writeFixture({ sums: `${fx.patchSha256}  changes.patch\n${manifestHash}  manifest.json\n` });
    expect(goodManifest.patchSha256).toBe(fx.patchSha256);
    expect(validateProducerPackage(goodManifest.dir).outcome).toBe('PASS');
  });

  it('refuses an empty patch', () => {
    expect(validateProducerPackage(writeFixture({ patch: '' }).dir)).toMatchObject({ outcome: 'refuse', reason: 'empty', field: 'changes.patch' });
    const headerOnly = [
      'diff --git a/src/note.txt b/src/note.txt',
      '--- a/src/note.txt',
      '+++ b/src/note.txt',
      '',
    ].join('\n');
    expect(validateProducerPackage(writeFixture({ patch: headerOnly }).dir)).toMatchObject({ outcome: 'refuse', reason: 'empty' });
  });

  it('refuses an invalid source pin', () => {
    expect(validateProducerPackage(writeFixture({ remove: ['sourceBaseSha'] }).dir)).toMatchObject({ outcome: 'refuse', reason: 'pin', field: 'sourceBaseSha' });
    expect(validateProducerPackage(writeFixture({ overlay: { sourceTipSha: 'abc123' } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'pin', field: 'sourceTipSha' });
    expect(validateProducerPackage(writeFixture({ overlay: { sourceBaseSha: 'g'.repeat(40) } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'pin', field: 'sourceBaseSha' });
  });

  it('refuses an invalid stripComponents', () => {
    for (const stripComponents of [0, 2, '1']) {
      expect(validateProducerPackage(writeFixture({ overlay: { stripComponents } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'strip', field: 'stripComponents' });
    }
  });

  it('refuses a path stored in the target pin', () => {
    const fx = writeFixture({ targetBaseSha: 'target-repo' });
    expectUntouched(fx, () => {
      expect(validateProducerPackage(fx.dir)).toMatchObject({ outcome: 'refuse', reason: 'target', field: 'targetBaseSha' });
    });
  });

  it('passes a new-file hunk', () => {
    const patch = [
      'diff --git a/src/note.txt b/src/note.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/note.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '',
    ].join('\n');
    expect(validateProducerPackage(writeFixture({ patch }).dir).outcome).toBe('PASS');
  });

  it('refuses an invalid eol', () => {
    for (const eol of ['CRLF', 'native', '']) {
      expect(validateProducerPackage(writeFixture({ overlay: { eol } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'eol', field: 'eol' });
    }
    expect(validateProducerPackage(writeFixture({ overlay: { eol: 'crlf' } }).dir).outcome).toBe('PASS');
    expect(validateProducerPackage(writeFixture({ overlay: { eol: 'auto' } }).dir).outcome).toBe('PASS');
  });

  it('writes nothing', () => {
    const pass = writeFixture();
    expectUntouched(pass, () => validateProducerPackage(pass.dir));
    const fail = writeFixture({ overlay: { eol: 'native' } });
    expectUntouched(fail, () => validateProducerPackage(fail.dir));
  });
});

describe('receiver stage', () => {
  it('refuses a missing targetBaseSha', () => {
    const fx = writeFixture();
    expectUntouched(fx, () => {
      expect(validateReceiverPackage(fx.dir)).toEqual({ outcome: 'refuse', reason: 'target', field: 'targetBaseSha' });
    });
  });

  it('refuses an invalid targetBaseSha', () => {
    for (const targetBaseSha of ['', 'abcd', 'target-repo', pin('c') + 'zz', 'https://example.invalid/target-repo']) {
      const fx = writeFixture({ targetBaseSha });
      expectUntouched(fx, () => {
        expect(validateReceiverPackage(fx.dir)).toMatchObject({ outcome: 'refuse', reason: 'target', field: 'targetBaseSha' });
      });
    }
  });

  it('passes a fixture that includes targetBaseSha', () => {
    const fx = writeFixture({ withTarget: true });
    expectUntouched(fx, () => {
      expect(validateReceiverPackage(fx.dir)).toEqual({
        outcome: 'PASS',
        patchSha256: fx.patchSha256,
        sourceBaseSha: fx.sourceBaseSha,
        sourceTipSha: fx.sourceTipSha,
        targetBaseSha: pin('c'),
        linkId: fx.linkId,
      });
    });
  });

  it('refuses an empty patch', () => {
    const fx = writeFixture({ withTarget: true, patch: '' });
    expect(validateReceiverPackage(fx.dir)).toMatchObject({ outcome: 'refuse', reason: 'empty', field: 'changes.patch' });
  });

  it('writes nothing', () => {
    const pass = writeFixture({ withTarget: true });
    expectUntouched(pass, () => validateReceiverPackage(pass.dir));
    const fail = writeFixture();
    expectUntouched(fail, () => validateReceiverPackage(fail.dir));
  });
});

describe('client folders', () => {
  it('denies client folders as launch or apply targets', () => {
    expect(clientFolderLaunchOrApply()).toBe('denied');
    expect(validateProducerPackage.length).toBe(1);
    expect(validateReceiverPackage.length).toBe(1);
    for (const field of ['clientFolder', 'targetPath', 'targetRepo', 'applyTarget', 'launchTarget']) {
      const fx = writeFixture({ withTarget: true, overlay: { [field]: 'target-repo' } });
      expectUntouched(fx, () => {
        expect(validateProducerPackage(fx.dir)).toEqual({ outcome: 'refuse', reason: 'client-folder', field });
        expect(validateReceiverPackage(fx.dir)).toEqual({ outcome: 'refuse', reason: 'client-folder', field });
      });
    }
  });

  it('does not turn a valid target pin into a folder action', () => {
    const fx = writeFixture({ withTarget: true });
    const result = validateReceiverPackage(fx.dir);
    expect(result.outcome).toBe('PASS');
    expect(result).not.toHaveProperty('targetPath');
    expect(result).not.toHaveProperty('clientFolder');
    expect(clientFolderLaunchOrApply()).toBe('denied');
    expect(readdirSync(fx.root)).toEqual(['package']);
  });
});

describe('deny and scrub', () => {
  it('refuses a path matched by denyGlobs', () => {
    const patch = unified('secrets/token.txt', 'nope');
    expect(validateProducerPackage(writeFixture({ patch, overlay: { denyGlobs: ['secrets/**'] } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'deny' });
    expect(validateProducerPackage(writeFixture({ patch: unified('keys/a.pem', 'nope'), overlay: { denyGlobs: ['*.pem'] } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'deny' });
    expect(validateProducerPackage(writeFixture({ overlay: { denyGlobs: ['src/*.txt'] } }).dir).outcome).toBe('refuse');
    expect(validateProducerPackage(writeFixture({ patch: unified('src/sub/note.txt', 'hello'), overlay: { denyGlobs: ['src/*.txt'] } }).dir).outcome).toBe('PASS');
  });

  it('refuses a .git path even when denyGlobs is empty', () => {
    expect(validateProducerPackage(writeFixture({ patch: unified('.git/config', 'nope') }).dir)).toMatchObject({ outcome: 'refuse', reason: 'deny' });
  });

  it('refuses an escaped path', () => {
    expect(validateProducerPackage(writeFixture({ patch: unified('../target-repo/note.txt', 'nope') }).dir)).toMatchObject({ outcome: 'refuse', reason: 'schema' });
  });

  it('refuses scrubbed added lines and keeps removed lines', () => {
    expect(validateProducerPackage(writeFixture({ patch: unified('src/note.txt', 'Heroeskitchen marker') }).dir)).toMatchObject({ outcome: 'refuse', reason: 'scrub' });
    const trailer = unified('src/note.txt', 'Co-authored-by: Sam <sam@example.com>');
    expect(validateProducerPackage(writeFixture({ patch: trailer }).dir)).toMatchObject({ outcome: 'refuse', reason: 'scrub' });
    const removedOnly = [
      'diff --git a/src/note.txt b/src/note.txt',
      '--- a/src/note.txt',
      '+++ b/src/note.txt',
      '@@ -1 +1 @@',
      '-Heroeskitchen marker',
      '+hello',
      '',
    ].join('\n');
    expect(validateProducerPackage(writeFixture({ patch: removedOnly }).dir).outcome).toBe('PASS');
    expect(validateProducerPackage(writeFixture({ overlay: { linkId: 'Heroeskitchen' } }).dir)).toMatchObject({ outcome: 'refuse', reason: 'scrub', field: 'linkId' });
  });

  it('checks optional preimage blob hashes against touched paths', () => {
    const blob = pin('d');
    const ok = writeFixture({ overlay: { preimageBlobs: { 'src/note.txt': blob } } });
    expect(validateProducerPackage(ok.dir)).toMatchObject({ outcome: 'PASS', patchSha256: ok.patchSha256 });
    const missing = writeFixture({ overlay: { preimageBlobs: { 'src/other.txt': blob } } });
    expect(validateProducerPackage(missing.dir)).toMatchObject({ outcome: 'refuse', reason: 'schema', field: 'preimageBlobs' });
  });
});

describe('module surface', () => {
  it('only reads the package directory', () => {
    const src = readFileSync(new URL('../src/transfer/package.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/writeFile|appendFile|mkdir|createWriteStream|rmSync|unlinkSync|renameSync|copyFile|child_process|execFile|spawn/);
    expect(src).not.toMatch(/git apply/);
  });
});
