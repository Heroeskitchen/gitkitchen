// GitHub CLI detection and setup steps. No editor imports, so it can be unit tested.
import * as path from 'path';

export type GhState = 'ready' | 'missing' | 'signedOut';

/** Places gh is installed to by the usual installers, for when the editor has not picked up the new PATH yet. */
export function ghCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    const w = path.win32; const out: string[] = [];
    for (const pf of [env.ProgramFiles, env['ProgramW6432'], env['ProgramFiles(x86)']]) if (pf) out.push(w.join(pf, 'GitHub CLI', 'gh.exe'));
    if (env.LOCALAPPDATA) out.push(w.join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'), w.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gh.exe'));
    if (home) out.push(w.join(home, 'scoop', 'shims', 'gh.exe'));
    out.push(w.join(env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'gh.exe'));
    return [...new Set(out)];
  }
  const p = path.posix;
  const out = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh', '/snap/bin/gh'];
  if (home) out.push(p.join(home, '.local', 'bin', 'gh'), p.join(home, 'bin', 'gh'));
  return platform === 'darwin' ? out.filter(x => !x.startsWith('/snap') && !x.startsWith('/home/linuxbrew')) : out;
}

/** Places Homebrew lives on macOS. */
export const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

/** True when the error means the gh program could not be started (not installed, or not on PATH). */
export function isGhMissing(e: unknown): boolean {
  const x = e as { code?: unknown; message?: unknown } | undefined;
  return x?.code === 'ENOENT' || /\bspawn\s+\S*gh(\.exe)?\s+ENOENT\b/i.test(String(x?.message ?? e ?? ''));
}

/** True when gh runs but is not signed in to GitHub. */
export function isGhSignedOut(e: unknown): boolean {
  const x = e as { message?: unknown; stderr?: unknown } | undefined;
  const s = `${x?.stderr ?? ''}\n${x?.message ?? e ?? ''}`;
  return /gh auth login|not logged in|authentication required|GH_TOKEN|HTTP 401|Bad credentials/i.test(s);
}

export function classifyGhError(e: unknown): GhState | undefined {
  return isGhMissing(e) ? 'missing' : isGhSignedOut(e) ? 'signedOut' : undefined;
}

/** Plain-language text for a gh failure, or undefined when it is some other error. */
export function friendlyGhError(e: unknown): string | undefined {
  const s = classifyGhError(e);
  if (s === 'missing') return 'The GitHub CLI is not installed, or the editor cannot find it yet. Run "Git Kitchen: Set Up GitHub CLI" to install it.';
  if (s === 'signedOut') return 'The GitHub CLI is not signed in to GitHub. Run "Git Kitchen: Set Up GitHub CLI" to sign in.';
  return undefined;
}

const LOGIN_ARGS = ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'];

export type SetupPlan =
  | { kind: 'terminal'; shell?: string; command: string; summary: string }
  | { kind: 'docs'; url: string; summary: string };

export const INSTALL_DOCS = 'https://github.com/cli/cli#installation';
export const LINUX_DOCS = 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md';

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The one terminal command that gets gh ready from where it is now.
 * Windows runs in PowerShell so the command is the same whatever the user's default shell is,
 * and it reloads PATH after winget so `gh auth login` works in the same window.
 */
export function setupPlan(o: { platform: NodeJS.Platform; state: GhState; gh?: string; brew?: string }): SetupPlan | undefined {
  if (o.state === 'ready') return undefined;
  const login = (gh: string, quote: (s: string) => string) => [quote(gh), ...LOGIN_ARGS].join(' ');
  if (o.platform === 'win32') {
    if (o.state === 'signedOut' && o.gh) return { kind: 'terminal', shell: 'powershell.exe', command: `& ${login(o.gh, psQuote)}`, summary: 'Signing in to GitHub' };
    const reload = "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
    return { kind: 'terminal', shell: 'powershell.exe', summary: 'Installing the GitHub CLI, then signing in',
      command: `winget install --id GitHub.cli --exact --source winget --accept-package-agreements --accept-source-agreements; ${reload}; gh ${LOGIN_ARGS.join(' ')}` };
  }
  if (o.state === 'signedOut' && o.gh) return { kind: 'terminal', command: login(o.gh, shQuote), summary: 'Signing in to GitHub' };
  if (o.platform === 'darwin') {
    if (!o.brew) return { kind: 'docs', url: INSTALL_DOCS, summary: 'Homebrew was not found. Install the GitHub CLI from the page that just opened, then click Check Again.' };
    const gh = o.brew.includes('/') ? path.posix.join(path.posix.dirname(o.brew), 'gh') : 'gh';
    return { kind: 'terminal', summary: 'Installing the GitHub CLI, then signing in',
      command: `${shQuote(o.brew)} install gh && ${shQuote(gh)} ${LOGIN_ARGS.join(' ')}` };
  }
  return { kind: 'docs', url: LINUX_DOCS, summary: 'Install the GitHub CLI for your Linux distribution from the page that just opened, then click Check Again.' };
}
