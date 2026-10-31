import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { git, gh, repoRoot } from './git';
import * as P from './parsers';

const SCHEME = 'gitkitchen';
let ctx: vscode.ExtensionContext;
const out = vscode.window.createOutputChannel('Git Kitchen');

// ---------- repo + helpers ----------
async function currentRoot(): Promise<string | undefined> {
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') { const r = await repoRoot(path.dirname(ed.document.uri.fsPath)); if (r) return r; }
  for (const f of vscode.workspace.workspaceFolders ?? []) { const r = await repoRoot(f.uri.fsPath); if (r) return r; }
  return undefined;
}
async function root(): Promise<string> { const r = await currentRoot(); if (!r) throw new Error('No git repository is open.'); return r; }
async function confirm(msg: string, action: string): Promise<boolean> { return (await vscode.window.showWarningMessage(msg, { modal: true }, action)) === action; }
function cmd(id: string, fn: (...a: any[]) => any) {
  ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...a: any[]) => {
    try { await fn(...a); } catch (e: any) { out.appendLine(String(e?.message ?? e)); vscode.window.showErrorMessage(String(e?.message ?? e)); }
  }));
}
async function withProgress<T>(title: string, fn: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
}
async function webUrl(r: string, remote = 'origin'): Promise<string> {
  let url = '';
  try { url = (await git(r, 'remote', 'get-url', remote)).trim(); } catch {
    const rs = P.parseRemotes(await git(r, 'remote', '-v')); url = rs[0]?.fetchUrl ?? '';
  }
  const w = P.githubWebUrl(url); if (!w) throw new Error('The remote is not on GitHub.'); return w;
}
function rel(r: string, file: string) { return path.relative(r, file).split(path.sep).join('/'); }

// ---------- content provider for file@ref ----------
function refUri(r: string, ref: string, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + file, query: JSON.stringify({ r, ref, file }) });
}
class RefContent implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri) {
    const q = JSON.parse(uri.query); if (!q.ref) return '';
    try { return await git(q.r, 'show', `${q.ref}:${q.file}`); } catch { return ''; }
  }
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
async function diffFile(r: string, left: string | undefined, right: string | undefined, file: string, oldFile?: string) {
  const l = left ? refUri(r, left, oldFile ?? file) : refUri(r, '', file);
  const rt = right === '' ? refUri(r, '', file) : right ? refUri(r, right, file) : vscode.Uri.file(path.join(r, file));
  const title = `${path.basename(file)} (${left ? left.slice(0, 8) : 'empty'} ↔ ${right === '' ? 'deleted' : right ? right.slice(0, 8) : 'working tree'})`;
  await vscode.commands.executeCommand('vscode.diff', l, rt, title);
}
/** Pick a file changed between two refs (right undefined = working tree) and open a side-by-side diff. */
async function compareRefs(r: string, left: string, right?: string, label?: string) {
  const args = ['diff', '--name-status', '-M', left]; if (right) args.push(right);
  const lines = P.parseNameList(await git(r, ...args));
  if (!lines.length) { vscode.window.showInformationMessage(`No differences${label ? ' ' + label : ''}.`); return; }
  const items = lines.map(l => { const parts = l.split('\t'); return { label: parts[parts.length - 1], description: parts[0], old: parts.length > 2 ? parts[1] : undefined }; });
  const pick = await vscode.window.showQuickPick(items, { title: `Changed files${label ? ' — ' + label : ''}`, matchOnDescription: true });
  if (pick) await diffFile(r, left, right, pick.label, pick.old);
}
async function parentOf(r: string, sha: string): Promise<string> {
  try { return (await git(r, 'rev-parse', `${sha}^`)).trim(); } catch { return EMPTY_TREE; }
}
async function openCommitDiff(arg: any, file?: string) {
  const r = arg?.root ?? await root(); const sha: string = arg?.sha ?? arg; const f = arg?.file ?? file;
  const parent = await parentOf(r, sha);
  if (f) await diffFile(r, parent === EMPTY_TREE ? undefined : parent, sha, f); else await compareRefs(r, parent, sha, `commit ${sha.slice(0, 8)}`);
}
async function compareCommitWorking(arg: any, file?: string) {
  const r = arg?.root ?? await root(); const sha: string = arg?.sha ?? arg; const f = arg?.file ?? file;
  if (f) await diffFile(r, sha, undefined, f); else await compareRefs(r, sha, undefined, `${sha.slice(0, 8)} ↔ working tree`);
}

// ---------- tree plumbing ----------
class Node extends vscode.TreeItem {
  constructor(label: string, public kind: string, public data: any = {}, collapsible = vscode.TreeItemCollapsibleState.None) {
    super(label, collapsible); this.contextValue = kind;
  }
}
type Loader = (n?: Node) => Promise<Node[]>;
class Tree implements vscode.TreeDataProvider<Node> {
  private ev = new vscode.EventEmitter<Node | undefined>(); onDidChangeTreeData = this.ev.event;
  constructor(private load: Loader, private resolve?: (n: Node) => Promise<void>) {}
  refresh() { this.ev.fire(undefined); }
  getTreeItem(n: Node) { return n; }
  async getChildren(n?: Node) {
    try { const shared = n && await sharedChildren(n); return shared ?? await this.load(n); } catch (e: any) { const x = new Node(String(e?.message ?? e).split('\n')[0], 'error'); x.iconPath = icon('warning', 'list.errorForeground'); return [x]; }
  }
  async resolveTreeItem(item: vscode.TreeItem, n: Node) { if (this.resolve) await this.resolve(n); else await resolveCommitTooltip(n); return n; }
}
const trees: Tree[] = [];
function refreshAll() { trees.forEach(t => t.refresh()); }
function icon(id: string, color?: string) { return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined); }
const cardCache = new Map<string, Promise<{ d?: P.CommitDetails; avatar?: string; branches: string[]; web?: string }>>();
async function avatarFor(r: string, web: string | undefined, d: P.CommitDetails): Promise<string | undefined> {
  const quick = P.noreplyAvatar(d.email); if (quick) return quick;
  const m = web && /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(web); if (!m) return;
  const url = (await Promise.race([gh(r, 'api', `repos/${m[1]}/commits/${d.sha}`, '--jq', '.author.avatar_url // empty').catch(() => ''), new Promise<string>(res => setTimeout(() => res(''), 2500))])).trim();
  return url ? `${url}${url.includes('?') ? '&' : '?'}s=32` : undefined;
}
/** Commit details for hovers and tooltips: one `git show` per sha, cached. */
function commitInfo(r: string, sha: string) {
  const key = `${r}\0${sha}`; let p = cardCache.get(key);
  if (!p) {
    p = (async () => {
      const [out, br, web] = await Promise.all([
        git(r, 'show', '--diff-merges=first-parent', '-M', `--format=${P.DETAILS_FORMAT}`, '--numstat', '--summary', sha).catch(() => ''),
        git(r, 'branch', '-r', '--contains', sha, '--format=%(refname:short)').catch(() => ''),
        webUrl(r).catch(() => undefined)]);
      const d = P.parseCommitDetails(out);
      const gh = web && /^https:\/\/github\.com\//.test(web) ? web : undefined;
      return { d, web: gh, branches: P.parseNameList(br).filter(b => !b.endsWith('/HEAD')), avatar: d ? await avatarFor(r, gh, d) : undefined };
    })();
    cardCache.set(key, p); if (cardCache.size > 500) cardCache.delete(cardCache.keys().next().value!);
  }
  return p;
}
async function commitCard(r: string, sha: string, extra = ''): Promise<vscode.MarkdownString | undefined> {
  const i = await commitInfo(r, sha); if (!i.d) return;
  const copy = `command:gitKitchen.commit.copySha?${encodeURIComponent(JSON.stringify([{ sha: i.d.sha }]))}`;
  const md = new vscode.MarkdownString(P.commitCardMarkdown(i.d, { web: i.web, avatar: i.avatar, remoteBranches: i.branches, copyCommand: copy }) + extra, true);
  md.isTrusted = true; md.supportHtml = true; return md;
}
async function resolveCommitTooltip(n: Node) {
  if ((n.kind === 'commit' || n.kind === 'historyCommit') && n.data?.sha && n.data.root) { const md = await commitCard(n.data.root, n.data.sha); if (md) n.tooltip = md; }
}
const AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;
const avatarPending = new Map<string, { r: string; c: P.Commit }>(); const avatarDone = new Set<string>(); let avatarTimer: NodeJS.Timeout | undefined;
function avatarDir() { const d = path.join(ctx.globalStorageUri.fsPath, 'avatars'); fs.mkdirSync(d, { recursive: true }); return d; }
function freshFile(f: string) { try { return Date.now() - fs.statSync(f).mtimeMs < AVATAR_TTL_MS; } catch { return false; } }
/** Commit row icon: the author's avatar from globalStorage (tree icons need a local file), else generated initials while it resolves. */
function commitAvatar(r: string, c: P.Commit): vscode.ThemeIcon | vscode.Uri {
  if (!c.email || !vscode.workspace.getConfiguration('gitKitchen').get('avatars', true)) return icon('git-commit');
  const h = P.emailHash(c.email); const dir = avatarDir(); const png = path.join(dir, `${h}.png`); const svg = path.join(dir, `${h}.svg`);
  if (freshFile(png)) return vscode.Uri.file(png);
  if (!fs.existsSync(svg)) fs.writeFileSync(svg, P.initialsSvg(c.author, c.email));
  if (c.sha && !freshFile(`${svg}.checked`) && !avatarDone.has(h) && !avatarPending.has(h)) { avatarPending.set(h, { r, c }); avatarTimer ??= setTimeout(resolveAvatars, 300); }
  return vscode.Uri.file(svg);
}
async function download(url: string, file: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (!res.ok || !/^image\//.test(res.headers.get('content-type') ?? '')) return false;
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer())); return true;
  } catch { return false; }
}
/** Noreply id, then one batched GitHub lookup per repo, then Gravatar; misses keep the initials for 7 days. */
async function resolveAvatars() {
  avatarTimer = undefined; const batch = [...avatarPending]; avatarPending.clear(); batch.forEach(([h]) => avatarDone.add(h));
  const dir = avatarDir(); const urls = new Map<string, string | undefined>(batch.map(([h, { c }]) => [h, P.noreplyAvatar(c.email)]));
  const byRepo = new Map<string, [string, P.Commit][]>();
  for (const [h, { r, c }] of batch) if (!urls.get(h)) byRepo.set(r, [...(byRepo.get(r) ?? []), [h, c]]);
  for (const [r, items] of byRepo) {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(await webUrl(r).catch(() => '') ?? ''); if (!m) continue;
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50);
      const out = await gh(r, 'api', 'graphql', '-f', `query=${P.avatarQuery(m[1], m[2], chunk.map(([, c]) => c.sha))}`).catch(() => '');
      P.parseAvatarQuery(out, chunk.length).forEach((u, k) => { if (u) urls.set(chunk[k][0], u); });
    }
  }
  let changed = false;
  await Promise.all(batch.map(async ([h, { c }]) => {
    const png = path.join(dir, `${h}.png`); const u = urls.get(h);
    if ((u && await download(u, png)) || await download(P.gravatarUrl(c.email), png)) changed = true;
    else fs.writeFileSync(path.join(dir, `${h}.svg.checked`), '');
  }));
  if (changed) refreshAll();
}
function md(text: string): vscode.MarkdownString { const m = new vscode.MarkdownString(text, true); m.isTrusted = true; m.supportHtml = true; m.supportThemeIcons = true; return m; }
/** The cached avatar (or initials) as a data URI for markdown cards. */
function avatarData(r: string, author: string, email: string): string | undefined {
  if (!email) return; const u = commitAvatar(r, { sha: '', short: '', author, email, date: '', subject: '', parents: [] });
  if (!(u instanceof vscode.Uri)) return;
  try { return `data:image/${u.fsPath.endsWith('.svg') ? 'svg+xml' : 'png'};base64,${fs.readFileSync(u.fsPath).toString('base64')}`; } catch { return; }
}
function commitNode(r: string, c: P.Commit, file?: string): Node {
  const n = new Node(c.subject, file ? 'historyCommit' : 'commit', { root: r, sha: c.sha, file, commit: c });
  n.description = `${c.short} · ${c.author} · ${P.relativeTime(Date.parse(c.date) / 1000)}`;
  n.iconPath = commitAvatar(r, c);
  n.command = { command: 'gitKitchen.openCommitDiff', title: 'Open Changes', arguments: [{ root: r, sha: c.sha, file }] };
  return n;
}

// ---------- Commits ----------
async function loadCommits(n?: Node): Promise<Node[]> {
  const r = await root();
  if (!n) {
    const opNode = await operationNode(r);
    const nodes = await refCommits(r, 'HEAD', 'commits');
    return opNode ? [opNode, ...nodes] : nodes;
  }
  if (n.kind.startsWith('operation')) return (n.data.conflicts as string[]).map(f => {
    const x = new Node(path.basename(f), 'conflictFile', { root: r, file: f }); x.description = path.dirname(f) === '.' ? '' : path.dirname(f);
    x.resourceUri = vscode.Uri.file(path.join(r, f)); x.iconPath = icon('warning', 'list.warningForeground');
    x.command = { command: 'vscode.open', title: 'Open', arguments: [x.resourceUri] }; return x; });
  return [];
}
async function gitDir(r: string): Promise<string> { return (await git(r, 'rev-parse', '--absolute-git-dir')).trim(); }
async function operationState(r: string): Promise<P.OperationState | undefined> {
  const fs = await import('fs'); const d = await gitDir(r);
  return P.detectOperation(f => { try { return fs.readFileSync(path.join(d, f), 'utf8').trim(); } catch { return undefined; } });
}
async function operationNode(r: string): Promise<Node | undefined> {
  const op = await operationState(r);
  await vscode.commands.executeCommand('setContext', 'gitKitchen.operation', op?.kind ?? '');
  if (!op) return;
  const conflicts = P.parseNameList(await git(r, 'diff', '--name-only', '--diff-filter=U').catch(() => ''));
  const x = new Node(op.label, `operation.${op.kind}`, { root: r, op, conflicts }, conflicts.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
  x.description = conflicts.length ? `${conflicts.length} ${conflicts.length === 1 ? 'conflict' : 'conflicts'} remaining` : 'no conflicts, ready to continue';
  x.tooltip = `${op.label} in progress.\nContinue${op.canSkip ? ', Skip' : ''} or Abort from the row actions or its context menu.`;
  x.iconPath = conflicts.length ? icon('warning', 'list.warningForeground') : icon(op.kind === 'merge' ? 'git-merge' : 'git-commit');
  x.id = 'operation'; return x;
}
async function runOperation(action: 'continue' | 'skip' | 'abort') {
  const r = await root(); const op = await operationState(r);
  if (!op) { vscode.window.showInformationMessage('No merge, rebase, cherry-pick or revert is in progress.'); refreshAll(); return; }
  if (action === 'skip' && !op.canSkip) return;
  if (action === 'abort' && !await confirm(`Abort the ${op.kind}? Changes made while resolving it will be discarded.`, 'Abort')) return;
  if (action === 'continue') {
    const left = P.parseNameList(await git(r, 'diff', '--name-only', '--diff-filter=U').catch(() => ''));
    if (left.length) { vscode.window.showWarningMessage(`${left.length} conflicted ${left.length === 1 ? 'file' : 'files'} left. Resolve and stage them first.`); return; }
  }
  const args = op.kind === 'merge' && action === 'continue' ? ['commit', '--no-edit'] : [op.kind, `--${action}`];
  await withProgress(`${action[0].toUpperCase()}${action.slice(1)} ${op.kind}`, () => git(r, '-c', 'core.editor=true', ...args)).finally(refreshAll);
}
const refLimits = new Map<string, number>();
/** Commits reachable from `ref`, newest first, `limit` at a time with a load-more row. `key` identifies the list. */
async function refCommits(r: string, ref: string, key: string): Promise<Node[]> {
  const limit = refLimits.get(key) ?? 50;
  const cs = P.parseLog(await git(r, 'log', '-n', String(limit + 1), `--format=${P.LOG_FORMAT}`, ref, '--').catch(() => ''));
  const nodes = cs.slice(0, limit).map(c => { const x = commitNode(r, c); x.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed; x.command = undefined; x.id = `${key}:${c.sha}`; return x; });
  if (cs.length > limit) { const m = new Node('Load more…', 'loadMore', { key }); m.iconPath = icon('ellipsis'); m.id = `${key}:more`; m.command = { command: 'gitKitchen.commits.loadMore', title: 'Load more', arguments: [key] }; nodes.push(m); }
  return nodes;
}
/** Children shared by every view: a commit's files and the folders inside them. */
async function sharedChildren(n: Node): Promise<Node[] | undefined> {
  if (n.kind === 'commit' && n.collapsibleState !== vscode.TreeItemCollapsibleState.None) return commitFiles(n.data.root, n.data.sha, n.id ?? n.data.sha);
  if (n.kind === 'fileFolder') return n.data.children;
  return undefined;
}
const CHANGE_SCHEME = 'gitkitchen-change';
const STATUS_INFO: Record<string, { color: string; tip: string }> = {
  M: { color: 'gitDecoration.modifiedResourceForeground', tip: 'Modified' }, A: { color: 'gitDecoration.addedResourceForeground', tip: 'Added' },
  D: { color: 'gitDecoration.deletedResourceForeground', tip: 'Deleted' }, R: { color: 'gitDecoration.renamedResourceForeground', tip: 'Renamed' },
  C: { color: 'gitDecoration.addedResourceForeground', tip: 'Copied' }, T: { color: 'gitDecoration.modifiedResourceForeground', tip: 'Type changed' },
};
function filesAsTree() { return vscode.workspace.getConfiguration('gitKitchen').get<string>('files.layout', 'tree') === 'tree'; }
async function commitFiles(r: string, sha: string, key = sha): Promise<Node[]> {
  const files = P.parseNameStatus(await git(r, 'diff-tree', '--no-commit-id', '--root', '-r', '-M', '--name-status', sha));
  const parent = await parentOf(r, sha);
  const leaf = (f: P.ChangedFile, label: string): Node => {
    const x = new Node(label, 'commitFile', { root: r, sha, file: f.path });
    const dir = path.dirname(f.path);
    x.description = filesAsTree() ? (f.oldPath ? `← ${f.oldPath}` : '') : `${dir === '.' ? '' : dir}${f.oldPath ? ` ← ${f.oldPath}` : ''}`;
    x.resourceUri = vscode.Uri.from({ scheme: CHANGE_SCHEME, path: path.posix.join('/', r.split(path.sep).join('/'), f.path), query: f.status });
    x.iconPath = vscode.ThemeIcon.File; x.id = `${key}:f:${f.path}`;
    x.tooltip = `${f.path}${f.oldPath ? `\nrenamed from ${f.oldPath}` : ''}\n${STATUS_INFO[f.status]?.tip ?? f.status}`;
    x.command = { command: 'gitKitchen.diffFile', title: 'Open Changes', arguments: [r, f.status === 'A' || parent === EMPTY_TREE ? undefined : parent, f.status === 'D' ? '' : sha, f.path, f.oldPath] };
    return x;
  };
  if (!filesAsTree()) return files.map(f => leaf(f, path.basename(f.path)));
  const build = (es: P.TreeEntry<P.ChangedFile>[]): Node[] => es.map(e => {
    if (e.kind === 'leaf') return leaf(e.item, e.name);
    const d = new Node(e.name, 'fileFolder', { root: r, children: build(e.children) }, vscode.TreeItemCollapsibleState.Expanded);
    d.iconPath = vscode.ThemeIcon.Folder; d.resourceUri = vscode.Uri.from({ scheme: CHANGE_SCHEME, path: '/' + e.path }); d.id = `${key}:d:${e.path}`; return d;
  });
  return build(P.buildPathTree(files, f => f.path));
}

// ---------- PR cache (for badges) ----------
let prCache: { root: string; at: number; prs: P.PullRequest[] } | undefined;
async function listPrs(r: string, force = false): Promise<P.PullRequest[]> {
  if (!force && prCache && prCache.root === r && Date.now() - prCache.at < 60_000) return prCache.prs;
  const prs = P.parsePrs(await gh(r, 'pr', 'list', '--state', 'open', '--limit', '100', '--json', P.PR_FIELDS));
  prCache = { root: r, at: Date.now(), prs }; return prs;
}

// ---------- Branches ----------
let selectedForCompare: string | undefined;
let branchPrCache: { root: string; at: number; prs: P.BranchPrInfo[] } | undefined;
/** Open and merged PRs for all branches, in one gh call, cached for a minute. */
let mockBranchPrs: P.BranchPrInfo[] | undefined;
async function branchPrs(r: string): Promise<P.BranchPrInfo[]> {
  if (mockBranchPrs) return mockBranchPrs;
  if (branchPrCache && branchPrCache.root === r && Date.now() - branchPrCache.at < 60_000) return branchPrCache.prs;
  const prs = P.parseBranchPrs(await gh(r, 'pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state,isDraft,headRefName').catch(() => '[]'));
  branchPrCache = { root: r, at: Date.now(), prs }; return prs;
}
function treeLayout(): boolean { return vscode.workspace.getConfiguration('gitKitchen').get<string>('branches.layout', 'tree') === 'tree'; }
/** Turn grouped entries into folder nodes (or a flat list) using `leaf` to build each item node. */
function sortBy(): P.SortBy { return vscode.workspace.getConfiguration('gitKitchen').get<string>('sortBy', 'date') === 'name' ? 'name' : 'date'; }
function sortByDate(): boolean { return sortBy() === 'date'; }
function layoutNodes<T>(items: T[], nameOf: (t: T) => string, leaf: (t: T, label: string) => Node, folderKind: string, timeOf?: (t: T) => number): Node[] {
  const byDate = sortByDate() && timeOf;
  if (!treeLayout()) return P.sortBranches(items, { current: () => false, name: nameOf, time: timeOf ?? (() => 0), by: byDate ? 'date' : 'name' }).map(i => leaf(i, nameOf(i)));
  const build = (es: P.TreeEntry<T>[]): Node[] => es.map(e => {
    if (e.kind === 'leaf') return leaf(e.item, e.name);
    const f = new Node(e.name, folderKind, { children: build(e.children) }, vscode.TreeItemCollapsibleState.Expanded);
    f.iconPath = icon('folder'); f.id = `${folderKind}:${e.path}`; return f;
  });
  return build(P.groupByPrefix(items, nameOf, byDate ? timeOf : undefined));
}
/** Expanded branch: incoming, outgoing, compare with upstream, a separator, then its commits. */
async function branchChildren(n: Node): Promise<Node[]> {
  const r = n.data.root as string; const b = n.data.branch as P.Branch; const ref = `refs/heads/${b.name}`; const out: Node[] = [];
  const remote = b.upstream?.split('/')[0] ?? '';
  if (b.upstream && !b.gone) {
    const plural = (k: number) => `${k} commit${k === 1 ? '' : 's'}`;
    if (b.behind) { const x = new Node('Incoming', 'syncGroup', { root: r, range: `${ref}..refs/remotes/${b.upstream}`, key: `in:${b.name}` }, vscode.TreeItemCollapsibleState.Collapsed); x.description = `${plural(b.behind)} to pull from ${remote}`; x.tooltip = md(P.syncGroupCardMarkdown('Incoming', b.behind, b.name, b.upstream)); x.iconPath = icon('cloud-download', 'gitKitchen.branchBehindForeground'); x.id = `in:${b.name}`; out.push(x); }
    if (b.ahead) { const x = new Node('Outgoing', 'syncGroup', { root: r, range: `refs/remotes/${b.upstream}..${ref}`, key: `out:${b.name}` }, vscode.TreeItemCollapsibleState.Collapsed); x.description = `${plural(b.ahead)} to push to ${remote}`; x.tooltip = md(P.syncGroupCardMarkdown('Outgoing', b.ahead, b.name, b.upstream)); x.iconPath = icon('cloud-upload', 'gitKitchen.branchAheadForeground'); x.id = `out:${b.name}`; out.push(x); }
    const c = new Node(`Compare ${b.name} with ${b.upstream}`, 'compareUpstream'); c.iconPath = icon('git-compare'); c.id = `cmp:${b.name}`;
    c.command = { command: 'gitKitchen.branch.compareUpstream', title: 'Compare with Upstream', arguments: [n] }; out.push(c);
    const sep = new Node('', 'separator'); sep.description = '────────── commits'; sep.id = `sep:${b.name}`; out.push(sep);
  }
  return [...out, ...await refCommits(r, ref, `b:${b.name}`)];
}
async function loadBranches(n?: Node): Promise<Node[]> {
  if (n?.kind === 'syncGroup') return refCommits(n.data.root, n.data.range, n.data.key);
  if (n?.data?.branch) return branchChildren(n);
  if (n) return n.data.children ?? [];
  const r = await root();
  const bs = P.parseBranches(await git(r, 'for-each-ref', '--sort=-committerdate', `--format=${P.BRANCH_FORMAT}`, 'refs/heads'));
  let prs: P.PullRequest[] = []; try { prs = await listPrs(r); } catch { /* gh missing or not GitHub */ }
  const cfg = vscode.workspace.getConfiguration('gitKitchen'); const main = cfg.get<string>('mainBranch', 'main');
  const opts: P.StalenessOptions = { agingDays: cfg.get('staleness.agingDays', 14), staleDays: cfg.get('staleness.staleDays', 60), behindCount: cfg.get('staleness.behindCount', 20) };
  const hasMain = bs.some(b => b.name === main);
  const [statePrs, mergedOut] = await Promise.all([branchPrs(r), hasMain ? git(r, 'branch', '--merged', main, '--format=%(refname:short)').catch(() => '') : Promise.resolve('')]);
  merged = new Set(P.parseNameList(mergedOut).filter(x => x !== main)); mergedBase = main; allPrs = statePrs;
  syncTimes.clear();
  await Promise.all(bs.filter(b => b.upstream).map(async b => { const t = P.parseReflogTime(await git(r, 'reflog', 'show', '-n1', '--date=unix', '--format=%gd', `refs/remotes/${b.upstream}`).catch(() => '')); if (t) syncTimes.set(b.upstream!, t); }));
  await Promise.all(bs.map(async b => {
    if (b.current) return;
    let behind = b.behind;
    if (!b.upstream && hasMain && b.name !== main) behind = +(await git(r, 'rev-list', '--count', `${b.name}..${main}`).catch(() => '0')).trim() || 0;
    fresh.set(b.name, P.freshness(behind, b.time, Date.now(), opts));
  }));
  const current = bs.filter(b => b.current);
  const rest = layoutNodes(bs.filter(b => !b.current), b => b.name, (b, label) => branchNode(r, b, prs, label), 'branchFolder', b => b.time);
  return [...current.map(b => branchNode(r, b, prs, b.name)), ...rest];
}
const fresh = new Map<string, ReturnType<typeof P.freshness>>();
let merged = new Set<string>(); let mergedBase = 'main'; let allPrs: P.BranchPrInfo[] = [];
const BRANCH_SCHEME = 'gitkitchen-branch';
const syncTimes = new Map<string, number>();
const GLYPH_FILE: Record<string, string> = { 'git-branch': 'branch', 'git-merge': 'merge', 'git-pull-request': 'pr', 'git-pull-request-draft': 'draft', worktree: 'worktree' };
/** Codicon glyph with a small status dot (codicons cannot be overlaid, so these are prebuilt SVGs). */
function overlayIcon(glyph: string, dot: string): { light: vscode.Uri; dark: vscode.Uri } {
  const f = (theme: string) => vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icons', `${glyph}-${dot}-${theme}.svg`);
  return { light: f('light'), dark: f('dark') };
}
const BRANCH_LABEL_COLOR: Record<string, string> = { gone: 'gitKitchen.branchGoneForeground', synced: 'gitKitchen.branchSyncedForeground', ahead: 'gitKitchen.branchAheadForeground', behind: 'gitKitchen.branchBehindForeground' };
const activeLabelEmitter = new vscode.EventEmitter<undefined>();
const activeLabelDecorations: vscode.FileDecorationProvider = {
  onDidChangeFileDecorations: activeLabelEmitter.event,
  provideFileDecoration(uri) {
    if (uri.scheme === CHANGE_SCHEME) { const st = STATUS_INFO[uri.query]; return st ? { badge: uri.query, tooltip: st.tip, color: new vscode.ThemeColor(st.color), propagate: false } : undefined; }
    if (uri.scheme !== BRANCH_SCHEME) return;
    const color = BRANCH_LABEL_COLOR[uri.query]; if (!color) return;
    if (!vscode.workspace.getConfiguration('gitKitchen').get('branches.colorLabels', true)) return;
    return { color: new vscode.ThemeColor(color), propagate: false };
  },
};
function branchNode(r: string, b: P.Branch, prs: P.PullRequest[], label: string): Node {
  const pr = prs.find(p => p.headRefName === b.name);
  const hasWt = !!b.worktreePath && !b.current;
  const x = new Node(label, ['branch', b.current ? 'current' : '', hasWt ? 'worktree' : 'noWorktree', b.upstream ? 'tracked' : '', pr ? 'hasPr' : ''].filter(Boolean).join('.'), { root: r, branch: b, pr });
  x.description = P.branchDescription(b, b.time ? P.relativeTime(b.time) : '', [pr ? P.prBadge(pr) : '', hasWt ? 'worktree' : ''].filter(Boolean));
  const f = b.current ? undefined : fresh.get(b.name);
  const st = P.branchState({ current: b.current, pr: P.prForBranch(allPrs, b.name), mergedInto: merged.has(b.name) ? mergedBase : undefined, worktree: hasWt });
  const brPr = P.prForBranch(allPrs, b.name);
  const mergedRow = st.icon === 'git-merge';
  // Merged branches: default label, merge glyph with a purple dot.
  const tone = mergedRow ? '' : b.gone ? 'gone' : P.syncTone(b, b.upstream ? syncTimes.get(b.upstream) : undefined, Date.now(), vscode.workspace.getConfiguration('gitKitchen').get('recentSyncMinutes', 60));
  const prUrl = brPr && prCache?.prs.find(p => p.number === brPr.number)?.url;
  x.tooltip = md(P.branchCardMarkdown(b, { root: r, state: st.state ?? (b.gone ? 'Upstream gone' : undefined), syncText: b.upstream && !b.gone ? P.syncText(b, tone === 'gone' ? undefined : tone) : undefined,
    freshness: f?.reason, when: b.time ? P.relativeTime(b.time) : undefined, author: b.author, avatar: b.email ? avatarData(r, b.author ?? '', b.email) : undefined,
    pr: brPr ? { number: brPr.number, state: brPr.isDraft && brPr.state === 'OPEN' ? 'DRAFT' : brPr.state, url: prUrl } : undefined }));
  // Every colored state: its glyph in that color with a matching dot; merged: default glyph, purple dot.
  const dot = mergedRow ? 'merged' : tone; const glyph = GLYPH_FILE[st.icon];
  x.iconPath = dot && glyph ? overlayIcon(glyph, dot) : icon(st.icon);
  // The URI only carries the label color; rows have no open command.
  x.resourceUri = vscode.Uri.from({ scheme: BRANCH_SCHEME, path: '/' + b.name, query: tone });
  x.id = `branch:${b.name}`; x.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
  return x;
}
function bn(n: Node): string { return n?.data?.branch?.name ?? n?.data?.name; }
async function pickBranch(r: string, title: string, includeRemote = false): Promise<string | undefined> {
  const out = await git(r, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', ...(includeRemote ? ['refs/remotes'] : []));
  return vscode.window.showQuickPick(P.parseNameList(out).filter(b => !b.endsWith('/HEAD')), { title });
}
async function askName(prompt: string, value = ''): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt, value, validateInput: v => P.isValidRefName(v) ? undefined : 'Not a valid name' });
}
function registerBranches() {
  cmd('gitKitchen.updateFromGitHub', async () => {
    const current = String(ctx.extension.packageJSON.version);
    const rel = await withProgress('Git Kitchen: checking for updates', async () => {
      const res = await fetch('https://api.github.com/repos/Heroeskitchen/gitkitchen/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gitkitchen' } });
      if (!res.ok) throw new Error(`Could not check for updates (GitHub said ${res.status}).`);
      return res.json() as Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }>;
    });
    const latest = rel.tag_name.replace(/^v/, '');
    if (!P.isNewerVersion(latest, current)) { vscode.window.showInformationMessage(`Git Kitchen ${current} is the latest version.`); return; }
    const asset = rel.assets.find(a => a.name.endsWith('.vsix'));
    if (!asset) throw new Error(`Release ${latest} has no .vsix file.`);
    await withProgress(`Git Kitchen: installing ${latest}`, async () => {
      const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'gitkitchen' } });
      if (!res.ok) throw new Error(`Download failed (GitHub said ${res.status}).`);
      const file = vscode.Uri.joinPath(ctx.globalStorageUri, asset.name);
      await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
      await vscode.workspace.fs.writeFile(file, new Uint8Array(await res.arrayBuffer()));
      await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
    });
    if ((await vscode.window.showInformationMessage(`Git Kitchen ${latest} is installed. Reload to use it.`, 'Reload Window')) === 'Reload Window')
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
  cmd('gitKitchen.branch.switch', async (n: Node) => { const r = await root(); const b = n ? bn(n) : await pickBranch(r, 'Switch to', true); if (!b) return;
    if (b.includes('/') && (await git(r, 'branch', '-r', '--list', b)).trim()) await git(r, 'switch', '--track', b); else await git(r, 'switch', b); refreshAll(); });
  cmd('gitKitchen.branch.create', async (n?: Node) => { const r = await root(); const from = n ? bn(n) : 'HEAD'; const name = await askName(`New branch from ${from}`); if (!name) return;
    const sw = await vscode.window.showQuickPick(['Create and switch', 'Create only'], { title: name }); if (!sw) return;
    await git(r, ...(sw === 'Create only' ? ['branch', name, from] : ['switch', '-c', name, from])); refreshAll(); });
  cmd('gitKitchen.branch.rename', async (n: Node) => { const r = await root(); const old = bn(n); const name = await askName(`Rename ${old}`, old); if (!name || name === old) return; await git(r, 'branch', '-m', old, name); refreshAll(); });
  cmd('gitKitchen.branch.delete', async (n: Node) => { const r = await root(); const b = bn(n);
    if (!await confirm(`Delete local branch "${b}"?`, 'Delete')) return;
    try { await git(r, 'branch', '-d', b); } catch (e: any) {
      if (/not fully merged/.test(e.stderr ?? '') && await confirm(`"${b}" is not fully merged. Delete it anyway? Its unmerged commits will only be reachable from the reflog.`, 'Delete anyway')) await git(r, 'branch', '-D', b); else throw e;
    } refreshAll(); });
  cmd('gitKitchen.branch.merge', async (n: Node) => { const r = await root(); await withProgress(`Merging ${bn(n)}`, () => git(r, 'merge', '--no-edit', bn(n))); refreshAll(); });
  cmd('gitKitchen.branch.rebase', async (n: Node) => { const r = await root(); if (!await confirm(`Rebase the current branch onto "${bn(n)}"?`, 'Rebase')) return; await withProgress('Rebasing', () => git(r, 'rebase', bn(n))); refreshAll(); });
  cmd('gitKitchen.branch.reset', async (n: Node) => { const r = await root(); const mode = await vscode.window.showQuickPick(['--mixed', '--soft', '--hard'], { title: `Reset current branch to ${bn(n)}` }); if (!mode) return;
    if (!await confirm(`Reset the current branch to "${bn(n)}" (${mode})?${mode === '--hard' ? ' Uncommitted changes will be lost.' : ''}`, 'Reset')) return; await git(r, 'reset', mode, bn(n)); refreshAll(); });
  cmd('gitKitchen.branch.pull', async (n: Node) => { const r = await root(); const b = n.data.branch as P.Branch;
    if (b.current) await withProgress('Pulling', () => git(r, 'pull', '--ff-only'));
    else { if (!b.upstream) throw new Error(`${b.name} has no upstream.`); const [rem, ...rest] = b.upstream.split('/'); await withProgress('Pulling', () => git(r, 'fetch', rem, `${rest.join('/')}:${b.name}`)); }
    refreshAll(); });
  cmd('gitKitchen.branch.push', async (n?: Node) => { const r = await root(); const b = (n?.data?.branch as P.Branch | undefined)?.name ?? (await git(r, 'branch', '--show-current')).trim();
    const up = (await git(r, 'rev-parse', '--abbrev-ref', `${b}@{upstream}`).catch(() => '')).trim();
    const remotes = P.parseRemotes(await git(r, 'remote', '-v')).map(x => x.name);
    const remote = up ? up.split('/')[0] : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(remotes, { title: `Push ${b} to` });
    if (!remote) return; if (!await confirm(`Push ${b} to ${remote}?`, 'Push')) return;
    await withProgress(`Pushing ${b}`, () => git(r, 'push', ...(up ? [] : ['-u']), remote, b)); refreshAll(); });
  cmd('gitKitchen.branch.fetch', async (n: Node) => { const r = await root(); const b = n.data.branch as P.Branch; const up = b.upstream?.split('/');
    await withProgress('Fetching', () => up ? git(r, 'fetch', up[0], up.slice(1).join('/')) : git(r, 'fetch', '--all')); refreshAll(); });
  cmd('gitKitchen.branch.setUpstream', async (n: Node) => { const r = await root(); const up = P.parseNameList(await git(r, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes')).filter(x => !x.endsWith('/HEAD'));
    const pick = await vscode.window.showQuickPick(['(none — unset upstream)', ...up], { title: `Upstream for ${bn(n)}` }); if (!pick) return;
    if (pick.startsWith('(none')) await git(r, 'branch', '--unset-upstream', bn(n)); else await git(r, 'branch', `--set-upstream-to=${pick}`, bn(n)); refreshAll(); });
  cmd('gitKitchen.branch.createTag', async (n: Node) => { const r = await root(); const name = await askName(`Tag at ${bn(n)}`); if (!name) return;
    const msg = await vscode.window.showInputBox({ prompt: 'Tag message (leave empty for a lightweight tag)' }); if (msg === undefined) return;
    await git(r, ...(msg ? ['tag', '-a', name, '-m', msg, bn(n)] : ['tag', name, bn(n)])); vscode.window.showInformationMessage(`Tag ${name} created.`); });
  cmd('gitKitchen.branch.openOnRemote', async (n: Node) => { const r = await root(); const b = n.data.branch as P.Branch; const rem = b.upstream?.split('/')[0] ?? 'origin';
    const name = b.upstream ? b.upstream.split('/').slice(1).join('/') : b.name; await vscode.env.openExternal(vscode.Uri.parse(`${await webUrl(r, rem)}/tree/${name}`)); });
  cmd('gitKitchen.branch.copyName', async (n: Node) => { await vscode.env.clipboard.writeText(bn(n)); });
  cmd('gitKitchen.branch.compareUpstream', async (n: Node) => { const r = await root(); const b = n.data.branch as P.Branch; if (!b.upstream) throw new Error('No upstream.'); await compareRefs(r, b.upstream, b.name, `${b.upstream} ↔ ${b.name}`); });
  cmd('gitKitchen.branch.compareHead', async (n: Node) => { const r = await root(); const cur = (await git(r, 'branch', '--show-current')).trim() || 'HEAD'; await compareRefs(r, 'HEAD', bn(n), `${cur} ↔ ${bn(n)}`); });
  cmd('gitKitchen.branch.compareBase', async (n: Node) => { const r = await root(); const base = (await git(r, 'merge-base', 'HEAD', bn(n))).trim(); await compareRefs(r, base, bn(n), `common base ↔ ${bn(n)}`); });
  cmd('gitKitchen.branch.compareWorking', async (n: Node) => { const r = await root(); await compareRefs(r, bn(n), undefined, `${bn(n)} ↔ working tree`); });
  cmd('gitKitchen.branch.selectForCompare', async (n: Node) => { selectedForCompare = bn(n); await vscode.commands.executeCommand('setContext', 'gitKitchen.hasCompareSelection', true);
    vscode.window.showInformationMessage(`Selected ${selectedForCompare} for compare. Right-click another branch → Compare with Selected.`); });
  cmd('gitKitchen.branch.compareSelected', async (n: Node) => { const r = await root(); if (!selectedForCompare) return; await compareRefs(r, selectedForCompare, bn(n), `${selectedForCompare} ↔ ${bn(n)}`); });
}

// ---------- Remotes ----------
async function loadRemotes(n?: Node): Promise<Node[]> {
  const r = await root();
  if (!n) {
    const [rv, refs, up] = await Promise.all([git(r, 'remote', '-v'), git(r, 'for-each-ref', '--sort=-committerdate', `--format=%(refname:short)${P.SEP}%(committerdate:unix)`, 'refs/remotes').catch(() => ''),
      git(r, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}').catch(() => '')]);
    const remotes = P.parseRemotes(rv); const newest = new Map<string, number>();
    for (const l of P.parseNameList(refs)) { const [ref, t] = l.split(P.SEP); const rm = remotes.find(x => ref.startsWith(x.name + '/')); if (rm && !newest.has(rm.name)) newest.set(rm.name, +t); }
    const upRemote = remotes.map(x => x.name).filter(x => up.trim().startsWith(x + '/')).sort((a, b) => b.length - a.length)[0];
    return P.pinSort(remotes, { current: x => x.name === upRemote, name: x => x.name, time: x => newest.get(x.name) ?? 0, by: sortBy() }).map(rm => { const x = new Node(rm.name, 'remote', { root: r, name: rm.name }, vscode.TreeItemCollapsibleState.Collapsed); x.description = rm.fetchUrl; x.iconPath = icon('cloud'); x.id = `remote:${rm.name}`;
      const count = P.parseNameList(refs).filter(l => l.startsWith(rm.name + '/') && !l.split(P.SEP)[0].endsWith('/HEAD')).length;
      x.tooltip = md(P.remoteCardMarkdown({ name: rm.name, fetchUrl: rm.fetchUrl, pushUrl: rm.pushUrl ?? rm.fetchUrl, branches: count, web: P.githubWebUrl(rm.fetchUrl) || undefined })); return x; });
  }
  if (n.kind === 'remote') {
    const rows = P.parseNameList(await git(r, 'for-each-ref', '--sort=-committerdate', `--format=%(refname:short)${P.SEP}%(committerdate:unix)`, `refs/remotes/${n.data.name}`))
      .map(l => l.split(P.SEP)).filter(([b]) => !b.endsWith('/HEAD') && b !== n.data.name).map(([b, t]) => ({ full: b, short: b.slice(n.data.name.length + 1), time: +t }));
    return layoutNodes(rows, x => x.short, (b, label) => { const x = new Node(label, 'remoteBranch', { root: r, name: b.full }, vscode.TreeItemCollapsibleState.Collapsed); x.iconPath = icon('git-branch'); x.tooltip = b.full; x.description = b.time ? P.relativeTime(b.time) : ''; x.id = `rb:${b.full}`; return x; }, 'remoteFolder', b => b.time);
  }
  if (n.kind === 'remoteFolder') return n.data.children;
  if (n.kind === 'remoteBranch') return refCommits(r, `refs/remotes/${n.data.name}`, `rb:${n.data.name}`);
  return [];
}
function registerRemotes() {
  cmd('gitKitchen.remote.fetch', async (n: Node) => { const r = await root(); await withProgress(`Fetching ${n.data.name}`, () => git(r, 'fetch', '--prune', n.data.name)); refreshAll(); });
  cmd('gitKitchen.remote.pull', async (n: Node) => { const r = await root(); const cur = (await git(r, 'branch', '--show-current')).trim(); await withProgress(`Pulling ${cur} from ${n.data.name}`, () => git(r, 'pull', '--ff-only', n.data.name, cur)); refreshAll(); });
  cmd('gitKitchen.remote.push', async (n: Node) => { const r = await root(); const cur = (await git(r, 'branch', '--show-current')).trim();
    if (!await confirm(`Push ${cur} to ${n.data.name}?`, 'Push')) return; await withProgress(`Pushing ${cur}`, () => git(r, 'push', '-u', n.data.name, cur)); refreshAll(); });
  cmd('gitKitchen.remoteBranch.checkout', async (n: Node) => { const r = await root(); await git(r, 'switch', '--track', n.data.name); refreshAll(); });
  cmd('gitKitchen.remoteBranch.compareHead', async (n: Node) => { const r = await root(); await compareRefs(r, 'HEAD', n.data.name, `HEAD ↔ ${n.data.name}`); });
}

// ---------- Stashes ----------
async function loadStashes(n?: Node): Promise<Node[]> {
  const r = await root();
  if (!n) return P.parseStashes(await git(r, 'stash', 'list', `--format=${P.STASH_FORMAT}`)).map(s => {
    const x = new Node(s.message, 'stash', { root: r, stash: s, sha: s.sha }, vscode.TreeItemCollapsibleState.Collapsed);
    x.description = `${s.ref} · ${P.relativeTime(Date.parse(s.date) / 1000)}`; x.iconPath = icon('git-stash'); return x; });
  if (n.kind === 'stash') {
    const s = n.data.stash as P.Stash;
    return P.parseNameList(await git(r, 'stash', 'show', '--name-status', '--include-untracked', s.ref).catch(() => git(r, 'stash', 'show', '--name-status', s.ref))).map(l => {
      const parts = l.split('\t'); const f = parts[parts.length - 1];
      const x = new Node(f, 'stashFile', { root: r, file: f, sha: s.sha }); x.description = parts[0]; x.iconPath = vscode.ThemeIcon.File; x.resourceUri = vscode.Uri.file(path.join(r, f));
      x.command = { command: 'gitKitchen.stash.openFile', title: 'Open', arguments: [x] }; return x; });
  }
  return [];
}
async function resolveStash(n: Node) {
  if (n.kind !== 'stash' || n.tooltip) return;
  const s = n.data.stash as P.Stash; const num = await git(n.data.root, 'stash', 'show', '--numstat', s.ref).catch(() => '');
  let files = 0, ins = 0, del = 0; for (const l of P.parseNameList(num)) { const [a, d] = l.split('\t'); files++; ins += +a || 0; del += +d || 0; }
  const branch = /^(?:WIP on|On) ([^:]+):/.exec(s.message)?.[1];
  n.tooltip = md(P.stashCardMarkdown(s, { branch, dateText: new Date(s.date).toLocaleString(), when: P.relativeTime(Date.parse(s.date) / 1000), files, insertions: ins, deletions: del }));
}
function registerStashes() {
  cmd('gitKitchen.stash.save', async () => { const r = await root(); const msg = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' }); if (msg === undefined) return;
    const inc = await vscode.window.showQuickPick(['Tracked changes', 'Include untracked files'], { title: 'Stash' }); if (!inc) return;
    await git(r, 'stash', 'push', ...(inc.startsWith('Include') ? ['-u'] : []), ...(msg ? ['-m', msg] : [])); refreshAll(); });
  cmd('gitKitchen.stash.applyRef', async (ref: string) => { const r = await root(); await git(r, 'stash', 'apply', ref); refreshAll(); });
  cmd('gitKitchen.stash.apply', async (n: Node) => { const r = await root(); await git(r, 'stash', 'apply', n.data.stash.ref); refreshAll(); });
  cmd('gitKitchen.stash.pop', async (n: Node) => { const r = await root(); await git(r, 'stash', 'pop', n.data.stash.ref); refreshAll(); });
  cmd('gitKitchen.stash.drop', async (n: Node) => { const r = await root(); if (!await confirm(`Delete ${n.data.stash.ref}: ${n.data.stash.message}?`, 'Delete')) return; await git(r, 'stash', 'drop', n.data.stash.ref); refreshAll(); });
  cmd('gitKitchen.stash.openFile', async (n: Node) => { const r = n.data.root; const parent = await parentOf(r, n.data.sha);
    // Untracked files live in the third parent; fall back to an empty left side.
    const inParent = await git(r, 'cat-file', '-e', `${parent}:${n.data.file}`).then(() => true, () => false);
    const inStash = await git(r, 'cat-file', '-e', `${n.data.sha}:${n.data.file}`).then(() => true, () => false);
    await diffFile(r, inParent ? parent : undefined, inStash ? n.data.sha : `${n.data.sha}^3`, n.data.file); });
  cmd('gitKitchen.stash.compareWorking', async (n: Node) => compareCommitWorking({ root: n.data.root, sha: n.data.sha, file: n.data.file }));
  cmd('gitKitchen.stash.stashAndSwitch', async (n?: Node) => { const r = await root(); const b = n && n.kind.startsWith('branch') ? bn(n) : await pickBranch(r, 'Stash changes and switch to'); if (!b) return;
    const cur = (await git(r, 'branch', '--show-current')).trim();
    await git(r, 'stash', 'push', '-u', '-m', `Auto-stash on ${cur} before switching to ${b}`); await git(r, 'switch', b); refreshAll();
    vscode.window.showInformationMessage(`Stashed changes from ${cur} and switched to ${b}.`); });
}

// ---------- Blame ----------
const eolDeco = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 3em', fontWeight: '300', textDecoration: 'none; font-family: var(--vscode-editor-font-family), monospace; font-size: 0.85em' }, rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen });
const gutterDeco = vscode.window.createTextEditorDecorationType({ before: { color: new vscode.ThemeColor('editorLineNumber.foreground'), margin: '0 1.5em 0 0', width: '22ch', textDecoration: 'none; display: inline-block; overflow: hidden; white-space: pre' } });
const blameCache = new Map<string, { version: number; lines: P.BlameLine[] }>();
let gutterOn = false;
async function blameFor(doc: vscode.TextDocument): Promise<{ r: string; lines: P.BlameLine[] } | undefined> {
  if (doc.uri.scheme !== 'file') return;
  const r = await repoRoot(path.dirname(doc.uri.fsPath)); if (!r) return;
  const key = doc.uri.fsPath; const c = blameCache.get(key);
  if (c && c.version === doc.version) return { r, lines: c.lines };
  try {
    const outp = await (await import('./git')).run('git', ['blame', '--porcelain', '--contents', '-', '--', rel(r, doc.fileName)], r, doc.getText());
    const lines = P.parseBlamePorcelain(outp); blameCache.set(key, { version: doc.version, lines }); return { r, lines };
  } catch { return; }
}
let blameTimer: NodeJS.Timeout | undefined;
function scheduleBlame() { if (blameTimer) clearTimeout(blameTimer); blameTimer = setTimeout(updateBlame, 150); }
const lineHighlightDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('gitKitchen.currentLineBackground') });
const HEAT_COLORS = ['255,99,0', '255,130,0', '255,160,0', '240,190,0', '200,200,40', '150,190,90', '100,170,150', '80,140,200', '70,110,210', '70,90,200'];
function heatDecos(where: 'gutter' | 'background') {
  return HEAT_COLORS.map((c, i) => vscode.window.createTextEditorDecorationType(where === 'gutter'
    ? { isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: `rgba(${c},${(0.9 - i * 0.05).toFixed(2)})` }
    : { isWholeLine: true, backgroundColor: `rgba(${c},${(0.22 - i * 0.018).toFixed(3)})` }));
}
let heatGutter = heatDecos('gutter'); let heatBg = heatDecos('background');
const addedDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorGutter.addedBackground'), overviewRulerColor: new vscode.ThemeColor('editorGutter.addedBackground'), overviewRulerLane: vscode.OverviewRulerLane.Left });
const modifiedDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'), overviewRulerColor: new vscode.ThemeColor('editorGutter.modifiedBackground'), overviewRulerLane: vscode.OverviewRulerLane.Left });
const deletedDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '1px 0 0 0', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'), overviewRulerColor: new vscode.ThemeColor('editorGutter.deletedBackground'), overviewRulerLane: vscode.OverviewRulerLane.Left });
const sameCommitDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('gitKitchen.sameCommitBackground'), overviewRulerColor: new vscode.ThemeColor('gitKitchen.sameCommitBackground'), overviewRulerLane: vscode.OverviewRulerLane.Center });
const statusItem = vscode.window.createStatusBarItem('gitKitchen.blame', vscode.StatusBarAlignment.Left, 50);
statusItem.name = 'Git Kitchen Blame';
let statusSha: string | undefined; let lastChanges: P.LineChanges | undefined; let lastSame: number[] = [];
function setSameCommit(ed: vscode.TextEditor, lines: P.BlameLine[], line1: number) {
  lastSame = vscode.workspace.getConfiguration('gitKitchen').get('blame.highlightSameCommit', true) ? P.sameCommitLines(lines, line1) : [];
  ed.setDecorations(sameCommitDeco, lastSame.map(n => new vscode.Range(n - 1, 0, n - 1, 0)));
}
type AnnotMode = 'none' | 'blame' | 'heatmap' | 'changes';
let annot: AnnotMode = 'none'; let changesBase: string | undefined;
async function setAnnot(m: AnnotMode) {
  annot = annot === m ? 'none' : m; gutterOn = annot === 'blame';
  for (const [k, v] of [['gutterBlame', annot === 'blame'], ['heatmap', annot === 'heatmap'], ['changes', annot === 'changes']] as const) await vscode.commands.executeCommand('setContext', `gitKitchen.${k}`, v);
  await updateBlame();
}
function clearAll(ed: vscode.TextEditor) { statusItem.hide(); lastChanges = undefined; lastSame = []; for (const d of [eolDeco, gutterDeco, lineHighlightDeco, addedDeco, modifiedDeco, deletedDeco, sameCommitDeco, ...heatGutter, ...heatBg]) ed.setDecorations(d, []); }
async function updateBlame() {
  const ed = vscode.window.activeTextEditor; if (!ed) return;
  const cfg = vscode.workspace.getConfiguration('gitKitchen');
  const b = await blameFor(ed.document); if (!b) { clearAll(ed); return; }
  const line = ed.selection.active.line; const bl = b.lines[line];
  if (cfg.get('blame.currentLine', true) && bl) {
    const text = bl.uncommitted ? 'You · Uncommitted changes' : `${bl.author}, ${P.relativeTime(bl.authorTime)} • ${bl.summary}`;
    ed.setDecorations(eolDeco, [{ range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER), renderOptions: { after: { contentText: text } } }]);
    ed.setDecorations(lineHighlightDeco, cfg.get('blame.highlightLine', true) ? [new vscode.Range(line, 0, line, 0)] : []);
  } else { ed.setDecorations(eolDeco, []); ed.setDecorations(lineHighlightDeco, []); }
  setSameCommit(ed, b.lines, line + 1);
  const sb = cfg.get('statusBar.enabled', true) ? P.statusBarText(bl) : undefined;
  if (sb && bl) {
    statusItem.text = sb; statusItem.tooltip = bl.uncommitted ? 'Uncommitted changes' : `${bl.summary}\n${bl.sha.slice(0, 8)} · click to open the commit changes`;
    if (!bl.uncommitted) { const sha = bl.sha; commitCard(b.r, sha, '\n\n---\n\nClick to open the commit changes').then(md => { if (md && statusSha === sha) statusItem.tooltip = md; }); }
    statusSha = bl.uncommitted ? undefined : bl.sha;
    statusItem.command = bl.uncommitted ? undefined : { title: 'Open Changes', command: 'gitKitchen.openCommitDiff', arguments: [{ root: b.r, sha: bl.sha, file: bl.filename || rel(b.r, ed.document.fileName) }] };
    statusItem.show();
  } else statusItem.hide();
  if (annot === 'blame') {
    let prev = '';
    ed.setDecorations(gutterDeco, b.lines.map(bl => { const same = bl.sha === prev; prev = bl.sha;
      const t = same ? ' ' : bl.uncommitted ? 'Uncommitted' : `${bl.sha.slice(0, 7)} ${bl.author.split(' ')[0]} ${P.relativeTime(bl.authorTime).replace(' ago', '')}`;
      return { range: new vscode.Range(bl.line - 1, 0, bl.line - 1, 0), renderOptions: { before: { contentText: t.padEnd(22, '\u00a0').slice(0, 22) } } }; }));
  } else ed.setDecorations(gutterDeco, []);
  const heatSet = cfg.get<string>('heatmap.location', 'gutter') === 'background' ? heatBg : heatGutter;
  for (const d of [...heatGutter, ...heatBg]) if (annot !== 'heatmap' || !heatSet.includes(d)) ed.setDecorations(d, []);
  if (annot === 'heatmap') {
    const now = Date.now() / 1000; const times = b.lines.map(l => l.uncommitted ? now : l.authorTime);
    const newest = Math.max(...times), oldest = Math.min(...times);
    const buckets: vscode.Range[][] = heatSet.map(() => []);
    b.lines.forEach((l, i) => buckets[P.heatBucket(times[i], newest, oldest, heatSet.length)].push(new vscode.Range(l.line - 1, 0, l.line - 1, 0)));
    heatSet.forEach((d, i) => ed.setDecorations(d, buckets[i]));
  }
  if (annot === 'changes' || cfg.get('changes.gutter', true)) {
    const base = annot === 'changes' && changesBase ? changesBase : 'HEAD';
    const args = ['diff', '-U0', '--no-color', '--no-ext-diff', base, '--', rel(b.r, ed.document.fileName)];
    let diff = '';
    if (ed.document.isDirty) {
      const { runStdout } = await import('./git');
      const baseText = await git(b.r, 'show', `${base}:${rel(b.r, ed.document.fileName)}`).catch(() => '');
      const os = await import('os'); const fs = await import('fs');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-')); const a = path.join(dir, 'a'), c = path.join(dir, 'b');
      fs.writeFileSync(a, baseText); fs.writeFileSync(c, ed.document.getText());
      diff = await runStdout('git', ['diff', '--no-index', '-U0', '--no-color', '--no-ext-diff', a, c], b.r);
      fs.rmSync(dir, { recursive: true, force: true });
    } else diff = await git(b.r, ...args).catch(() => '');
    lastChanges = P.classifyChanges(diff);
    const r1 = (n: number) => new vscode.Range(n - 1, 0, n - 1, 0);
    ed.setDecorations(addedDeco, lastChanges.added.map(r1));
    ed.setDecorations(modifiedDeco, lastChanges.modified.map(r1));
    ed.setDecorations(deletedDeco, lastChanges.deletedAfter.map(n => new vscode.Range(Math.max(0, n), 0, Math.max(0, n), 0)));
  } else { lastChanges = undefined; ed.setDecorations(addedDeco, []); ed.setDecorations(modifiedDeco, []); ed.setDecorations(deletedDeco, []); }
}
const hoverProvider: vscode.HoverProvider = {
  async provideHover(doc, pos) {
    if (!vscode.workspace.getConfiguration('gitKitchen').get('blame.hover', true)) return;
    const b = await blameFor(doc); const bl = b?.lines[pos.line]; if (!b || !bl || bl.uncommitted) return;
    const file = bl.filename || rel(b.r, doc.fileName);
    const ed = vscode.window.visibleTextEditors.find(e => e.document === doc);
    if (ed) setSameCommit(ed, b.lines, pos.line + 1);
    let hunk = '';
    if (vscode.workspace.getConfiguration('gitKitchen').get('blame.changesHover', true) && bl.origLine) {
      const d = await git(b.r, 'show', '--format=', '--no-color', '--no-ext-diff', '-U3', bl.sha, '--', file).catch(() => '');
      hunk = (P.hunkForLine(d, bl.origLine) ?? '').split('\n').slice(0, 40).join('\n');
    }
    const info = await commitInfo(b.r, bl.sha);
    const text = info.d ? P.blameHoverMarkdown(info.d, { avatar: info.avatar ?? avatarData(b.r, info.d.author, info.d.email), web: info.web, root: b.r, file, line: bl.line, hunk: hunk || undefined })
      : `**${bl.summary.replace(/[\\`*_[\]<>]/g, '\\$&')}**`;
    const m = md(text);
    return new vscode.Hover(m);
  }
};
function registerBlame() {
  cmd('gitKitchen.blame.toggleFile', async () => setAnnot('blame'));
  cmd('gitKitchen.blame.toggleLine', async () => { const c = vscode.workspace.getConfiguration('gitKitchen'); await c.update('blame.currentLine', !c.get('blame.currentLine', true), vscode.ConfigurationTarget.Global); updateBlame(); });
  cmd('gitKitchen.copyCommitLink', async (arg?: any) => {
    let r: string, sha: string, file: string, start: number, end: number | undefined;
    if (arg?.sha) { r = arg.root; sha = arg.sha; file = arg.file; start = arg.line ?? 1; }
    else {
      const ed = vscode.window.activeTextEditor; if (!ed) return; r = await root(); file = rel(r, ed.document.fileName);
      start = ed.selection.start.line + 1; end = ed.selection.end.line + 1;
      // Prefer the pushed HEAD commit so the link resolves on GitHub.
      sha = (await git(r, 'rev-parse', 'HEAD')).trim();
      if (ed.document.isDirty) vscode.window.showWarningMessage('The file has unsaved changes; the link points at the last commit.');
    }
    const url = P.commitLineUrl(await webUrl(r), sha, file, start, end); await vscode.env.clipboard.writeText(url);
    vscode.window.setStatusBarMessage(`Copied ${url}`, 4000);
  });
  cmd('gitKitchen.openCommitDiff', openCommitDiff);
  cmd('gitKitchen.compareCommitWorking', compareCommitWorking);
  cmd('gitKitchen.blame.openLineCommit', async () => { const ed = vscode.window.activeTextEditor; if (!ed) return; const b = await blameFor(ed.document); const bl = b?.lines[ed.selection.active.line];
    if (!b || !bl || bl.uncommitted) { vscode.window.showInformationMessage('This line is not committed yet.'); return; } await openCommitDiff({ root: b.r, sha: bl.sha, file: bl.filename }); });
  ctx.subscriptions.push(eolDeco, gutterDeco, lineHighlightDeco, addedDeco, modifiedDeco, deletedDeco, sameCommitDeco, statusItem, ...heatGutter, ...heatBg,
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
    vscode.window.onDidChangeTextEditorSelection(scheduleBlame), vscode.window.onDidChangeActiveTextEditor(scheduleBlame),
    vscode.workspace.onDidSaveTextDocument(d => { blameCache.delete(d.uri.fsPath); scheduleBlame(); }),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document === vscode.window.activeTextEditor?.document) scheduleBlame(); }));
}

// ---------- File history ----------
let historyFile: { root: string; file: string } | undefined;
let historyTree: Tree; let historyView: vscode.TreeView<Node>;
async function loadHistory(n?: Node): Promise<Node[]> {
  if (n || !historyFile) return [];
  const { root: r, file } = historyFile;
  return P.parseLog(await git(r, 'log', '--follow', '-n', '500', `--format=${P.LOG_FORMAT}`, '--', file)).map(c => commitNode(r, c, file));
}
function registerHistory() {
  cmd('gitKitchen.fileHistory', async (uri?: vscode.Uri) => {
    const u = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri; if (!u || u.scheme !== 'file') return;
    const r = await repoRoot(path.dirname(u.fsPath)); if (!r) throw new Error('This file is not in a git repository.');
    historyFile = { root: r, file: rel(r, u.fsPath) }; historyView.title = `File History: ${path.basename(u.fsPath)}`;
    historyTree.refresh(); await vscode.commands.executeCommand('gitKitchen.history.focus');
  });
  cmd('gitKitchen.history.compareWorking', async (n: Node) => compareCommitWorking(n.data));
  cmd('gitKitchen.commit.copyLink', async (n: Node) => { const url = n.data.file ? P.commitLineUrl(await webUrl(n.data.root), n.data.sha, n.data.file, 1).replace(/#L1$/, '') : `${await webUrl(n.data.root)}/commit/${n.data.sha}`;
    await vscode.env.clipboard.writeText(url); vscode.window.setStatusBarMessage(`Copied ${url}`, 4000); });
  cmd('gitKitchen.commit.openOnGitHub', async (n: Node) => vscode.env.openExternal(vscode.Uri.parse(`${await webUrl(n.data.root)}/commit/${n.data.sha}`)));
  cmd('gitKitchen.copyText', async (text: string) => { await vscode.env.clipboard.writeText(String(text)); vscode.window.setStatusBarMessage('Copied', 1500); });
  cmd('gitKitchen.commit.copyMessage', async (a: { root: string; sha: string }) => { await vscode.env.clipboard.writeText((await git(a.root, 'log', '-1', '--format=%B', a.sha)).trim()); vscode.window.setStatusBarMessage('Copied commit message', 1500); });
  cmd('gitKitchen.commit.search', async (a?: { root: string; sha: string }) => {
    const r = a?.root ?? await root(); const q = (a as any)?.direct ? a!.sha : await vscode.window.showInputBox({ title: 'Search Commits', prompt: 'SHA, message text or author', value: a?.sha?.slice(0, 7) }); if (!q) return;
    const bySha = /^[0-9a-f]{4,40}$/i.test(q) ? P.parseLog(await git(r, 'log', '--all', '-n', '1', `--format=${P.LOG_FORMAT}`, q, '--').catch(() => '')) : [];
    const found = [...bySha, ...P.parseLog(await git(r, 'log', '--all', '-n', '200', '-i', `--grep=${q}`, `--format=${P.LOG_FORMAT}`).catch(() => '')), ...P.parseLog(await git(r, 'log', '--all', '-n', '200', '-i', `--author=${q}`, `--format=${P.LOG_FORMAT}`).catch(() => ''))];
    const seen = new Set<string>(); const items = found.filter(c => !seen.has(c.sha) && seen.add(c.sha)).map(c => ({ label: c.subject, description: `${c.short} · ${c.author} · ${P.relativeTime(Date.parse(c.date) / 1000)}`, sha: c.sha }));
    const pick = await vscode.window.showQuickPick(items, { title: `Commits matching "${q}"`, matchOnDescription: true }); if (pick) await openCommitDiff({ root: r, sha: pick.sha });
  });
  cmd('gitKitchen.commit.openOnRemote', async (a: { root: string; sha: string }) => vscode.env.openExternal(vscode.Uri.parse(`${await webUrl(a.root)}/commit/${a.sha}`)));
  cmd('gitKitchen.blame.comparePrevious', async (a: { root: string; sha: string; file: string }) => {
    const prev = (await git(a.root, 'rev-parse', '--verify', '-q', `${a.sha}^`).catch(() => '')).trim();
    await diffFile(a.root, prev || undefined, undefined, a.file);
  });
  cmd('gitKitchen.blame.openRevision', async (a: { root: string; sha: string; file: string; line?: number }) => {
    const ed = await vscode.window.showTextDocument(refUri(a.root, a.sha, a.file), { preview: true });
    if (a.line) { const p = new vscode.Position(Math.max(0, a.line - 1), 0); ed.selection = new vscode.Selection(p, p); ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter); }
  });
  cmd('gitKitchen.blame.previous', async (a: { root: string; sha: string; file: string; line?: number }) => {
    const out = await git(a.root, 'blame', '--porcelain', '-L', `${a.line ?? 1},${a.line ?? 1}`, `${a.sha}^`, '--', a.file).catch(() => '');
    const prev = /^([0-9a-f]{40})/.exec(out)?.[1];
    if (!prev) { vscode.window.showInformationMessage('No earlier revision of this line.'); return; }
    await openCommitDiff({ root: a.root, sha: prev, file: a.file });
  });
  cmd('gitKitchen.commit.reveal', async (a: { root: string; sha: string }) => {
    await vscode.commands.executeCommand('gitKitchen.commits.focus');
    const v = views['gitKitchen.commits']; const nodes = await refCommits(a.root, 'HEAD', 'commits'); const hit = nodes.find(x => x.data?.sha === a.sha);
    if (hit && v) await v.reveal(hit, { select: true, focus: true }); else vscode.window.showInformationMessage(`${a.sha.slice(0, 7)} is not in the loaded commits.`);
  });
  cmd('gitKitchen.commit.copySha', async (n: any) => { const sha = n?.data?.sha ?? n?.sha; await vscode.env.clipboard.writeText(sha); vscode.window.setStatusBarMessage(`Copied ${sha.slice(0, 7)}`, 3000); });
  cmd('gitKitchen.commit.openAllFiles', async (n: Node) => openCommitDiff({ root: n.data.root, sha: n.data.sha }));
}

// ---------- Worktrees ----------
async function loadWorktrees(n?: Node): Promise<Node[]> {
  if (n) return [];
  const r = await root(); const wts = P.parseWorktrees(await git(r, 'worktree', 'list', '--porcelain'));
  const top = path.resolve((await git(r, 'rev-parse', '--show-toplevel').catch(() => r)).trim() || r);
  const times = new Map<string, number>(await Promise.all(wts.map(async w => [w.path, w.head ? +(await git(r, 'log', '-1', '--format=%ct', w.head).catch(() => '0')).trim() || 0 : 0] as [string, number])));
  const sorted = P.pinSort(wts, { current: w => path.resolve(w.path) === top, name: w => w.branch ?? w.path, time: w => times.get(w.path) ?? 0, by: sortBy() });
  return Promise.all(sorted.map(async w => {
    const x = new Node(w.branch ?? (w.detached ? `(detached ${w.head?.slice(0, 7)})` : path.basename(w.path)), w.main ? 'worktree.main' : `worktree${w.locked ? '.locked' : ''}`, { root: r, wt: w, path: w.path });
    let dirty = false, ab = '';
    if (!w.prunable && fs.existsSync(w.path)) {
      dirty = !!(await git(w.path, 'status', '--porcelain').catch(() => '')).trim();
      const t = await git(w.path, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD').catch(() => '');
      const m = /(\d+)\s+(\d+)/.exec(t); if (m) ab = [+m[2] ? `↑${m[2]}` : '', +m[1] ? `↓${m[1]}` : ''].filter(Boolean).join(' ');
    }
    x.description = [dirty ? '●' : '', ab, w.locked ? 'locked' : '', w.prunable ? 'missing' : '', path.relative(r, w.path) || '.'].filter(Boolean).join('  ');
    const subj = w.head ? (await git(r, 'log', '-1', '--format=%s', w.head).catch(() => '')).trim() : ''; x.tooltip = md(P.worktreeCardMarkdown(w, { dirty, subject: subj })); x.iconPath = icon(w.locked ? 'lock' : 'worktree', dirty ? 'gitDecoration.modifiedResourceForeground' : undefined);
    return x;
  }));
}
async function wtPathFromNode(n: Node): Promise<string> {
  if (n.data.path) return n.data.path;
  const p = n.data.branch?.worktreePath; if (p) return p; throw new Error('No worktree for this branch.');
}
async function worktreePathOf(r: string, branch: string): Promise<string | undefined> {
  return P.parseWorktrees(await git(r, 'worktree', 'list', '--porcelain')).find(w => w.branch === branch)?.path;
}
async function createWorktree(r: string, branch: string, newBranch?: string, track = false) {
  const def = P.defaultWorktreePath(r, newBranch ?? branch);
  const choice = await vscode.window.showQuickPick([{ label: 'Default folder', description: def }, { label: 'Choose folder…' }], { title: `Worktree for ${newBranch ?? branch}` }); if (!choice) return;
  let target = def;
  if (choice.label.startsWith('Choose')) { const u = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this parent folder' }); if (!u) return; target = path.join(u[0].fsPath, (newBranch ?? branch).replace(/[\\/]/g, '-')); }
  await withProgress('Creating worktree', () => newBranch ? git(r, 'worktree', 'add', '-b', newBranch, ...(track ? ['--track'] : []), target, branch) : git(r, 'worktree', 'add', target, branch));
  refreshAll();
  const open = await vscode.window.showInformationMessage(`Worktree created at ${target}`, 'Open in New Window', 'Open Here');
  if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: open === 'Open in New Window' });
}
function registerWorktrees() {
  cmd('gitKitchen.worktree.create', async (n: Node) => { const r = await root(); await createWorktree(r, bn(n)); });
  cmd('gitKitchen.worktree.openForBranch', async (n: Node) => {
    const p = n.data.branch?.worktreePath ?? await worktreePathOf(await root(), bn(n)); if (!p) throw new Error('No worktree for this branch.');
    const open = await vscode.window.showQuickPick(['Open in New Window', 'Open Here'], { title: `Open worktree ${p}` }); if (!open) return;
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: open === 'Open in New Window' });
  });
  cmd('gitKitchen.worktree.createFromRemote', async (n: Node) => {
    const r = await root(); const full: string = n.data.name;
    const remote = P.parseRemotes(await git(r, 'remote', '-v')).map(x => x.name).filter(x => full.startsWith(x + '/')).sort((a, b) => b.length - a.length)[0];
    const local = remote ? full.slice(remote.length + 1) : full;
    if (await git(r, 'rev-parse', '--verify', '--quiet', `refs/heads/${local}`).then(() => true, () => false)) throw new Error(`A local branch named ${local} already exists. Use Create Worktree for This Branch on it instead.`);
    await createWorktree(r, full, local, true);
  });
  cmd('gitKitchen.worktree.createNewBranch', async (n?: Node) => { const r = await root(); const from = n ? bn(n) : await pickBranch(r, 'New branch from', true); if (!from) return;
    const name = await askName(`New branch from ${from}`); if (!name) return; await createWorktree(r, from, name); });
  cmd('gitKitchen.worktree.openNewWindow', async (n: Node) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(await wtPathFromNode(n)), { forceNewWindow: true }));
  cmd('gitKitchen.worktree.openHere', async (n: Node) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(await wtPathFromNode(n)), { forceNewWindow: false }));
  cmd('gitKitchen.worktree.reveal', async (n: Node) => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(await wtPathFromNode(n))));
  cmd('gitKitchen.worktree.terminal', async (n: Node) => { const p = await wtPathFromNode(n); vscode.window.createTerminal({ name: path.basename(p), cwd: p }).show(); });
  cmd('gitKitchen.worktree.lock', async (n: Node) => { const r = await root(); const reason = await vscode.window.showInputBox({ prompt: 'Lock reason (optional)' }); if (reason === undefined) return;
    await git(r, 'worktree', 'lock', ...(reason ? ['--reason', reason] : []), await wtPathFromNode(n)); refreshAll(); });
  cmd('gitKitchen.worktree.unlock', async (n: Node) => { const r = await root(); await git(r, 'worktree', 'unlock', await wtPathFromNode(n)); refreshAll(); });
  cmd('gitKitchen.worktree.move', async (n: Node) => { const r = await root(); const p = await wtPathFromNode(n); const u = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Move into this folder' }); if (!u) return;
    await git(r, 'worktree', 'move', p, path.join(u[0].fsPath, path.basename(p))); refreshAll(); });
  cmd('gitKitchen.worktree.remove', async (n: Node) => { const r = await root(); const p = await wtPathFromNode(n);
    if (!await confirm(`Remove the worktree at ${p}? The branch is kept.`, 'Remove')) return;
    try { await git(r, 'worktree', 'remove', p); } catch (e: any) {
      if (/modified or untracked|contains/.test(e.stderr ?? '') && await confirm('The worktree has uncommitted changes. Remove it anyway and lose them?', 'Remove anyway')) await git(r, 'worktree', 'remove', '--force', p); else throw e;
    } refreshAll(); });
  cmd('gitKitchen.worktree.prune', async () => { const r = await root(); const dry = (await git(r, 'worktree', 'prune', '--dry-run', '-v')).trim();
    if (!dry) { vscode.window.showInformationMessage('Nothing to prune.'); return; } if (!await confirm(`Prune stale worktree entries?\n\n${dry}`, 'Prune')) return; await git(r, 'worktree', 'prune'); refreshAll(); });
}

// ---------- Pull requests ----------
async function loadPrs(n?: Node): Promise<Node[]> {
  const r = await root();
  if (!n) {
    const cur = (await git(r, 'branch', '--show-current').catch(() => '')).trim();
    const prs = P.pinSort(await listPrs(r, true), { current: p => p.headRefName === cur, name: p => p.title, time: p => Date.parse(p.updatedAt ?? '') || 0, by: sortBy() });
    return prs.map(p => {
    const x = new Node(p.title, 'pr', { root: r, pr: p }, vscode.TreeItemCollapsibleState.Collapsed);
    x.description = `${P.prBadge(p)} · ${p.headRefName} → ${p.baseRefName}`; x.tooltip = md(P.prCardMarkdown(p, { avatar: /^[\w-]+$/.test(p.author) ? `https://github.com/${p.author}.png?size=32` : undefined }));
    x.iconPath = p.isDraft ? icon('git-pull-request-draft', 'descriptionForeground') : icon('git-pull-request', 'gitKitchen.prOpenForeground'); return x; });
  }
  if (n.kind === 'pr') {
    const j = JSON.parse(await gh(r, 'pr', 'view', String(n.data.pr.number), '--json', 'commits'));
    return (j.commits ?? []).map((c: any) => commitNode(r, { sha: c.oid, short: c.oid.slice(0, 7), author: c.authors?.[0]?.name ?? '', email: c.authors?.[0]?.email ?? '', date: c.committedDate, subject: c.messageHeadline, parents: [] }));
  }
  return [];
}
async function mergePr(n: Node, how: 'merge' | 'squash' | 'rebase') {
  const p = n.data.pr as P.PullRequest; const label = { merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' }[how];
  if (!await confirm(`${label} #${p.number} "${p.title}" into ${p.baseRefName}?\nChecks: ${p.checks}${p.reviewDecision ? ' · ' + p.reviewDecision.toLowerCase() : ''}`, label)) return;
  await withProgress(`${label} #${p.number}`, () => gh(n.data.root, 'pr', 'merge', String(p.number), `--${how}`)); prCache = undefined; refreshAll();
  vscode.window.showInformationMessage(`#${p.number} merged.`);
}
function registerPrs() {
  cmd('gitKitchen.pr.open', async (n: Node) => vscode.env.openExternal(vscode.Uri.parse((n.data.pr ?? n.data).url)));
  cmd('gitKitchen.pr.checkout', async (n: Node) => { await withProgress('Checking out PR', () => gh(n.data.root, 'pr', 'checkout', String(n.data.pr.number))); refreshAll(); });
  cmd('gitKitchen.pr.merge', (n: Node) => mergePr(n, 'merge'));
  cmd('gitKitchen.pr.squash', (n: Node) => mergePr(n, 'squash'));
  cmd('gitKitchen.pr.rebase', (n: Node) => mergePr(n, 'rebase'));
  cmd('gitKitchen.pr.compare', async (n: Node) => { const r = n.data.root; const p = n.data.pr as P.PullRequest;
    await withProgress('Fetching PR', () => git(r, 'fetch', 'origin', `pull/${p.number}/head`)); const head = (await git(r, 'rev-parse', 'FETCH_HEAD')).trim();
    const base = (await git(r, 'merge-base', `origin/${p.baseRefName}`, head)).trim(); await compareRefs(r, base, head, `#${p.number}`); });
  cmd('gitKitchen.pr.create', async (n?: Node) => {
    const r = await root(); const branch = n ? bn(n) : (await git(r, 'branch', '--show-current')).trim();
    const base = await vscode.window.showInputBox({ prompt: 'Base branch', value: vscode.workspace.getConfiguration('gitKitchen').get('mainBranch', 'main') }); if (!base) return;
    const subjects = P.parseNameList(await git(r, 'log', '--reverse', '--format=%s', `origin/${base}..${branch}`).catch(() => git(r, 'log', '--reverse', '--format=%s', `${base}..${branch}`)));
    const pre = P.prefillPr(branch, subjects);
    const title = await vscode.window.showInputBox({ prompt: 'PR title', value: pre.title }); if (!title) return;
    const body = await vscode.window.showInputBox({ prompt: 'PR body (edit on GitHub for more)', value: pre.body.replace(/\n/g, ' ⏎ ') }); if (body === undefined) return;
    const draft = await vscode.window.showQuickPick(['Ready for review', 'Draft'], { title: 'Create PR' }); if (!draft) return;
    const pushed = await git(r, 'ls-remote', '--heads', 'origin', branch).then(s => !!s.trim(), () => false);
    if (!pushed) { if (!await confirm(`${branch} is not on origin yet. Push it?`, 'Push')) return; await git(r, 'push', '-u', 'origin', branch); }
    const url = (await gh(r, 'pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body.replace(/ ⏎ /g, '\n'), ...(draft === 'Draft' ? ['--draft'] : []))).trim();
    prCache = undefined; refreshAll();
    if (await vscode.window.showInformationMessage(`Created ${url}`, 'Open') === 'Open') vscode.env.openExternal(vscode.Uri.parse(url));
  });
}

// ---------- Dual remote ----------
async function dualPair(r: string): Promise<{ pair?: { source: string; target: string }; remotes: string[] }> {
  const cfg = vscode.workspace.getConfiguration('gitKitchen', vscode.Uri.file(r));
  const remotes = P.parseRemotes(await git(r, 'remote', '-v')).map(x => x.name);
  const up = (await git(r, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}').catch(() => '')).trim();
  const upRemote = up ? remotes.filter(x => up.startsWith(x + '/')).sort((a, b) => b.length - a.length)[0] : undefined;
  return { remotes, pair: P.pickDualPair(remotes, { source: cfg.get<string>('dualRemote.source', ''), target: cfg.get<string>('dualRemote.target', '') }, upRemote) };
}
async function saveDualPair(r: string, source: string, target: string) {
  const c = vscode.workspace.getConfiguration('gitKitchen', vscode.Uri.file(r));
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(r));
  const where = folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
  await c.update('dualRemote.source', source, where); await c.update('dualRemote.target', target, where); setDualHeader({ source, target }); refreshAll();
}
let dualView: vscode.TreeView<Node> | undefined; let dualAsked = false;
function setDualHeader(pair?: { source: string; target: string }) {
  if (!dualView) return;
  dualView.title = pair ? `${pair.source} → ${pair.target}` : 'Compare Remotes';
  dualView.description = pair ? `On ${pair.source}, not on ${pair.target}` : undefined;
}
async function loadDual(n?: Node): Promise<Node[]> {
  if (n) return [];
  const r = await root(); const branch = vscode.workspace.getConfiguration('gitKitchen').get<string>('mainBranch', 'main');
  const { pair, remotes } = await dualPair(r);
  setDualHeader(pair);
  if (remotes.length < 2) return [];
  if (!pair) {
    if (!dualAsked) { dualAsked = true; setTimeout(() => vscode.commands.executeCommand('gitKitchen.dual.chooseRemote'), 0); }
    const x = new Node('Choose which remotes to compare…', 'hint'); x.command = { command: 'gitKitchen.dual.chooseRemote', title: 'Choose' }; x.iconPath = icon('filter'); return [x];
  }
  const range = `${pair.target}/${branch}..${pair.source}/${branch}`;
  const cs = P.parseLog(await git(r, 'log', '--date-order', '-n', '300', `--format=${P.LOG_FORMAT}`, range).catch(() => ''));
  if (!cs.length) { const x = new Node(`Everything on ${pair.source}/${branch} is on ${pair.target}`, 'hint'); x.iconPath = icon('pass'); return [x]; }
  return cs.map(c => commitNode(r, c));
}
function registerDual() {
  cmd('gitKitchen.dual.chooseRemote', async () => { const r = await root(); const { remotes, pair } = await dualPair(r);
    if (remotes.length < 2) { vscode.window.showInformationMessage('This repository has only one remote.'); return; }
    const pairs = remotes.flatMap(a => remotes.filter(b => b !== a).map(b => ({ label: `On ${a}, not on ${b}`, source: a, target: b, picked: pair?.source === a && pair?.target === b })));
    const pick = await vscode.window.showQuickPick(pairs, { title: 'Compare Remotes', placeHolder: 'Show commits that are on one remote but not on another' }); if (!pick) return;
    await saveDualPair(r, pick.source, pick.target); });
  cmd('gitKitchen.dual.swap', async () => { const r = await root(); const { pair } = await dualPair(r); if (!pair) return vscode.commands.executeCommand('gitKitchen.dual.chooseRemote');
    await saveDualPair(r, pair.target, pair.source); });
  cmd('gitKitchen.dual.fetch', async () => { const r = await root(); await withProgress('Fetching all remotes', () => git(r, 'fetch', '--all', '--prune')); refreshAll(); });
}

// ---------- Merged cleanup ----------
async function loadMerged(n?: Node): Promise<Node[]> {
  if (n) return [];
  const r = await root(); const base = vscode.workspace.getConfiguration('gitKitchen').get<string>('mainBranch', 'main');
  const cur = (await git(r, 'branch', '--show-current')).trim();
  return P.parseMergedBranches(await git(r, 'branch', '--merged', base), base).filter(b => b !== cur).map(b => { const x = new Node(b, 'mergedBranch', { root: r, name: b }); x.iconPath = icon('git-merge'); x.description = `merged into ${base}`; return x; });
}
function registerMerged() {
  cmd('gitKitchen.merged.delete', async (n: Node) => { if (!await confirm(`Delete merged branch "${n.data.name}"?`, 'Delete')) return; await git(n.data.root, 'branch', '-d', n.data.name); refreshAll(); });
  cmd('gitKitchen.merged.reviewAll', async () => { const r = await root(); const items = await loadMerged();
    for (const it of items) { const a = await vscode.window.showWarningMessage(`Delete merged branch "${it.data.name}"?`, { modal: true }, 'Delete', 'Skip'); if (a === undefined) break; if (a === 'Delete') await git(r, 'branch', '-d', it.data.name); }
    refreshAll(); });
}

// ---------- TODOs ----------
async function loadTodos(n?: Node): Promise<Node[]> {
  const r = await root();
  if (!n) {
    const outp = await git(r, 'grep', '-n', '-I', '-E', '\\b(TODO|FIXME)\\b', '--', '.', ':!node_modules', ':!*.min.js', ':!package-lock.json').catch(() => '');
    const groups = P.groupByFile(P.parseTodos(outp));
    return [...groups].map(([f, hits]) => { const x = new Node(path.basename(f), 'todoFile', { root: r, hits }, vscode.TreeItemCollapsibleState.Collapsed); x.description = `${path.dirname(f) === '.' ? '' : path.dirname(f)} · ${hits.length}`; x.resourceUri = vscode.Uri.file(path.join(r, f)); x.iconPath = vscode.ThemeIcon.File; return x; });
  }
  return (n.data.hits as P.TodoHit[]).map(h => { const x = new Node(h.text || h.tag, 'todo'); x.description = `${h.tag} · line ${h.line}`; x.iconPath = icon(h.tag === 'FIXME' ? 'bug' : 'checklist');
    x.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(path.join(r, h.file)), { selection: new vscode.Range(h.line - 1, 0, h.line - 1, 0) }] }; return x; });
}

// ---------- Explorer: reopen / default workspace ----------
const DEFAULTS_KEY = 'gitKitchen.defaultWorkspaces';
function defaults(): Record<string, string> { return ctx.globalState.get<Record<string, string>>(DEFAULTS_KEY, {}); }
function norm(p: string) { return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase(); }
async function updateDefaultContext() { await vscode.commands.executeCommand('setContext', 'gitKitchen.defaultWorkspaceFiles', Object.values(defaults()).map(p => vscode.Uri.file(p).toString()).concat(Object.values(defaults()).map(p => vscode.Uri.file(p).fsPath))); }
function registerExplorer() {
  const open = (newWin: boolean) => async (u: vscode.Uri) => vscode.commands.executeCommand('vscode.openFolder', u, { forceNewWindow: newWin });
  cmd('gitKitchen.explorer.reopenHere', open(false));
  cmd('gitKitchen.explorer.openNewWindow', open(true));
  cmd('gitKitchen.explorer.setDefaultWorkspace', async (u: vscode.Uri) => { const d = { ...defaults(), [norm(path.dirname(u.fsPath))]: u.fsPath }; await ctx.globalState.update(DEFAULTS_KEY, d); await updateDefaultContext();
    vscode.window.showInformationMessage(`${path.basename(u.fsPath)} will open whenever ${path.dirname(u.fsPath)} is opened as a folder.`); });
  cmd('gitKitchen.explorer.clearDefaultWorkspace', async (u: vscode.Uri) => { const d = { ...defaults() }; for (const [k, v] of Object.entries(d)) if (norm(v) === norm(u.fsPath) || k === norm(path.dirname(u.fsPath))) delete d[k];
    await ctx.globalState.update(DEFAULTS_KEY, d); await updateDefaultContext(); vscode.window.showInformationMessage('Default workspace cleared.'); });
}
async function maybeOpenDefaultWorkspace() {
  if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length !== 1) return;
  const f = defaults()[norm(vscode.workspace.workspaceFolders[0].uri.fsPath)];
  if (f && fs.existsSync(f)) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(f), { forceNewWindow: false });
}

// ---------- Annotations menu ----------
function registerAnnotations() {
  cmd('gitKitchen.annotations.heatmap', async () => setAnnot('heatmap'));
  cmd('gitKitchen.annotations.changes', async () => {
    if (annot === 'changes') { await setAnnot('changes'); return; }
    const ed = vscode.window.activeTextEditor; if (!ed) return; const r = await root();
    const hist = P.parseLog(await git(r, 'log', '-n', '200', `--format=${P.LOG_FORMAT}`, '--', rel(r, ed.document.fileName)));
    const pick = await vscode.window.showQuickPick([{ label: 'Working tree changes', description: 'since HEAD', sha: undefined as string | undefined },
      ...hist.map(c => ({ label: c.subject, description: `${c.short} · ${c.author} · ${P.relativeTime(Date.parse(c.date) / 1000)}`, sha: c.sha }))], { title: 'Show lines changed since…' });
    if (!pick) return; changesBase = pick.sha; await setAnnot('changes');
  });
  cmd('gitKitchen.annotations.settings', async () => vscode.commands.executeCommand('workbench.action.openSettings', 'gitKitchen'));
}

// ---------- Revision navigation ----------
function navTarget(): { r?: string; file: string; abs: string; sha?: string } | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const uri = tab?.input instanceof vscode.TabInputTextDiff ? tab.input.modified : tab?.input instanceof vscode.TabInputText ? tab.input.uri : vscode.window.activeTextEditor?.document.uri;
  if (!uri) return;
  if (uri.scheme === SCHEME) { const q = JSON.parse(uri.query); return { r: q.r, file: q.file, abs: path.join(q.r, q.file), sha: q.ref || undefined }; }
  if (uri.scheme === 'file') return { file: '', abs: uri.fsPath };
}
async function fileHistoryShas(r: string, file: string) { return P.parseNameList(await git(r, 'log', '--follow', '--format=%H', '--', file)); }
async function showRevision(r: string, file: string, hist: string[], right: string | 'working') {
  if (right === 'working') { if (hist[0]) await diffFile(r, hist[0], undefined, file); return; }
  const i = hist.indexOf(right); const left = hist[i + 1];
  await diffFile(r, left, right, file);
}
function registerNav() {
  const step = (dir: 'prev' | 'next') => async () => {
    const t = navTarget(); if (!t) return; const r = t.r ?? await repoRoot(path.dirname(t.abs)); if (!r) return; const file = t.file || rel(r, t.abs);
    const hist = await fileHistoryShas(r, file);
    const next = P.stepRevision(hist, t.sha, dir);
    if (!next) { vscode.window.setStatusBarMessage(dir === 'prev' ? 'No earlier revision' : 'Already at the working copy', 3000); return; }
    if (next === 'working' && dir === 'next') { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(r, file))); return; }
    await showRevision(r, file, hist, next);
  };
  cmd('gitKitchen.rev.prev', step('prev'));
  cmd('gitKitchen.rev.next', step('next'));
  cmd('gitKitchen.rev.choose', async () => {
    const t = navTarget(); if (!t) return; const r = t.r ?? await repoRoot(path.dirname(t.abs)); if (!r) return; const file = t.file || rel(r, t.abs);
    const cs = P.parseLog(await git(r, 'log', '--follow', `--format=${P.LOG_FORMAT}`, '--', file));
    const pick = await vscode.window.showQuickPick(cs.map(c => ({ label: c.subject, description: `${c.short} · ${c.author} · ${P.relativeTime(Date.parse(c.date) / 1000)}`, sha: c.sha, picked: c.sha === t.sha })), { title: `Revisions of ${path.basename(file)}`, matchOnDescription: true });
    if (pick) await showRevision(r, file, cs.map(c => c.sha), pick.sha);
  });
}

// ---------- Code lens ----------
const lensEmitter = new vscode.EventEmitter<void>();
const lensProvider: vscode.CodeLensProvider = {
  onDidChangeCodeLenses: lensEmitter.event,
  async provideCodeLenses(doc) {
    const cfg = vscode.workspace.getConfiguration('gitKitchen'); if (!cfg.get('codeLens.enabled', true)) return [];
    const b = await blameFor(doc); if (!b || !b.lines.length) return [];
    const ranges: vscode.Range[] = [new vscode.Range(0, 0, doc.lineCount - 1, 0)];
    if (cfg.get('codeLens.symbols', true)) {
      const syms = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', doc.uri).then(x => x ?? [], () => []);
      const want = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Class, vscode.SymbolKind.Method, vscode.SymbolKind.Interface, vscode.SymbolKind.Constructor]);
      const walk = (ss: any[], depth: number) => { for (const s of ss) { const range: vscode.Range = s.range ?? s.location?.range; if (want.has(s.kind) && range) ranges.push(range); if (s.children && depth < 2) walk(s.children, depth + 1); } };
      walk(syms, 0);
    }
    const lenses: vscode.CodeLens[] = [];
    for (const rg of ranges) {
      const sum = P.lensSummary(b.lines, rg.start.line + 1, rg.end.line + 1); if (!sum) continue;
      const at = new vscode.Range(rg.start.line, 0, rg.start.line, 0); const file = sum.latest.filename || rel(b.r, doc.fileName);
      lenses.push(new vscode.CodeLens(at, { title: sum.label, tooltip: sum.latest.summary, command: 'gitKitchen.openCommitDiff', arguments: [{ root: b.r, sha: sum.latest.sha, file }] }));
      lenses.push(new vscode.CodeLens(at, { title: sum.authorsLabel, tooltip: sum.authors.join(', '), command: 'gitKitchen.lens.blame', arguments: [] }));
    }
    return lenses;
  }
};
function registerLens() {
  cmd('gitKitchen.lens.blame', async () => { if (annot !== 'blame') await setAnnot('blame'); });
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider), lensEmitter,
    vscode.workspace.onDidSaveTextDocument(() => lensEmitter.fire()));
}

// ---------- activate ----------
export async function activate(c: vscode.ExtensionContext) {
  ctx = c;
  c.subscriptions.push(out, vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RefContent()));
  const view = (id: string, t: Tree) => { trees.push(t); const v = vscode.window.createTreeView(id, { treeDataProvider: t, showCollapseAll: true }); c.subscriptions.push(v); views[id] = v; return v; };
  view('gitKitchen.branches', new Tree(loadBranches));
  view('gitKitchen.remotes', new Tree(loadRemotes));
  view('gitKitchen.commits', new Tree(loadCommits));
  view('gitKitchen.stashes', new Tree(loadStashes, resolveStash));
  view('gitKitchen.worktrees', new Tree(loadWorktrees));
  view('gitKitchen.prs', new Tree(loadPrs));
  dualView = view('gitKitchen.dual', new Tree(loadDual));
  view('gitKitchen.merged', new Tree(loadMerged));
  view('gitKitchen.todos', new Tree(loadTodos));
  historyTree = new Tree(loadHistory); historyView = view('gitKitchen.history', historyTree);
  registerBranches(); registerRemotes(); registerStashes(); registerBlame(); registerHistory(); registerWorktrees(); registerPrs(); registerDual(); registerMerged(); registerExplorer();
  cmd('gitKitchen.commits.loadMore', async (key = 'commits') => { refLimits.set(key, (refLimits.get(key) ?? 50) + 50); refreshAll(); });
  cmd('gitKitchen.diffFile', async (r: string, l: string | undefined, rt: string | undefined, f: string, old?: string) => {
    await diffFile(r, l, rt, f, old); });
  registerNav(); registerAnnotations(); registerLens();
  c.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('gitKitchen')) { refreshAll(); scheduleBlame(); lensEmitter.fire(); } }));
  cmd('gitKitchen.refresh', async () => { prCache = undefined; branchPrCache = undefined; refreshAll(); updateRemoteContext(); });
  cmd('gitKitchen.operation.continue', () => runOperation('continue'));
  cmd('gitKitchen.operation.skip', () => runOperation('skip'));
  cmd('gitKitchen.operation.abort', () => runOperation('abort'));
  c.subscriptions.push(vscode.window.registerFileDecorationProvider(activeLabelDecorations), activeLabelEmitter,
    vscode.workspace.onDidChangeConfiguration(e => { if ((e.affectsConfiguration('gitKitchen.branches.colorLabels') || e.affectsConfiguration('gitKitchen.recentSyncMinutes'))) activeLabelEmitter.fire(undefined); }));
  await updateRemoteContext();
  await watchGitDir();
  // Refresh trees when the repo's HEAD or refs change.
  const w = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,refs/**,logs/refs/stash,worktrees/**}');
  let t: NodeJS.Timeout | undefined; const bump = () => { if (t) clearTimeout(t); t = setTimeout(refreshAll, 500); };
  c.subscriptions.push(w, w.onDidChange(bump), w.onDidCreate(bump), w.onDidDelete(bump), vscode.window.onDidChangeActiveTextEditor(bump));
  await updateDefaultContext();
  await vscode.commands.executeCommand('setContext', 'gitKitchen.gutterBlame', false);
  scheduleBlame();
  maybeOpenDefaultWorkspace();
}
async function updateRemoteContext() {
  const r = await currentRoot(); const n = r ? P.parseRemotes(await git(r, 'remote', '-v').catch(() => '')).length : 0;
  await vscode.commands.executeCommand('setContext', 'gitKitchen.multiRemote', n > 1);
  if (r) setDualHeader((await dualPair(r).catch(() => ({ pair: undefined }))).pair);
}
let gitDirWatcher: vscode.Disposable | undefined;
/** Watch the repository's own git dir (and the common dir for worktrees), which may live outside the workspace. */
async function watchGitDir() {
  const r = await currentRoot(); if (!r) return;
  const d = await gitDir(r).catch(() => ''); if (!d) return;
  const common = path.resolve(r, (await git(r, 'rev-parse', '--git-common-dir').catch(() => d)).trim());
  gitDirWatcher?.dispose();
  let t: NodeJS.Timeout | undefined;
  const bump = () => { if (t) clearTimeout(t); t = setTimeout(() => { refreshAll(); updateRemoteContext(); }, 300); };
  const ws = [vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(d), '{HEAD,index,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge,rebase-merge/**,rebase-apply,rebase-apply/**}'))];
  ws.push(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(common), '{config,packed-refs,refs/**}')));
  const subs = ws.flatMap(w => [w, w.onDidChange(bump), w.onDidCreate(bump), w.onDidDelete(bump)]);
  gitDirWatcher = vscode.Disposable.from(...subs); ctx.subscriptions.push(gitDirWatcher);
}
export function deactivate() {}

// Exposed for the smoke test.
const views: Record<string, vscode.TreeView<Node>> = {};
export const _test = { setBranchPrs: (prs: P.BranchPrInfo[]) => { mockBranchPrs = prs; }, branchDecorations: activeLabelDecorations, views, commitCard, statusTooltip: () => statusItem.tooltip, resolveCommitTooltip, refCommits, commitFiles, refLimits, operationState, runOperation, updateRemoteContext, loadDual, dualPair, dualDescription: () => dualView?.description, dualTitle: () => dualView?.title, status: () => ({ text: statusItem.text, command: statusItem.command }), changes: () => lastChanges, same: () => lastSame, hoverProvider, updateBlame, compareRefs, loadCommits, lensProvider, getAnnot: () => annot, navTarget, loadBranches, loadRemotes, loadStashes, loadWorktrees, loadTodos, loadMerged, blameFor };
