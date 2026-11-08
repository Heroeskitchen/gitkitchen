// Small git runner for the transfer modules. No vscode imports, so it runs under Vitest.
import { execFile } from 'child_process';

export class GitError extends Error {
  constructor(msg: string, public stderr: string) { super(msg); }
}

/** Run git and return raw stdout bytes. Rejects with GitError on a non-zero exit. */
export function gitBytes(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args[0] ?? ''} failed`, String(stderr).trim()));
      else resolve(stdout as Buffer);
    });
    if (input !== undefined) { p.stdin?.on('error', () => undefined); p.stdin?.end(input); }
  });
}

export async function gitText(cwd: string, args: string[], input?: Buffer): Promise<string> {
  return (await gitBytes(cwd, args, input)).toString('utf8');
}
