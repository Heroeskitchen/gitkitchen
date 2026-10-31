import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { runTests } from '@vscode/test-electron';

async function main() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitkitchen-smoke-'));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', ...a], { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\n// TODO: tidy this\n');
  g('add', '.'); g('commit', '-qm', 'First commit');
  fs.appendFileSync(path.join(repo, 'a.ts'), 'const b = 2; // FIXME later\n');
  g('commit', '-qam', 'Second commit');
  g('branch', 'feature/one'); g('branch', 'merged-one');
  fs.appendFileSync(path.join(repo, 'a.ts'), 'const c = 3;\n'); g('stash', 'push', '-m', 'wip stash');
  g('worktree', 'add', '-q', path.join(repo, 'worktrees', 'feature-one'), 'feature/one');
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, './suite'),
    launchArgs: [repo, '--disable-extensions', '--no-sandbox', '--disable-gpu', '--disable-workspace-trust'],
  });
}
main().catch(e => { console.error(e); process.exit(1); });
