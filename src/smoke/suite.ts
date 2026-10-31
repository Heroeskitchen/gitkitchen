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
    const ids = ['commits', 'branches', 'remotes', 'stashes', 'worktrees', 'prs', 'history', 'dual', 'merged', 'todos'].map(v => `gitKitchen.${v}`);
    assert.deepStrictEqual(Object.keys(c.views), ['scm']);
    assert.deepStrictEqual(c.views.scm.map((v: any) => v.id).sort(), ids.sort());
    for (const id of ids) await vscode.commands.executeCommand(`${id}.focus`);
  });
  await check('all contributed commands registered', async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = (ext.packageJSON.contributes.commands as any[]).map(c => c.command).filter(c => !all.has(c));
    assert.deepStrictEqual(missing, []);
  });
  await check('branches tree groups by prefix with current first', async () => {
    const n = await t.loadBranches(); assert.deepStrictEqual(n.map((x: any) => x.label), ['main', 'feature', 'merged-one', 'chore', 'old']);
    assert.ok(n[0].contextValue.includes('current')); assert.strictEqual(n[1].contextValue, 'branchFolder');
    const c = vscode.workspace.getConfiguration('gitKitchen'); await c.update('sortBy', 'name', vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual((await t.loadBranches()).map((x: any) => x.label), ['main', 'chore', 'feature', 'old', 'merged-one']);
    await c.update('sortBy', undefined, vscode.ConfigurationTarget.Global);
    const kids = await t.loadBranches(n[1]); assert.deepStrictEqual(kids.map((x: any) => x.label), ['one', 'two']);
    assert.ok(kids[0].contextValue.includes('worktree')); assert.match(String(kids[0].description), /^no upstream • (.*ago|just now) • worktree$/);
  });
  await check('branches list layout setting flattens', async () => {
    const c = vscode.workspace.getConfiguration('gitKitchen'); await c.update('branches.layout', 'list', vscode.ConfigurationTarget.Global);
    const n = await t.loadBranches(); assert.deepStrictEqual(n.map((x: any) => x.label).sort(), ['chore/aging', 'feature/one', 'feature/two', 'main', 'merged-one', 'old/stale']);
    await c.update('branches.layout', undefined, vscode.ConfigurationTarget.Global);
  });
  await check('commits view lists commits and their files', async () => {
    const cs = await t.loadCommits(); assert.deepStrictEqual(cs.map((x: any) => x.label), ['Second commit', 'First commit']);
    const files = await t.commitFiles(root, cs[1].data.sha); assert.strictEqual(files[0].label, 'a.ts'); assert.strictEqual(files[0].command.command, 'gitKitchen.diffFile');
    await vscode.commands.executeCommand(files[0].command.command, ...files[0].command.arguments);
  });
  await check('stashes tree shows stash and its file', async () => {
    const s = await t.loadStashes(); assert.strictEqual(s.length, 1); assert.match(String(s[0].label), /wip stash/);
    const f = await t.loadStashes(s[0]); assert.strictEqual(f[0].label, 'a.ts');
  });
  await check('worktrees tree shows main + feature/one', async () => {
    const w = await t.loadWorktrees(); assert.strictEqual(w.length, 2); assert.strictEqual(w[1].label, 'feature/one');
  });
  await check('remotes tree loads (none)', async () => { const r = await t.loadRemotes(); assert.ok(Array.isArray(r)); });
  await check('merged list has every merged branch', async () => {
    const m = (await t.loadMerged()).map((x: any) => x.label).sort(); assert.deepStrictEqual(m, ['feature/one', 'feature/two', 'merged-one']);
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
  await check('hover includes the line diff hunk from its commit', async () => {
    const doc = vscode.window.activeTextEditor!.document;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(2, 0));
    const text = hovers.flatMap(h => h.contents.map((c: any) => c.value ?? String(c))).join('\n');
    assert.match(text, /```diff/); assert.match(text, /\+const b = 2; \/\/ FIXME later/);
  });
  await check('status bar shows author and time, click opens commit', async () => {
    const ed = vscode.window.activeTextEditor!; ed.selection = new vscode.Selection(2, 0, 2, 0); await t.updateBlame();
    const s = t.status(); assert.match(s.text, /^\$\(git-commit\) Smoke, /); assert.strictEqual(s.command?.command, 'gitKitchen.openCommitDiff');
  });
  await check('same-commit lines highlighted for cursor and hover', async () => {
    const ed = vscode.window.activeTextEditor!; ed.selection = new vscode.Selection(0, 0, 0, 0);
    await new Promise(r => setTimeout(r, 400)); await t.updateBlame(); await new Promise(r => setTimeout(r, 100));
    assert.deepStrictEqual(t.same(), [2]);
    await vscode.commands.executeCommand('vscode.executeHoverProvider', ed.document.uri, new vscode.Position(2, 0));
    assert.deepStrictEqual(t.same(), []);
    await vscode.commands.executeCommand('vscode.executeHoverProvider', ed.document.uri, new vscode.Position(1, 0));
    assert.deepStrictEqual(t.same(), [1]);
  });
  await check('gutter change markers vs HEAD by default (unsaved edits)', async () => {
    const ed = vscode.window.activeTextEditor!;
    await ed.edit(e => { e.replace(new vscode.Range(0, 0, 0, 12), 'const a = 10;'); e.insert(new vscode.Position(3, 0), 'const d = 4;\n'); e.delete(new vscode.Range(1, 0, 2, 0)); });
    await t.updateBlame();
    assert.deepStrictEqual(t.changes(), { added: [3], modified: [1], deletedAfter: [1] });
    await vscode.commands.executeCommand('workbench.action.files.revert'); await t.updateBlame();
    assert.deepStrictEqual(t.changes(), { added: [], modified: [], deletedAfter: [] });
  });
  await check('settings turn status bar, same-commit and change markers off', async () => {
    const c = vscode.workspace.getConfiguration('gitKitchen');
    for (const k of ['statusBar.enabled', 'blame.highlightSameCommit', 'changes.gutter', 'blame.changesHover']) await c.update(k, false, vscode.ConfigurationTarget.Global);
    const ed = vscode.window.activeTextEditor!; ed.selection = new vscode.Selection(0, 0, 0, 0); await t.updateBlame();
    assert.deepStrictEqual(t.same(), []); assert.strictEqual(t.changes(), undefined);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', ed.document.uri, new vscode.Position(2, 0));
    assert.doesNotMatch(hovers.flatMap(h => h.contents.map((x: any) => x.value ?? String(x))).join('\n'), /```diff/);
    for (const k of ['statusBar.enabled', 'blame.highlightSameCommit', 'changes.gutter', 'blame.changesHover']) await c.update(k, undefined, vscode.ConfigurationTarget.Global);
  });
  await check('toggle gutter blame runs', async () => { await vscode.commands.executeCommand('gitKitchen.blame.toggleFile'); await vscode.commands.executeCommand('gitKitchen.blame.toggleFile'); });
  await check('current-line highlight + annotations toggle', async () => {
    await vscode.commands.executeCommand('gitKitchen.annotations.heatmap'); assert.strictEqual(t.getAnnot(), 'heatmap');
    await vscode.commands.executeCommand('gitKitchen.blame.toggleFile'); assert.strictEqual(t.getAnnot(), 'blame');
    await vscode.commands.executeCommand('gitKitchen.blame.toggleFile'); assert.strictEqual(t.getAnnot(), 'none');
  });
  await check('code lens shows last author and author count', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'a.ts'));
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
    const titles = lenses.map(l => l.command?.title ?? ''); assert.ok(titles.some(x => /^Smoke, /.test(x)), titles.join('|')); assert.ok(titles.includes('1 author (Smoke)'), titles.join('|'));
  });
  await check('previous / next revision stepping', async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(root, 'a.ts')));
    await vscode.commands.executeCommand('gitKitchen.rev.prev'); await new Promise(r => setTimeout(r, 400));
    let nt = t.navTarget(); const shas = require('child_process').execFileSync('git', ['log', '--format=%H'], { cwd: root }).toString().trim().split('\n');
    assert.strictEqual(nt.sha, shas[0]);
    await vscode.commands.executeCommand('gitKitchen.rev.prev'); await new Promise(r => setTimeout(r, 400));
    nt = t.navTarget(); assert.strictEqual(nt.sha, shas[1]);
    await vscode.commands.executeCommand('gitKitchen.rev.next'); await new Promise(r => setTimeout(r, 400));
    nt = t.navTarget(); assert.strictEqual(nt.sha, shas[0]);
  });
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
  const cp = require('child_process'); const fs = require('fs'); const os = require('os');
  const sh = (cwd: string, ...a: string[]) => cp.execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', ...a], { cwd }).toString();
  await check('branch icons: active git-branch in green, freshness tints, tooltip numbers', async () => {
    const n = await t.loadBranches();
    assert.strictEqual(n[0].iconPath.id, 'git-branch'); assert.match(String(n[0].description), /^no upstream • /); assert.strictEqual(n[0].iconPath.color.id, 'gitKitchen.activeBranchForeground');
    const aging = (await t.loadBranches(n.find((x: any) => x.label === 'chore')))[0];
    assert.strictEqual(aging.iconPath.color.id, 'gitKitchen.branchAgingForeground'); assert.match(aging.tooltip, /1 behind · last commit 20d ago · aging/);
    const stale = (await t.loadBranches(n.find((x: any) => x.label === 'old')))[0];
    assert.strictEqual(stale.iconPath.color.id, 'gitKitchen.branchStaleForeground'); assert.match(stale.tooltip, /last commit 90d ago · stale/);
    const two = (await t.loadBranches(n.find((x: any) => x.label === 'feature')))[1];
    assert.strictEqual(two.iconPath.color.id, 'gitKitchen.branchFreshForeground'); assert.match(two.tooltip, /0 behind · last commit 0d ago · fresh/);
    const one = (await t.loadBranches(n.find((x: any) => x.label === 'feature')))[0]; assert.strictEqual(one.iconPath.id, 'git-merge'); assert.match(one.tooltip, /Merged into main/);
    assert.strictEqual(aging.iconPath.id, 'git-branch');
  });
  await check('manifest: icons, title-bar cap, danger group, colors, no activity bar', async () => {
    const pj = ext.packageJSON.contributes; const nav: Record<string, number> = {};
    for (const e of pj.menus['view/title']) if (String(e.group).startsWith('navigation')) nav[e.when] = (nav[e.when] ?? 0) + 1;
    assert.ok(Object.values(nav).every(v => v <= 3), JSON.stringify(nav));
    assert.ok(!pj.menus['view/item/context'].some((e: any) => /delete|remove|drop|abort/.test(e.command) && e.command !== 'gitKitchen.stash.drop' && String(e.group).startsWith('inline')));
    assert.ok(pj.menus['view/item/context'].filter((e: any) => /\.(delete|remove|drop)$|operation\.abort/.test(e.command) && !String(e.group).startsWith('inline')).every((e: any) => e.group.startsWith('9_danger')));
    assert.ok(!pj.viewsContainers); assert.ok(pj.colors.some((c: any) => c.id === 'gitKitchen.branchStaleForeground' && c.defaults.dark === 'gitDecoration.ignoredResourceForeground'));
    assert.strictEqual(pj.views.scm.find((v: any) => v.id === 'gitKitchen.dual').when, 'gitKitchen.multiRemote');
    assert.ok(!JSON.stringify(pj).includes('git-branch-create'));
    const inl = pj.menus['view/item/context'].filter((e: any) => e.group.startsWith('inline') && e.when.includes('gitKitchen.branches'));
    const ids = inl.map((e: any) => e.command.replace('gitKitchen.', ''));
    assert.deepStrictEqual(ids.sort(), ['branch.compareHead', 'branch.pull', 'branch.push', 'branch.switch', 'pr.create', 'pr.open'].sort());
    const ctxKey = (cv: string) => inl.filter((e: any) => { const m = /viewItem =~ \/(.*?)\/(?:\)|$| )/g; let ok = true; let x; while ((x = m.exec(e.when))) if (!new RegExp(x[1]).test(cv)) ok = false; return ok; }).length;
    for (const cv of ['branch.current.noWorktree.tracked', 'branch.current.noWorktree.tracked.hasPr', 'branch.noWorktree', 'branch.noWorktree.hasPr', 'branch.worktree.tracked']) assert.ok(ctxKey(cv) <= 3, cv + ' ' + ctxKey(cv));
    assert.strictEqual(ctxKey('branch.current.noWorktree.tracked'), 3); assert.strictEqual(ctxKey('branch.noWorktree'), 3);
  });
  await check('one remote: Compare Remotes hidden and empty', async () => {
    await t.updateRemoteContext(); assert.deepStrictEqual(await t.loadDual(), []); assert.strictEqual(t.dualTitle(), 'Compare Remotes');
  });
  await check('two remotes: auto pair, header, swap', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-remotes-'));
    for (const r of ['origin', 'client-dpi']) { sh(base, 'init', '-q', '--bare', r); sh(root, 'remote', 'add', r, path.join(base, r)); sh(root, 'push', '-q', r, 'main'); }
    sh(root, 'fetch', '-q', '--all'); sh(root, 'branch', '-q', '-f', 'origin-only', 'main'); sh(root, 'push', '-q', 'origin', 'origin-only:main');
    await t.updateRemoteContext(); assert.strictEqual(t.dualTitle(), 'origin → client-dpi');
    let rows = await t.loadDual(); assert.match(String(rows[0].label), /Everything on origin\/main is on client-dpi/);
    sh(root, 'switch', '-q', 'origin-only'); fs.writeFileSync(path.join(root, 'o.txt'), 'o\n'); sh(root, 'add', 'o.txt'); sh(root, 'commit', '-qm', 'Only on origin'); sh(root, 'push', '-q', 'origin', 'origin-only:main'); sh(root, 'switch', '-q', 'main'); sh(root, 'fetch', '-q', '--all');
    rows = await t.loadDual(); assert.deepStrictEqual(rows.map((x: any) => x.label), ['Only on origin']);
    assert.strictEqual(t.dualDescription(), 'On origin, not on client-dpi');
    await vscode.commands.executeCommand('gitKitchen.dual.swap'); assert.strictEqual(t.dualTitle(), 'client-dpi → origin');
    rows = await t.loadDual(); assert.match(String(rows[0].label), /Everything on client-dpi\/main is on origin/);
    const saved = vscode.workspace.getConfiguration('gitKitchen', vscode.Uri.file(root)).inspect('dualRemote.source');
    assert.strictEqual(saved?.workspaceFolderValue ?? saved?.workspaceValue, 'client-dpi');
    await vscode.commands.executeCommand('gitKitchen.dual.swap'); assert.strictEqual(t.dualTitle(), 'origin → client-dpi');
    for (const r of ['origin', 'client-dpi']) sh(root, 'remote', 'remove', r);
    const c = vscode.workspace.getConfiguration('gitKitchen', vscode.Uri.file(root));
    for (const k of ['dualRemote.source', 'dualRemote.target']) { await c.update(k, undefined, vscode.ConfigurationTarget.WorkspaceFolder); }
    await t.updateRemoteContext(); assert.strictEqual(t.dualTitle(), 'Compare Remotes');
  });
  await check('merge in progress: row, conflicts, continue', async () => {
    sh(root, 'switch', '-q', '-c', 'conflict/x', 'main'); fs.writeFileSync(path.join(root, 'c.txt'), 'theirs\n'); sh(root, 'add', 'c.txt'); sh(root, 'commit', '-qm', 'Theirs');
    sh(root, 'switch', '-q', 'main'); fs.writeFileSync(path.join(root, 'c.txt'), 'ours\n'); sh(root, 'add', 'c.txt'); sh(root, 'commit', '-qm', 'Ours');
    try { sh(root, 'merge', 'conflict/x'); } catch { /* conflict expected */ }
    assert.strictEqual((await t.operationState(root)).kind, 'merge');
    let n = await t.loadCommits(); assert.strictEqual(n[0].contextValue, 'operation.merge'); assert.strictEqual(n[0].label, 'Merging'); assert.strictEqual(n[0].description, '1 conflict remaining');
    assert.deepStrictEqual((await t.loadCommits(n[0])).map((x: any) => x.label), ['c.txt']);
    await t.runOperation('continue'); assert.strictEqual((await t.operationState(root)).kind, 'merge');
    fs.writeFileSync(path.join(root, 'c.txt'), 'both\n'); sh(root, 'add', 'c.txt');
    n = await t.loadCommits(); assert.strictEqual(n[0].description, 'no conflicts, ready to continue');
    await t.runOperation('continue'); assert.strictEqual(await t.operationState(root), undefined);
    n = await t.loadCommits(); assert.strictEqual(n[0].contextValue, 'commit');
  });
  await check('rebase and cherry-pick detected, including in a worktree', async () => {
    sh(root, 'switch', '-q', '-c', 'rb', 'main~1'); fs.writeFileSync(path.join(root, 'c.txt'), 'rb\n'); sh(root, 'add', 'c.txt'); sh(root, 'commit', '-qm', 'Rb');
    try { sh(root, 'rebase', 'main'); } catch { /* conflict */ }
    const op = await t.operationState(root); assert.strictEqual(op.kind, 'rebase'); assert.strictEqual(op.label, 'Rebasing rb (1/1)'); assert.ok(op.canSkip);
    sh(root, 'rebase', '--abort'); sh(root, 'switch', '-q', 'main');
    const wt = path.join(root, 'worktrees', 'feature-one');
    fs.writeFileSync(path.join(wt, 'c.txt'), 'wt\n'); sh(wt, 'add', 'c.txt'); sh(wt, 'commit', '-qm', 'Wt');
    try { sh(wt, 'cherry-pick', 'conflict/x'); } catch { /* conflict */ }
    assert.strictEqual((await t.operationState(wt)).kind, 'cherry-pick'); assert.strictEqual(await t.operationState(root), undefined);
    sh(wt, 'cherry-pick', '--abort');
  });
  await check('branch and remote rows expand to commits; commits expand to a compact file tree', async () => {
    for (const f of ['pkg/sub/deep/y.ts', 'pkg/z.ts', 'docs/a/b/c.md']) { fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'x\n'); }
    sh(root, 'add', 'pkg', 'docs'); sh(root, 'commit', '-qm', 'Nested files (#7)');
    const n = await t.loadBranches(); assert.strictEqual(n[0].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    const cs = await t.loadBranches(n[0]); assert.strictEqual(cs[0].label, 'Nested files (#7)'); assert.strictEqual(cs[0].contextValue, 'commit');
    const files = await t.commitFiles(root, cs[0].data.sha, cs[0].id);
    assert.deepStrictEqual(files.map((x: any) => x.label), ['docs/a/b', 'pkg']);
    const pkg = files[1].data.children; assert.deepStrictEqual(pkg.map((x: any) => x.label), ['sub/deep', 'z.ts']);
    const leaf = pkg[1]; assert.strictEqual(leaf.resourceUri.query, 'A'); assert.strictEqual(leaf.command.command, 'gitKitchen.diffFile');
    const c = vscode.workspace.getConfiguration('gitKitchen'); await c.update('files.layout', 'list', vscode.ConfigurationTarget.Global);
    const flat = await t.commitFiles(root, cs[0].data.sha); assert.deepStrictEqual(flat.map((x: any) => x.label).sort(), ['c.md', 'y.ts', 'z.ts']);
    await c.update('files.layout', undefined, vscode.ConfigurationTarget.Global);
    t.refLimits.set('b:main', 2); const limited = await t.loadBranches(n[0]); assert.strictEqual(limited.length, 3); assert.strictEqual(limited[2].contextValue, 'loadMore');
    await vscode.commands.executeCommand('gitKitchen.commits.loadMore', 'b:main'); assert.strictEqual(t.refLimits.get('b:main'), 52);
  });
  await check('commit card in hover, commit tooltip and status bar', async () => {
    const sha = sh(root, 'rev-parse', 'HEAD').trim();
    const md = await t.commitCard(root, sha); const v = md.value;
    assert.match(v, /\*\*Smoke\*\*, .* \(/); assert.match(v, /`[0-9a-f]{7}`\]\(command:gitKitchen\.commit\.copySha/); assert.match(v, /\+3 ~0 -0/);
    assert.match(v, /color:#3fb950;">\+3<\/span>/); assert.match(v, /Nested files/);
    const n = (await t.loadCommits()).find((x: any) => x.contextValue === 'commit'); await t.resolveCommitTooltip(n); assert.match(n.tooltip.value, /\+3 ~0 -0/);
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'pkg', 'z.ts')); const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(0, 0, 0, 0); await t.updateBlame(); await new Promise(r => setTimeout(r, 300));
    assert.match(String(t.statusTooltip()?.value ?? t.statusTooltip()), /Nested files/);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 0));
    const text = hovers.flatMap(h => h.contents.map((c: any) => c.value ?? String(c))).join('\n'); assert.match(text, /\+3 ~0 -0/); assert.match(text, /Open Changes/);
    await vscode.commands.executeCommand('gitKitchen.commit.copySha', { sha }); assert.strictEqual(await vscode.env.clipboard.readText(), sha);
  });
  await check('branch labels colored like their icons', async () => {
    const n = await t.loadBranches(); const flat: any[] = [];
    const walk = async (xs: any[]) => { for (const x of xs) { if (x.contextValue === 'branchFolder') await walk(await t.loadBranches(x)); else flat.push(x); } }; await walk(n);
    const main = flat.find(x => x.data.branch.name === 'main'); const stale = flat.find(x => x.data.branch.name === 'old/stale'); const aging = flat.find(x => x.data.branch.name === 'chore/aging');
    for (const x of [main, stale, aging]) { assert.strictEqual(x.resourceUri.scheme, 'gitkitchen-branch'); assert.strictEqual(x.command, undefined); assert.ok(x.iconPath instanceof vscode.ThemeIcon); }
    const dec = (x: any) => t.branchDecorations.provideFileDecoration(x.resourceUri, new vscode.CancellationTokenSource().token);
    assert.strictEqual(dec(main).color.id, 'gitKitchen.activeBranchForeground'); assert.strictEqual(main.iconPath.color.id, 'gitKitchen.activeBranchForeground');
    assert.strictEqual(dec(stale).color.id, 'gitKitchen.branchStaleForeground'); assert.strictEqual(dec(stale).color.id, stale.iconPath.color.id);
    assert.strictEqual(dec(aging).color.id, aging.iconPath.color.id); assert.strictEqual(dec(aging).badge, undefined);
    assert.strictEqual(dec(main).badge, '✓'); assert.strictEqual(dec(main).tooltip, 'Current branch');
    const c = vscode.workspace.getConfiguration('gitKitchen'); await c.update('branches.colorLabels', false, vscode.ConfigurationTarget.Global);
    assert.strictEqual(dec(main).badge, '✓'); assert.strictEqual(dec(stale), undefined); await c.update('branches.colorLabels', undefined, vscode.ConfigurationTarget.Global);
  });
  await check('stash rows: inline apply and trash; delete asks first', async () => {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    const inline = pkg.contributes.menus['view/item/context'].filter((m: any) => m.group?.startsWith('inline') && /viewItem == stash\b/.test(m.when));
    assert.deepStrictEqual(inline.map((m: any) => [m.command, m.group]), [['gitKitchen.stash.apply', 'inline@1'], ['gitKitchen.stash.drop', 'inline@2']]);
    assert.strictEqual(pkg.contributes.commands.find((c: any) => c.command === 'gitKitchen.stash.drop').icon, '$(trash)');
    fs.writeFileSync(path.join(root, 'trash.txt'), 'x\n'); sh(root, 'add', 'trash.txt'); sh(root, 'stash', 'push', '-m', 'to delete');
    const orig = vscode.window.showWarningMessage; let asked = ''; let answer: string | undefined;
    (vscode.window as any).showWarningMessage = async (m: string, o: any, ...items: string[]) => { asked = m; assert.strictEqual(o.modal, true); assert.deepStrictEqual(items, ['Delete']); return answer; };
    try {
      const row = (await t.loadStashes()).find((x: any) => /to delete/.test(String(x.label)));
      await vscode.commands.executeCommand('gitKitchen.stash.drop', row);
      assert.strictEqual(asked, `Delete ${row.data.stash.ref}: ${row.data.stash.message}?`); assert.match(asked, /^Delete stash@\{0\}: .*to delete\?$/);
      assert.match(sh(root, 'stash', 'list'), /to delete/);
      answer = 'Delete'; await vscode.commands.executeCommand('gitKitchen.stash.drop', row);
      assert.doesNotMatch(sh(root, 'stash', 'list'), /to delete/);
    } finally { (vscode.window as any).showWarningMessage = orig; }
  });
  await check('create worktree for an existing local or remote branch; open it when it exists', async () => {
    const pj = require(path.join(__dirname, '..', '..', 'package.json')).contributes;
    const ctx = pj.menus['view/item/context']; const at = (id: string) => ctx.find((m: any) => m.command === id);
    assert.strictEqual(pj.commands.find((x: any) => x.command === 'gitKitchen.worktree.create').title, 'Create Worktree for This Branch…');
    assert.strictEqual(at('gitKitchen.worktree.create').group, '6_wt@1'); assert.strictEqual(at('gitKitchen.worktree.createNewBranch').group, '6_wt@2');
    assert.match(at('gitKitchen.worktree.create').when, /noWorktree/); assert.match(at('gitKitchen.worktree.openForBranch').when, /\\.worktree/);
    assert.match(at('gitKitchen.worktree.createFromRemote').when, /remoteBranch/);
    const qp = vscode.window.showQuickPick; const info = vscode.window.showInformationMessage;
    (vscode.window as any).showQuickPick = async (items: any[]) => items[0]; (vscode.window as any).showInformationMessage = async () => undefined;
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-wtr-'));
    try {
      sh(root, 'branch', 'wt/local'); await t.refresh?.();
      const row = { data: { root, branch: { name: 'wt/local' } } };
      await vscode.commands.executeCommand('gitKitchen.worktree.create', row);
      assert.match(sh(root, 'worktree', 'list', '--porcelain'), /branch refs\/heads\/wt\/local/);
      const flat: any[] = []; const walk = async (xs: any[]) => { for (const x of xs) { if (x.contextValue === 'branchFolder') await walk(await t.loadBranches(x)); else flat.push(x); } }; await walk(await t.loadBranches());
      assert.match(flat.find(x => x.data.branch.name === 'wt/local').contextValue, /\.worktree\b/);
      sh(bare, 'init', '-q', '--bare'); sh(root, 'push', '-q', bare, 'main:refs/heads/wt/remote'); sh(root, 'remote', 'add', 'wtr', bare); sh(root, 'fetch', '-q', 'wtr');
      await vscode.commands.executeCommand('gitKitchen.worktree.createFromRemote', { data: { root, name: 'wtr/wt/remote' } });
      assert.match(sh(root, 'worktree', 'list', '--porcelain'), /branch refs\/heads\/wt\/remote/);
      assert.strictEqual(sh(root, 'rev-parse', '--abbrev-ref', 'wt/remote@{upstream}').trim(), 'wtr/wt/remote');
    } finally {
      (vscode.window as any).showQuickPick = qp; (vscode.window as any).showInformationMessage = info;
      for (const b of ['wt/local', 'wt/remote']) { const m = new RegExp(`worktree (.*)\\nHEAD .*\\nbranch refs/heads/${b}`).exec(sh(root, 'worktree', 'list', '--porcelain')); if (m) sh(root, 'worktree', 'remove', '--force', m[1]); }
      try { sh(root, 'remote', 'remove', 'wtr'); } catch { /* ignore */ }
      for (const b of ['wt/local', 'wt/remote']) { try { sh(root, 'branch', '-D', b); } catch { /* ignore */ } }
    }
  });
  if (process.env.GK_SHOTS) await screenshots(t, root);
  console.log('\n===== GIT KITCHEN SMOKE =====\n' + results.join('\n') + '\n========================');
  if (results.some(r => r.startsWith('FAIL'))) throw new Error('smoke failures');
  void api;
}

async function screenshots(t: any, root: string) {
  const { execFileSync } = require('child_process'); const fs = require('fs');
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', ...a], { cwd }).toString();
  const out = process.env.GK_SHOTS!; fs.mkdirSync(out, { recursive: true });
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  // A merge with one conflict so the Commits view shows the in-progress row.
  sh(root, 'checkout', '-qb', 'shot/conflict'); fs.writeFileSync(path.join(root, 'pkg', 'z.ts'), 'theirs\n'); sh(root, 'commit', '-qam', 'Conflicting change');
  sh(root, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(root, 'pkg', 'z.ts'), 'ours\n'); sh(root, 'commit', '-qam', 'Our change');
  fs.writeFileSync(path.join(root, 'notes.md'), 'draft\n'); sh(root, 'add', 'notes.md'); sh(root, 'stash', 'push', '-m', 'WIP notes');
  const fresh = sh(root, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Fresh work').trim(); sh(root, 'branch', 'feat/fresh', fresh);
  try { sh(root, 'merge', 'shot/conflict'); } catch { /* conflict expected */ }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  try { execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'code', 'windowmove', '0', '0', 'windowsize', '1600', '1400']); } catch { /* best effort */ }
  await vscode.commands.executeCommand('workbench.view.scm');
  for (const c of ['workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel', 'notifications.clearAll']) { try { await vscode.commands.executeCommand(c); } catch { /* ignore */ } }
  await wait(500);
  try { execFileSync('xdotool', ['mousemove', '219', '400', 'mousedown', '1', 'mousemove', '400', '400', 'mousemove', '600', '400', 'mouseup', '1']); } catch { /* best effort */ }
  for (const id of ['gitKitchen.remotes', 'gitKitchen.worktrees', 'gitKitchen.prs', 'gitKitchen.merged', 'gitKitchen.todos', 'gitKitchen.history', 'workbench.scm', 'workbench.scm.history', 'workbench.scm.repositories']) {
    try { await vscode.commands.executeCommand(`${id}.removeView`); } catch { /* not present */ }
  }
  await vscode.commands.executeCommand('gitKitchen.commits.focus'); await vscode.commands.executeCommand('gitKitchen.stashes.focus'); await vscode.commands.executeCommand('gitKitchen.branches.focus');
  await vscode.commands.executeCommand('gitKitchen.refresh'); await wait(1500);
  const bv = t.views['gitKitchen.branches']; const top = await t.loadBranches();
    for (const f of top.filter((x: any) => x.contextValue === 'branchFolder')) { try { await bv.reveal(f, { expand: true }); } catch { /* ignore */ } }
  try { await bv.reveal(top[0], { select: true, focus: true }); } catch { /* ignore */ }
  for (const [name, theme] of [['scm-dark', 'Default Dark Modern'], ['scm-light', 'Default Light Modern']]) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global); await wait(2500);
    try { await vscode.commands.executeCommand('notifications.clearAll'); } catch { /* ignore */ }
    if (process.env.GK_HOVER) { const [x, y] = process.env.GK_HOVER.split(','); execFileSync('xdotool', ['mousemove', x, y]); await wait(800); }
    const file = path.join(out, `${name}.png`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1600x1400', '-i', process.env.DISPLAY!, '-frames:v', '1', file]);
    console.log('SHOT ' + file);
  }
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
}
