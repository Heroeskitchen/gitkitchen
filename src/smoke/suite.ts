import * as vscode from 'vscode';
import * as path from 'path';
import * as assert from 'assert';

export async function run() {
  const results: string[] = [];
  const check = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push(`PASS ${name}`); } catch (e: any) { results.push(`FAIL ${name}: ${e?.message ?? e}`); }
  };
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'gitkitchen')!;
  await ext.activate();
  const api = ext.exports ?? require(path.join(ext.extensionPath, 'out', 'extension.js'));
  const t = require(path.join(ext.extensionPath, 'out', 'extension.js'))._test;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;

  await check('all views live in the Source Control container', async () => {
    const c = ext.packageJSON.contributes;
    assert.strictEqual(c.viewsContainers, undefined);
    const ids = ['branches', 'remotes', 'stashes', 'worktrees', 'prs', 'history', 'dual', 'merged', 'todos'].map(v => `gitKitchen.${v}`);
    assert.deepStrictEqual(Object.keys(c.views), ['scm']);
    assert.deepStrictEqual(c.views.scm.map((v: any) => v.id).sort(), ids.sort());
    for (const id of ids) await vscode.commands.executeCommand(`${id}.focus`);
  });
  await check('all contributed commands registered', async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = (ext.packageJSON.contributes.commands as any[]).map(c => c.command).filter(c => !all.has(c));
    assert.deepStrictEqual(missing, []);
  });
  await check('branches tree lists main (current), feature/one (worktree), merged-one', async () => {
    const n = await t.loadBranches(); const names = n.map((x: any) => x.label);
    assert.deepStrictEqual(names.sort(), ['feature/one', 'main', 'merged-one']);
    assert.ok(n.find((x: any) => x.label === 'main').contextValue.includes('current'));
    assert.ok(n.find((x: any) => x.label === 'feature/one').contextValue.includes('worktree'));
  });
  await check('stashes tree shows stash and its file', async () => {
    const s = await t.loadStashes(); assert.strictEqual(s.length, 1); assert.match(String(s[0].label), /wip stash/);
    const f = await t.loadStashes(s[0]); assert.strictEqual(f[0].label, 'a.ts');
  });
  await check('worktrees tree shows main + feature/one', async () => {
    const w = await t.loadWorktrees(); assert.strictEqual(w.length, 2); assert.strictEqual(w[1].label, 'feature/one');
  });
  await check('remotes tree loads (none)', async () => { const r = await t.loadRemotes(); assert.ok(Array.isArray(r)); });
  await check('merged list has feature/one and merged-one', async () => {
    const m = (await t.loadMerged()).map((x: any) => x.label).sort(); assert.deepStrictEqual(m, ['feature/one', 'merged-one']);
  });
  await check('todos tree finds TODO and FIXME', async () => {
    const f = await t.loadTodos(); assert.strictEqual(f.length, 1); const hits = await t.loadTodos(f[0]); assert.strictEqual(hits.length, 2);
  });
  await check('blame + end-of-line decoration path', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'a.ts')); await vscode.window.showTextDocument(doc);
    const b = await t.blameFor(doc); assert.ok(b); assert.strictEqual(b.lines.length, 3); assert.strictEqual(b.lines[2].summary, 'Second commit');
  });
  await check('hover shows commit summary', async () => {
    const doc = vscode.window.activeTextEditor!.document;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(2, 0));
    const text = hovers.flatMap(h => h.contents.map((c: any) => c.value ?? String(c))).join('\n'); assert.match(text, /Second commit/); assert.match(text, /Open Changes/);
  });
  await check('toggle gutter blame runs', async () => { await vscode.commands.executeCommand('gitKitchen.blame.toggleFile'); await vscode.commands.executeCommand('gitKitchen.blame.toggleFile'); });
  await check('file history command populates view', async () => { await vscode.commands.executeCommand('gitKitchen.fileHistory'); });
  await check('commit diff opens a side-by-side diff', async () => {
    const sha = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    await vscode.commands.executeCommand('gitKitchen.openCommitDiff', { root, sha, file: 'a.ts' });
    await new Promise(r => setTimeout(r, 500));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab; assert.ok(tab && tab.input instanceof vscode.TabInputTextDiff, 'active tab is a diff');
    const left = await vscode.workspace.openTextDocument((tab!.input as vscode.TabInputTextDiff).original); assert.strictEqual(left.getText(), 'const a = 1;\n// TODO: tidy this\n');
  });
  await check('set/clear default workspace stores state', async () => {
    const fs = require('fs'); const wsf = path.join(root, 'x.code-workspace'); fs.writeFileSync(wsf, '{"folders":[{"path":"."}]}');
    await vscode.commands.executeCommand('gitKitchen.explorer.setDefaultWorkspace', vscode.Uri.file(wsf));
    await vscode.commands.executeCommand('gitKitchen.explorer.clearDefaultWorkspace', vscode.Uri.file(wsf)); fs.unlinkSync(wsf);
  });
  console.log('\n===== GIT KITCHEN SMOKE =====\n' + results.join('\n') + '\n========================');
  if (results.some(r => r.startsWith('FAIL'))) throw new Error('smoke failures');
  void api;
}
