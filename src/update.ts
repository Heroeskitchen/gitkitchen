// Self-update helpers: where the editor's command line tool may live, and plain text for network failures.
// No editor imports, so it can be unit tested.
import * as path from 'path';

export const RELEASES_URL = 'https://github.com/Heroeskitchen/gitkitchen/releases/latest';

/** Every place the editor's command line tool (`cursor`, `code`, ...) is likely to be, most specific first. */
export function editorCliCandidates(o: { platform: NodeJS.Platform; appRoot: string; execPath: string; env: NodeJS.ProcessEnv }): string[] {
  const win = o.platform === 'win32'; const p = win ? path.win32 : path.posix;
  const names = ['cursor', 'code', 'code-insiders', 'codium', 'windsurf'].map(n => win ? n + '.cmd' : n);
  const dirs = [p.join(o.appRoot, 'bin'), p.join(o.appRoot, '..', '..', 'bin'), p.join(p.dirname(o.execPath), 'bin'), p.join(p.dirname(o.execPath), 'resources', 'app', 'bin')];
  // On macOS the app bundle keeps its tool under Contents/Resources/app/bin.
  if (o.platform === 'darwin') dirs.push(p.join(o.appRoot, '..', '..', 'Resources', 'app', 'bin'));
  const pathDirs = String(o.env.PATH ?? o.env.Path ?? '').split(win ? ';' : ':').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const all = [...dirs, ...pathDirs].flatMap(d => names.map(n => p.normalize(p.join(d, n))));
  return [...new Set(all)];
}

/** Plain text for a failed network call. Node's fetch only says "fetch failed"; the reason is in `cause`. */
export function friendlyNetworkError(e: unknown, what: string): string {
  const x = e as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | undefined;
  const msg = String(x?.message ?? e ?? '');
  const code = String(x?.cause?.code ?? ''); const detail = String(x?.cause?.message ?? '');
  if (!/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UNABLE_TO_|CERT_|SELF_SIGNED|certificate/i.test(`${msg} ${code} ${detail}`)) return msg;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(`${code} ${detail}`)) return `Could not ${what}: a proxy or antivirus is blocking the secure connection to GitHub (${code || detail}).`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET/.test(code)) return `Could not ${what}: GitHub could not be reached (${code}). Check your internet connection or proxy.`;
  return `Could not ${what}: GitHub could not be reached. Check your internet connection or proxy.`;
}
