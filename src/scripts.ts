// Pure script discovery helpers. No vscode imports so they run under Vitest.

export type ScriptKind = 'npm' | 'make' | 'shell' | 'powershell' | 'batch';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export interface ScriptEntry { name: string; kind: ScriptKind; /** shown after the name: the command, or the folder */ detail: string; /** path relative to the folder it was found in */ file: string; line?: number; /** the command line to send to the terminal */ command: string }

/** Pick the package manager from `packageManager` in package.json, then from lockfiles. */
export function detectPackageManager(pkgText: string | undefined, files: string[]): PackageManager {
  try {
    const pm = String(JSON.parse(pkgText ?? '{}').packageManager ?? '');
    const m = /^(npm|pnpm|yarn|bun)@/.exec(pm); if (m) return m[1] as PackageManager;
  } catch { /* fall through to lockfiles */ }
  const has = (f: string) => files.includes(f);
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

/** Scripts from package.json, in file order. Invalid JSON gives none. */
export function parsePackageScripts(text: string, pm: PackageManager): ScriptEntry[] {
  let scripts: unknown;
  try { scripts = JSON.parse(text).scripts; } catch { return []; }
  if (!scripts || typeof scripts !== 'object') return [];
  const lines = text.split('\n');
  return Object.entries(scripts as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([name, v]) => {
    const quoted = JSON.stringify(name);
    const i = lines.findIndex(l => l.includes(quoted) && /:\s*"/.test(l));
    return { name, kind: 'npm' as const, detail: v as string, file: 'package.json', line: i < 0 ? undefined : i + 1, command: `${pm} run ${shellWord(name)}` };
  });
}

/** Plain targets from a Makefile. Skips special targets, pattern rules, variables and recipe lines. */
export function parseMakeTargets(text: string): ScriptEntry[] {
  const seen = new Set<string>(); const out: ScriptEntry[] = [];
  text.split('\n').forEach((l, i) => {
    if (/^[\t ]/.test(l) || l.startsWith('#')) return;
    const m = /^([^:=#\s][^:=#]*?)\s*:(?![=:])/.exec(l); if (!m) return;
    for (const name of m[1].split(/\s+/)) {
      if (!name || name.startsWith('.') || /[%$()]/.test(name) || seen.has(name)) continue;
      seen.add(name); out.push({ name, kind: 'make', detail: 'make', file: 'Makefile', line: i + 1, command: `make ${shellWord(name)}` });
    }
  });
  return out;
}

/** What kind of runnable a file is, or undefined. Batch files only count on Windows. */
export function fileKind(name: string, platform: string): ScriptKind | undefined {
  const ext = /\.([^.]+)$/.exec(name.toLowerCase())?.[1];
  if (ext === 'sh') return 'shell';
  if (ext === 'ps1') return 'powershell';
  if ((ext === 'bat' || ext === 'cmd') && platform === 'win32') return 'batch';
  return undefined;
}

/** The terminal command for a script file. `rel` uses forward slashes and is relative to the terminal's cwd. */
export function fileCommand(kind: ScriptKind, rel: string, platform: string): string {
  const p = `"${rel.replace(/"/g, '')}"`;
  if (kind === 'shell') return `bash ${p}`;
  if (kind === 'powershell') return `${platform === 'win32' ? 'powershell' : 'pwsh'} -NoProfile -ExecutionPolicy Bypass -File ${p}`;
  return `.\\${rel.replace(/^\.\//, '').replace(/\//g, '\\')}`;
}

/** Quote a name for the shell only when it needs it. */
export function shellWord(s: string): string { return /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`; }
