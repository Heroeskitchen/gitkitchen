import { describe, it, expect } from 'vitest';
import * as s from '../src/scripts';

describe('package manager', () => {
  it('prefers the packageManager field, then lockfiles, then npm', () => {
    expect(s.detectPackageManager('{"packageManager":"pnpm@9.1.0"}', ['yarn.lock'])).toBe('pnpm');
    expect(s.detectPackageManager('{}', ['yarn.lock', 'package.json'])).toBe('yarn');
    expect(s.detectPackageManager('{}', ['pnpm-lock.yaml'])).toBe('pnpm');
    expect(s.detectPackageManager('{}', ['bun.lockb'])).toBe('bun');
    expect(s.detectPackageManager('{}', ['package-lock.json'])).toBe('npm');
    expect(s.detectPackageManager('not json', [])).toBe('npm');
  });
});

describe('package.json scripts', () => {
  const text = '{\n  "name": "x",\n  "scripts": {\n    "build": "tsc -p .",\n    "test:unit": "vitest run"\n  }\n}\n';
  it('lists scripts with line and command', () => {
    const r = s.parsePackageScripts(text, 'pnpm');
    expect(r.map(x => x.name)).toEqual(['build', 'test:unit']);
    expect(r[0]).toMatchObject({ kind: 'npm', detail: 'tsc -p .', line: 4, command: 'pnpm run build' });
    expect(r[1].command).toBe('pnpm run test:unit');
  });
  it('tolerates bad or missing scripts', () => {
    expect(s.parsePackageScripts('nope', 'npm')).toEqual([]);
    expect(s.parsePackageScripts('{"name":"x"}', 'npm')).toEqual([]);
  });
});

describe('makefile', () => {
  it('finds plain targets only', () => {
    const t = '.PHONY: build\nCC := gcc\nbuild test: deps\n\tgcc x\n%.o: %.c\n\tcc\n# note: x\nclean:\n\trm -f x\nbuild:\n';
    const r = s.parseMakeTargets(t);
    expect(r.map(x => x.name)).toEqual(['build', 'test', 'clean']);
    expect(r[2]).toMatchObject({ line: 8, command: 'make clean' });
  });
});

describe('script files', () => {
  it('knows kinds by platform', () => {
    expect(s.fileKind('a.sh', 'linux')).toBe('shell');
    expect(s.fileKind('A.PS1', 'linux')).toBe('powershell');
    expect(s.fileKind('a.bat', 'linux')).toBeUndefined();
    expect(s.fileKind('a.cmd', 'win32')).toBe('batch');
    expect(s.fileKind('a.txt', 'win32')).toBeUndefined();
  });
  it('builds terminal commands', () => {
    expect(s.fileCommand('shell', './scripts/a b.sh', 'linux')).toBe('bash "./scripts/a b.sh"');
    expect(s.fileCommand('powershell', './upload-to-dev.ps1', 'win32')).toBe('powershell -NoProfile -ExecutionPolicy Bypass -File "./upload-to-dev.ps1"');
    expect(s.fileCommand('batch', './scripts/x.bat', 'win32')).toBe('.\\scripts\\x.bat');
  });
  it('quotes names only when needed', () => {
    expect(s.shellWord('test:unit')).toBe('test:unit');
    expect(s.shellWord('a b;c')).toBe('"a b;c"');
  });
});
