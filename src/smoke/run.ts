import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { runTests } from '@vscode/test-electron';

async function main() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitkitchen-smoke-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', ...a], { cwd: repo });
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 'Smoke'); g('config', 'user.email', 'smoke@example.com');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\n// TODO: tidy this\n');
  g('add', '.'); g('commit', '-qm', 'First commit');
  fs.appendFileSync(path.join(repo, 'a.ts'), 'const b = 2; // FIXME later\n');
  g('commit', '-qam', 'Second commit');
  g('branch', 'feature/one'); g('branch', 'merged-one'); g('branch', 'feature/two');
  const dated = (days: number) => { const d = new Date(Date.now() - days * 86400000).toISOString(); return { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d }; };
  const gd = (days: number, ...a: string[]) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', ...a], { cwd: repo, env: dated(days) });
  g('switch', '-q', '-c', 'chore/aging', 'HEAD~1'); fs.writeFileSync(path.join(repo, 'aging.txt'), 'a\n'); g('add', '.'); gd(20, 'commit', '-qm', 'Aging work');
  g('switch', '-q', '-c', 'old/stale', 'main~1'); fs.writeFileSync(path.join(repo, 'stale.txt'), 's\n'); g('add', '.'); gd(90, 'commit', '-qm', 'Stale work');
  g('switch', '-q', 'main');
  fs.appendFileSync(path.join(repo, 'a.ts'), 'const c = 3;\n'); g('stash', 'push', '-m', 'wip stash');
  g('worktree', 'add', '-q', path.join(repo, 'worktrees', 'feature-one'), 'feature/one');
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, './suite'),
    launchArgs: [repo, '--disable-extensions', '--no-sandbox', '--disable-gpu', '--disable-workspace-trust'],
  });
}
main().catch(e => { console.error(e); process.exit(1); });
