import { execFile } from 'child_process';

export class CmdError extends Error { constructor(msg: string, public stderr: string) { super(msg); } }

export function run(cmd: string, args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      // Errors carry the subcommand and stderr only, not the full argument list.
      if (err) reject(new CmdError(`${cmd} ${args[0] ?? ''} failed: ${String(stderr || err.message).trim()}`, String(stderr)));
      else resolve(String(stdout));
    });
    if (input !== undefined) { p.stdin?.write(input); p.stdin?.end(); }
  });
}

export const git = (cwd: string, ...args: string[]) => run('git', args, cwd);
export const gh = (cwd: string, ...args: string[]) => run('gh', args, cwd);

export async function repoRoot(cwd: string): Promise<string | undefined> {
  try { return (await git(cwd, 'rev-parse', '--show-toplevel')).trim(); } catch { return undefined; }
}

/** Like run, but resolves with stdout even on a non-zero exit (for `git diff --no-index`, which exits 1 when files differ). */
export function runStdout(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}
