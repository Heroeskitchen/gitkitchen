// Pure parsers for git / gh output. No vscode imports so they run under Vitest.

export const SEP = '\x1f';

export interface Branch { name: string; current: boolean; upstream?: string; ahead: number; behind: number; gone: boolean; sha: string; subject: string; worktreePath?: string; time: number; author?: string; email?: string }
export const BRANCH_FORMAT = ['%(HEAD)', '%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)', '%(contents:subject)', '%(worktreepath)', '%(committerdate:unix)', '%(authorname)', '%(authoremail:trim)'].join(SEP);

export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const a = /ahead (\d+)/.exec(track); const b = /behind (\d+)/.exec(track);
  return { ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0, gone: track.includes('gone') };
}

export function parseBranches(out: string): Branch[] {
  return out.split('\n').filter(l => l.trim()).map(l => {
    const [head, name, upstream, track, sha, subject, wt, time, author, email] = l.split(SEP);
    return { name, current: head === '*', upstream: upstream || undefined, ...parseTrack(track || ''), sha, subject: subject ?? '', worktreePath: wt || undefined, time: +(time || 0), ...(author ? { author, email: (email ?? '').replace(/^<|>$/g, '') } : {}) };
  });
}

export interface Remote { name: string; fetchUrl: string; pushUrl?: string }
export function parseRemotes(out: string): Remote[] {
  const map = new Map<string, Remote>();
  for (const l of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(l);
    if (!m) continue;
    const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '' };
    if (m[3] === 'fetch') r.fetchUrl = m[2]; else r.pushUrl = m[2];
    map.set(m[1], r);
  }
  return [...map.values()];
}

/** Turn any GitHub remote URL into https://github.com/owner/repo */
export function githubWebUrl(remoteUrl: string): string | undefined {
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

export function commitLineUrl(web: string, sha: string, path: string, start: number, end?: number): string {
  const p = path.split('/').map(encodeURIComponent).join('/');
  return `${web}/blob/${sha}/${p}#L${start}${end && end !== start ? `-L${end}` : ''}`;
}

export interface Stash { index: number; ref: string; sha: string; message: string; date: string }
export const STASH_FORMAT = ['%gd', '%H', '%gs', '%cI'].join(SEP);
export function parseStashes(out: string): Stash[] {
  return out.split('\n').filter(l => l.trim()).map(l => {
    const [ref, sha, message, date] = l.split(SEP);
    const m = /\{(\d+)\}/.exec(ref);
    return { index: m ? +m[1] : 0, ref, sha, message, date };
  });
}

export interface Worktree { path: string; head?: string; branch?: string; bare: boolean; detached: boolean; locked: boolean; prunable: boolean; main: boolean }
export function parseWorktrees(out: string): Worktree[] {
  const res: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    if (!block.trim()) continue;
    const wt: Worktree = { path: '', bare: false, detached: false, locked: false, prunable: false, main: res.length === 0 };
    for (const line of block.split('\n')) {
      const [k, ...rest] = line.split(' '); const v = rest.join(' ');
      if (k === 'worktree') wt.path = v;
      else if (k === 'HEAD') wt.head = v;
      else if (k === 'branch') wt.branch = v.replace(/^refs\/heads\//, '');
      else if (k === 'bare') wt.bare = true;
      else if (k === 'detached') wt.detached = true;
      else if (k === 'locked') wt.locked = true;
      else if (k === 'prunable') wt.prunable = true;
    }
    res.push(wt);
  }
  return res;
}

export interface Commit { sha: string; short: string; author: string; email: string; date: string; subject: string; parents: string[] }
export const LOG_FORMAT = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%P'].join(SEP) + '\x1e';
export function parseLog(out: string): Commit[] {
  return out.split('\x1e').map(s => s.replace(/^\n+/, '')).filter(s => s.trim()).map(s => {
    const [sha, short, author, email, date, subject, parents] = s.split(SEP);
    return { sha, short, author, email, date, subject, parents: (parents ?? '').trim() ? parents.trim().split(' ') : [] };
  });
}

export interface BlameLine { line: number; sha: string; author: string; authorTime: number; summary: string; filename: string; uncommitted: boolean; origLine?: number }
/** Parse `git blame --porcelain` (or --incremental-like porcelain) into one entry per final line. */
export function parseBlamePorcelain(out: string): BlameLine[] {
  const info = new Map<string, { author: string; authorTime: number; summary: string; filename: string }>();
  const lines = out.split('\n'); const res: BlameLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const h = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(lines[i]);
    if (!h) { i++; continue; }
    const sha = h[1]; const origLine = +h[2]; const finalLine = +h[3];
    const meta = info.get(sha) ?? { author: '', authorTime: 0, summary: '', filename: '' };
    i++;
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const l = lines[i];
      if (l.startsWith('author ')) meta.author = l.slice(7);
      else if (l.startsWith('author-time ')) meta.authorTime = +l.slice(12);
      else if (l.startsWith('summary ')) meta.summary = l.slice(8);
      else if (l.startsWith('filename ')) meta.filename = l.slice(9);
      i++;
    }
    info.set(sha, meta);
    i++; // content line
    res.push({ line: finalLine, origLine, sha, ...meta, uncommitted: /^0+$/.test(sha) });
  }
  return res.sort((a, b) => a.line - b.line);
}

export function relativeTime(fromSec: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - fromSec));
  const units: [number, string][] = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [n, u] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? 's' : ''} ago`; }
  return 'just now';
}

export interface PullRequest { number: number; title: string; headRefName: string; baseRefName: string; url: string; isDraft: boolean; reviewDecision: string; author: string; checks: 'pass' | 'fail' | 'pending' | 'none'; mergeable: string; updatedAt?: string }
export const PR_FIELDS = 'number,title,headRefName,baseRefName,url,isDraft,reviewDecision,author,statusCheckRollup,mergeable,updatedAt';
export function summarizeChecks(rollup: any[] | undefined): PullRequest['checks'] {
  if (!rollup || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const v = String(c.conclusion ?? c.state ?? '').toUpperCase();
    const st = String(c.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(v)) return 'fail';
    if (v === '' || v === 'PENDING' || v === 'EXPECTED' || (st && st !== 'COMPLETED')) pending = true;
  }
  return pending ? 'pending' : 'pass';
}
export function parsePrs(json: string): PullRequest[] {
  const arr = JSON.parse(json || '[]') as any[];
  return arr.map(p => ({ number: p.number, title: p.title, headRefName: p.headRefName, baseRefName: p.baseRefName, url: p.url, isDraft: !!p.isDraft,
    reviewDecision: p.reviewDecision || '', author: p.author?.login ?? '', checks: summarizeChecks(p.statusCheckRollup), mergeable: p.mergeable ?? '', updatedAt: p.updatedAt }));
}
export function prBadge(p: PullRequest): string {
  const review = p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : p.reviewDecision === 'REVIEW_REQUIRED' ? 'review required' : '';
  return [`#${p.number}`, p.isDraft ? 'draft' : '', `checks ${p.checks}`, review].filter(Boolean).join(' · ');
}

/** Build a PR title/body from commit subjects (oldest first). */
export function prefillPr(branch: string, subjects: string[]): { title: string; body: string } {
  if (subjects.length === 1) return { title: subjects[0], body: '' };
  const title = branch.replace(/^[^/]+\//, '').replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
  return { title, body: subjects.map(s => `- ${s}`).join('\n') };
}

export interface TodoHit { file: string; line: number; tag: string; text: string }
export const TODO_RE = /\b(TODO|FIXME)\b[:\s]?(.*)$/;
/** Parse `git grep -n -I -E "\b(TODO|FIXME)\b"` output. */
export function parseTodos(out: string): TodoHit[] {
  const res: TodoHit[] = [];
  for (const l of out.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    const t = TODO_RE.exec(m[3]);
    if (!t) continue;
    res.push({ file: m[1], line: +m[2], tag: t[1], text: t[2].trim() });
  }
  return res;
}
export function groupByFile<T extends { file: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) { const a = m.get(it.file) ?? []; a.push(it); m.set(it.file, a); }
  return m;
}

/** Default worktree folder: <repo>/worktrees/<branch-with-slashes-flattened> */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  return `${repoRoot.replace(/[\\/]+$/, '')}/worktrees/${branch.replace(/[\\/]/g, '-')}`;
}

export function parseNameList(out: string): string[] { return out.split('\n').map(s => s.trim()).filter(Boolean); }

/** `git branch --merged main` output: strip markers, drop the base and current. */
export function parseMergedBranches(out: string, base: string): string[] {
  return out.split('\n').map(l => l.replace(/^[*+]?\s+/, '').trim()).filter(b => b && b !== base && !b.startsWith('('));
}

/** Simple name check matching git's main rules. */
export function isValidRefName(n: string): boolean {
  return !!n && !/[\s~^:?*\[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^\.|\/\.|\.$/.test(n) && n !== '@';
}

export interface TreeFolder<T> { kind: 'folder'; name: string; path: string; children: TreeEntry<T>[] }
export interface TreeLeaf<T> { kind: 'leaf'; name: string; item: T }
export type TreeEntry<T> = TreeFolder<T> | TreeLeaf<T>;
/**
 * Group names like `feat/a/b` into nested folders. Without `timeOf`, folders sort before leaves, each alphabetically.
 * With `timeOf`, entries sort newest first and a folder sorts by its newest descendant.
 */
export function groupByPrefix<T>(items: T[], nameOf: (t: T) => string, timeOf?: (t: T) => number): TreeEntry<T>[] {
  const root: TreeFolder<T> = { kind: 'folder', name: '', path: '', children: [] };
  for (const it of items) {
    const parts = nameOf(it).split('/'); let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      let f = cur.children.find((c): c is TreeFolder<T> => c.kind === 'folder' && c.path === p);
      if (!f) { f = { kind: 'folder', name: parts[i], path: p, children: [] }; cur.children.push(f); }
      cur = f;
    }
    cur.children.push({ kind: 'leaf', name: parts[parts.length - 1], item: it });
  }
  if (timeOf) {
    const newest = new Map<TreeEntry<T>, number>();
    const t = (e: TreeEntry<T>): number => { let v = newest.get(e); if (v === undefined) { v = e.kind === 'leaf' ? timeOf(e.item) || 0 : Math.max(0, ...e.children.map(t)); newest.set(e, v); } return v; };
    const byDate = (es: TreeEntry<T>[]): TreeEntry<T>[] => { es.sort((a, b) => t(b) - t(a) || a.name.localeCompare(b.name)); es.forEach(e => e.kind === 'folder' && byDate(e.children)); return es; };
    return byDate(root.children);
  }
  const sort = (es: TreeEntry<T>[]) => { es.sort((a, b) => a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)); es.forEach(e => e.kind === 'folder' && sort(e.children)); return es; };
  return sort(root.children);
}
export type SortBy = 'date' | 'name';
/** Order rows for any view: the current item first, then the rest by date (newest first) or by name. */
export function pinSort<T>(items: T[], o: { current: (t: T) => boolean; name: (t: T) => string; time: (t: T) => number; by: SortBy }): T[] {
  const cmp = o.by === 'name' ? (a: T, b: T) => o.name(a).localeCompare(o.name(b)) : (a: T, b: T) => o.time(b) - o.time(a) || o.name(a).localeCompare(o.name(b));
  return [...items.filter(o.current), ...items.filter(x => !o.current(x)).sort(cmp)];
}

/** Heatmap bucket 0 (newest) .. buckets-1 (oldest), on a log scale between the file's newest and oldest line. */
export function heatBucket(time: number, newest: number, oldest: number, buckets = 10): number {
  if (newest <= oldest) return 0;
  const span = Math.log1p(newest - oldest); const age = Math.log1p(Math.max(0, newest - time));
  return Math.min(buckets - 1, Math.max(0, Math.floor((age / span) * buckets)));
}

/**
 * Step through a file's history (newest first). `current` is the sha shown on the right of the diff,
 * or undefined for the working copy. Returns the new right-hand sha, 'working' or undefined if at the end.
 */
export function stepRevision(history: string[], current: string | undefined, dir: 'prev' | 'next'): string | 'working' | undefined {
  if (!history.length) return undefined;
  if (current === undefined) return dir === 'prev' ? history[0] : undefined;
  const i = history.indexOf(current); if (i < 0) return undefined;
  if (dir === 'prev') return history[i + 1];
  return i === 0 ? 'working' : history[i - 1];
}

/** Parse `git diff -U0` hunk headers into changed (added/modified) line numbers of the new side, 1-based. */
export function changedLines(diff: string): { added: number[]; deletedAfter: number[] } {
  const added: number[] = []; const deletedAfter: number[] = [];
  for (const l of diff.split('\n')) {
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l); if (!m) continue;
    const start = +m[2]; const count = m[3] === undefined ? 1 : +m[3];
    if (count === 0) deletedAfter.push(start); else for (let i = 0; i < count; i++) added.push(start + i);
  }
  return { added, deletedAfter };
}

export interface LensSummary { latest: BlameLine; authors: string[]; label: string; authorsLabel: string }
/** Summarize blame for a line range (1-based, inclusive) into a code lens label. Uncommitted lines are skipped. */
export function lensSummary(lines: BlameLine[], start: number, end: number, nowMs = Date.now()): LensSummary | undefined {
  const inRange = lines.filter(l => l.line >= start && l.line <= end && !l.uncommitted);
  if (!inRange.length) return undefined;
  const latest = inRange.reduce((a, b) => (b.authorTime > a.authorTime ? b : a));
  const counts = new Map<string, number>();
  for (const l of inRange) counts.set(l.author, (counts.get(l.author) ?? 0) + 1);
  const authors = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a);
  const shown = authors.slice(0, 3).join(', ') + (authors.length > 3 ? `, +${authors.length - 3}` : '');
  return { latest, authors, label: `${latest.author}, ${relativeTime(latest.authorTime, nowMs)}`,
    authorsLabel: `${authors.length} ${authors.length === 1 ? 'author' : 'authors'} (${shown})` };
}

export interface LineChanges { added: number[]; modified: number[]; deletedAfter: number[] }
/** Classify `git diff -U0` hunks into added, modified and deleted lines (new side, 1-based). */
export function classifyChanges(diff: string): LineChanges {
  const res: LineChanges = { added: [], modified: [], deletedAfter: [] };
  for (const l of diff.split('\n')) {
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l); if (!m) continue;
    const oldCount = m[1] === undefined ? 1 : +m[1]; const start = +m[2]; const count = m[3] === undefined ? 1 : +m[3];
    if (count === 0) { res.deletedAfter.push(start); continue; }
    const modified = Math.min(oldCount, count);
    for (let i = 0; i < count; i++) (i < modified ? res.modified : res.added).push(start + i);
    if (oldCount > count) res.deletedAfter.push(start + count - 1);
  }
  return res;
}

/** Final line numbers (1-based) of other lines blamed to the same commit as `line`. Empty for uncommitted lines. */
export function sameCommitLines(lines: BlameLine[], line: number): number[] {
  const cur = lines.find(l => l.line === line); if (!cur || cur.uncommitted) return [];
  return lines.filter(l => l.sha === cur.sha && l.line !== line).map(l => l.line);
}

/** From a unified diff of one file, return the hunk (header and body) whose new side contains `newLine`. */
export function hunkForLine(diff: string, newLine: number): string | undefined {
  const lines = diff.split('\n'); let cur: string[] | undefined; let hit = false;
  for (const l of lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      if (cur && hit) break;
      const start = +m[1]; const count = m[2] === undefined ? 1 : +m[2];
      cur = [l]; hit = newLine >= start && newLine < start + Math.max(count, 1);
    } else if (cur && !l.startsWith('\\')) {
      if (/^(diff |index |--- |\+\+\+ )/.test(l) && !hit) { cur = undefined; continue; }
      if (/^[ +-]/.test(l) || l === '') cur.push(l);
    }
  }
  if (!cur || !hit) return undefined;
  while (cur.length > 1 && cur[cur.length - 1] === '') cur.pop();
  return cur.join('\n');
}

/** Status bar text for a blamed line. */
export function statusBarText(bl: BlameLine | undefined, nowMs = Date.now()): string | undefined {
  if (!bl) return undefined;
  return bl.uncommitted ? '$(git-commit) You, uncommitted' : `$(git-commit) ${bl.author}, ${relativeTime(bl.authorTime, nowMs)}`;
}

export type Freshness = 'fresh' | 'aging' | 'stale';
export interface StalenessOptions { agingDays: number; staleDays: number; behindCount: number }
export const DEFAULT_STALENESS: StalenessOptions = { agingDays: 14, staleDays: 60, behindCount: 20 };
/** Classify a branch by how far behind it is and how old its last commit is. */
export function freshness(behind: number, lastCommitSec: number, nowMs = Date.now(), o: StalenessOptions = DEFAULT_STALENESS): { state: Freshness; ageDays: number; reason: string } {
  const ageDays = Math.max(0, Math.floor((nowMs / 1000 - lastCommitSec) / 86400));
  const state: Freshness = behind > o.behindCount || ageDays > o.staleDays ? 'stale' : behind >= 1 || ageDays >= o.agingDays ? 'aging' : 'fresh';
  return { state, ageDays, reason: `${behind} behind · last commit ${ageDays}d ago · ${state}` };
}

export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert';
export interface OperationState { kind: OperationKind; label: string; step?: number; total?: number; onto?: string; canSkip: boolean }
/** Detect an in-progress operation from files in the git dir. `read` returns the file content (trimmed) or undefined when missing. */
export function detectOperation(read: (rel: string) => string | undefined): OperationState | undefined {
  const exists = (f: string) => read(f) !== undefined;
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    if (dir === 'rebase-apply' && exists('rebase-apply/applying')) continue; // `git am`, not a rebase
    if (exists(`${dir}/head-name`) || exists(`${dir}/onto`) || exists(`${dir}/msgnum`) || exists(`${dir}/next`)) {
      const step = +(read(`${dir}/msgnum`) ?? read(`${dir}/next`) ?? '') || undefined;
      const total = +(read(`${dir}/end`) ?? read(`${dir}/last`) ?? '') || undefined;
      const head = (read(`${dir}/head-name`) ?? '').replace(/^refs\/heads\//, '');
      return { kind: 'rebase', label: `Rebasing${head ? ' ' + head : ''}${step && total ? ` (${step}/${total})` : ''}`, step, total, onto: read(`${dir}/onto`), canSkip: true };
    }
  }
  if (exists('MERGE_HEAD')) return { kind: 'merge', label: 'Merging', canSkip: false };
  if (exists('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick', label: `Cherry-picking ${read('CHERRY_PICK_HEAD')!.slice(0, 7)}`, canSkip: false };
  if (exists('REVERT_HEAD')) return { kind: 'revert', label: `Reverting ${read('REVERT_HEAD')!.slice(0, 7)}`, canSkip: false };
  return undefined;
}

/**
 * Choose which two remotes to compare. A saved pair wins when both remotes still exist. With exactly two remotes the
 * base is origin if present, otherwise the current branch's upstream remote, otherwise the first alphabetically.
 * With three or more remotes and no saved pair the user has to choose, so this returns undefined.
 */
export function pickDualPair(remotes: string[], saved: { source?: string; target?: string }, upstreamRemote?: string): { source: string; target: string } | undefined {
  const rs = [...new Set(remotes)];
  if (rs.length < 2) return undefined;
  if (saved.source && saved.target && saved.source !== saved.target && rs.includes(saved.source) && rs.includes(saved.target)) return { source: saved.source, target: saved.target };
  if (rs.length !== 2) return undefined;
  const sorted = [...rs].sort((a, b) => a.localeCompare(b));
  const source = rs.includes('origin') ? 'origin' : upstreamRemote && rs.includes(upstreamRemote) ? upstreamRemote : sorted[0];
  return { source, target: rs.find(r => r !== source)! };
}

export interface BranchPrInfo { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean; headRefName: string }
export function parseBranchPrs(json: string): BranchPrInfo[] {
  try { return (JSON.parse(json) as any[]).map(p => ({ number: p.number, state: String(p.state).toUpperCase() as BranchPrInfo['state'], isDraft: !!p.isDraft, headRefName: p.headRefName })); } catch { return []; }
}
/** The PR that best describes a branch: an open one first, then the most recent merged one. */
export function prForBranch(prs: BranchPrInfo[], branch: string): BranchPrInfo | undefined {
  const mine = prs.filter(p => p.headRefName === branch).sort((a, b) => b.number - a.number);
  return mine.find(p => p.state === 'OPEN') ?? mine.find(p => p.state === 'MERGED');
}
/** Icon and state text for a branch row, by priority: merged, draft PR, open PR, worktree, branch. */
export function branchState(b: { current: boolean; pr?: BranchPrInfo; mergedInto?: string; worktree: boolean }): { icon: string; state?: string } {
  const cur = b.current ? 'Current branch' : undefined; const join = (s: string) => cur ? `${cur} · ${s}` : s;
  if (b.pr?.state === 'MERGED') return { icon: 'git-merge', state: join(`PR #${b.pr.number} merged`) };
  if (b.mergedInto && !b.current) return { icon: 'git-merge', state: `Merged into ${b.mergedInto}` };
  if (b.pr?.state === 'OPEN') return b.pr.isDraft ? { icon: 'git-pull-request-draft', state: join(`PR #${b.pr.number} draft`) } : { icon: 'git-pull-request', state: join(`PR #${b.pr.number} open`) };
  if (b.worktree && !b.current) return { icon: 'worktree', state: 'Checked out in a worktree' };
  return { icon: 'git-branch', state: cur };
}

/** Merge chains of folders that hold exactly one folder (a, a/b, a/b/c → "a/b/c"), like a compact explorer. */
export function compactFolders<T>(entries: TreeEntry<T>[]): TreeEntry<T>[] {
  return entries.map(e => {
    if (e.kind === 'leaf') return e;
    let f: TreeFolder<T> = e;
    while (f.children.length === 1 && f.children[0].kind === 'folder') {
      const c = f.children[0] as TreeFolder<T>; f = { kind: 'folder', name: `${f.name}/${c.name}`, path: c.path, children: c.children };
    }
    return { ...f, children: compactFolders(f.children) };
  });
}
/** Build a compact folder tree of changed files by their path. */
export function buildPathTree<T>(items: T[], pathOf: (t: T) => string, compact = true): TreeEntry<T>[] {
  const t = groupByPrefix(items, pathOf); return compact ? compactFolders(t) : t;
}
export interface ChangedFile { status: string; path: string; oldPath?: string }
/** Parse `git diff-tree --name-status` output. Status is the first letter (M, A, D, R, C, T). */
export function parseNameStatus(out: string): ChangedFile[] {
  return parseNameList(out).map(l => { const parts = l.split('\t'); return { status: parts[0][0], path: parts[parts.length - 1], oldPath: parts.length > 2 ? parts[1] : undefined }; });
}

export interface CommitDetails { sha: string; author: string; email: string; time: number; message: string; filesAdded: number; filesChanged: number; filesDeleted: number; additions: number; deletions: number }
export const DETAILS_FORMAT = ['%H', '%an', '%ae', '%at', '%B'].join(SEP) + '\x1e';
/** Parse `git show --format=DETAILS_FORMAT --numstat --summary <sha>`. */
export function parseCommitDetails(out: string): CommitDetails | undefined {
  const cut = out.indexOf('\x1e'); if (cut < 0) return undefined;
  const [sha, author, email, time, ...rest] = out.slice(0, cut).split(SEP);
  if (!sha) return undefined;
  const s = parseCommitStats(out.slice(cut + 1));
  return { sha: sha.trim(), author, email, time: +time, message: rest.join(SEP).trim(), ...s };
}
/** Count files added/changed/deleted and line additions/deletions from `--numstat --summary` output. */
export function parseCommitStats(out: string): Pick<CommitDetails, 'filesAdded' | 'filesChanged' | 'filesDeleted' | 'additions' | 'deletions'> {
  let files = 0, filesAdded = 0, filesDeleted = 0, additions = 0, deletions = 0;
  for (const l of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(l);
    if (m) { files++; if (m[1] !== '-') additions += +m[1]; if (m[2] !== '-') deletions += +m[2]; continue; }
    if (/^ create mode /.test(l)) filesAdded++; else if (/^ delete mode /.test(l)) filesDeleted++;
  }
  return { filesAdded, filesDeleted, filesChanged: Math.max(0, files - filesAdded - filesDeleted), additions, deletions };
}
/** Link `#123` references to pull requests on the GitHub remote. */
export function linkPrRefs(text: string, web?: string): string {
  return web ? text.replace(/(^|[^\w&/])#(\d+)\b/g, (_m, pre, n) => `${pre}[#${n}](${web}/pull/${n})`) : text;
}
/** Avatar for a GitHub noreply address, without a network call. */
export function noreplyAvatar(email: string): string | undefined {
  const m = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email); return m ? `https://avatars.githubusercontent.com/u/${m[1]}?s=32` : undefined;
}
function escapeMd(s: string): string { return s.replace(/([\\`*_{}[\]<>()!|])/g, '\\$1'); }
/** Markdown for a commit card: avatar, author, relative and exact time, short sha, file and line stats, message, remote branches. */
export function commitCardMarkdown(d: CommitDetails, o: { nowMs?: number; web?: string; avatar?: string; remoteBranches?: string[]; copyCommand?: string; dateText?: string } = {}): string {
  const rel = relativeTime(d.time, o.nowMs);
  const date = o.dateText ?? new Date(d.time * 1000).toLocaleString();
  const who = `${o.avatar ? `<img src="${o.avatar}" width="16" height="16"/> ` : '$(account) '}**${escapeMd(d.author)}**`;
  const sha = d.sha.slice(0, 7);
  const shaPart = o.copyCommand ? `[$(git-commit) \`${sha}\`](${o.copyCommand} "Copy SHA")` : `$(git-commit) \`${sha}\``;
  const files = `$(files) +${d.filesAdded} ~${d.filesChanged} -${d.filesDeleted}`;
  const lines = `<span style="color:#3fb950;">+${d.additions}</span> <span style="color:#f85149;">-${d.deletions}</span>`;
  const msg = linkPrRefs(escapeMd(d.message).replace(/\n/g, '  \n'), o.web);
  const branches = (o.remoteBranches ?? []).map(b => `\`${b}\``).join(' ');
  return `${who}, ${rel} (${date}) · ${shaPart} · ${files} · ${lines}\n\n${msg}${branches ? `\n\n$(cloud) ${branches}` : ''}`;
}
export const sortBranches = pinSort;
/** Branch row description: `⇄ origin/main • 14 hours ago`, `21↓ 0↑ ⇄ origin/main • ...` when out of sync, or `no upstream • ...`, plus any extras. */
export function branchDescription(b: { upstream?: string; ahead?: number; behind?: number; gone?: boolean }, when: string, extras: string[] = []): string {
  const out = !b.gone && (!!b.ahead || !!b.behind);
  const up = !b.upstream ? 'no upstream' : b.gone ? `⇄ ${b.upstream} gone` : `${out ? `${b.behind ?? 0}↓ ${b.ahead ?? 0}↑ ` : ''}⇄ ${b.upstream}`;
  return [up, when, ...extras].filter(Boolean).join(' • ');
}
/** Tooltip line for a branch that is out of sync with its upstream. */
export function syncText(b: { upstream?: string; ahead?: number; behind?: number }, tone?: SyncTone): string {
  const base = `${b.behind ?? 0} behind, ${b.ahead ?? 0} ahead of ${b.upstream}`;
  return tone === 'behind' ? `${base} (pull needed)` : tone === 'ahead' ? `${base} (unpushed commits)` : tone === 'synced' ? `${base} (in sync, pushed or pulled recently)` : base;
}
export type SyncTone = 'synced' | 'ahead' | 'behind' | '';
/** Branch sync color: red when behind (incl. diverged), yellow when only ahead, green when in sync and synced recently. */
export function syncTone(b: { upstream?: string; ahead?: number; behind?: number; gone?: boolean }, lastSyncSec: number | undefined, nowMs: number, recentMinutes: number): SyncTone {
  if (!b.upstream || b.gone) return '';
  if ((b.behind ?? 0) > 0) return 'behind';
  if ((b.ahead ?? 0) > 0) return 'ahead';
  return lastSyncSec !== undefined && nowMs / 1000 - lastSyncSec <= recentMinutes * 60 ? 'synced' : '';
}
/** Parse `git reflog show -n1 --date=unix --format=%gd <ref>` (`origin/main@{1793438142}`). */
export function parseReflogTime(out: string): number | undefined {
  const m = /@\{(\d+)\}\s*$/.exec(out.trim()); return m ? +m[1] : undefined;
}

export function emailHash(email: string): string {
  return require('crypto').createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}
export function gravatarUrl(email: string): string { return `https://www.gravatar.com/avatar/${emailHash(email)}?s=32&d=404`; }
export function initials(name: string, email = ''): string {
  const words = (name || email.split('@')[0]).replace(/[^\p{L}\p{N}\s._-]/gu, '').split(/[\s._-]+/).filter(Boolean);
  const s = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2);
  return s.toUpperCase();
}
/** Stable hue from the email so one author keeps one color. */
export function avatarColor(email: string): string {
  let h = 0; for (const ch of email.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `hsl(${h % 360}, 55%, 45%)`;
}
export function initialsSvg(name: string, email: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${avatarColor(email)}"/>`
    + `<text x="8" y="11" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="7" font-weight="600" fill="#fff">${esc(initials(name, email))}</text></svg>`;
}
/** GraphQL query fetching several commit authors' avatars in one request. */
export function avatarQuery(owner: string, repo: string, shas: string[]): string {
  const fields = shas.map((s, i) => `c${i}: object(oid: "${s.replace(/[^0-9a-f]/gi, '')}") { ... on Commit { author { avatarUrl(size: 32) } } }`).join(' ');
  return `query { repository(owner: "${owner}", name: "${repo}") { ${fields} } }`;
}
export function parseAvatarQuery(json: string, count: number): (string | undefined)[] {
  let repo: any; try { repo = JSON.parse(json)?.data?.repository; } catch { /* bad output */ }
  return Array.from({ length: count }, (_, i) => repo?.[`c${i}`]?.author?.avatarUrl || undefined);
}

// ---- Hover cards -------------------------------------------------------------------------------
export interface CardAction { icon: string; label?: string; tip: string; command?: string; args?: unknown; url?: string }
export function cmdUri(command: string, args?: unknown): string {
  return `command:${command}${args === undefined ? '' : `?${encodeURIComponent(JSON.stringify([args]))}`}`;
}
function actionLink(a: CardAction): string {
  const target = a.url ?? cmdUri(a.command!, a.args);
  return `[$(${a.icon})${a.label ? ' ' + a.label : ''}](${target} "${a.tip.replace(/"/g, "'")}")`;
}
export function actionBar(actions: CardAction[]): string { return actions.map(actionLink).join('&nbsp;&nbsp;'); }
/** Shared tooltip card: icon or avatar + bold title, a status line, detail lines, then an action bar. */
export function mdCard(c: { title: string; icon?: string; avatar?: string; status?: string; details?: string[]; body?: string; actions?: CardAction[] }): string {
  const lead = c.avatar ? `<img src="${c.avatar}" width="16" height="16"/> ` : c.icon ? `$(${c.icon}) ` : '';
  const out = [`${lead}**${escapeMd(c.title)}**`];
  if (c.status) out.push(c.status);
  if (c.details?.length) out.push(c.details.join('  \n'));
  if (c.body) out.push(c.body);
  if (c.actions?.length) out.push('---', actionBar(c.actions));
  return out.join('\n\n');
}
/** A commit message as markdown: HTML neutralized, #123 linked, Co-authored-by lines as mailto links. */
export function messageMarkdown(message: string, web?: string): string {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const co = safe.replace(/^(Co-authored-by:\s*)(.+?)\s*&lt;([^&\s]+@[^&\s]+)&gt;\s*$/gim, (_m, k, name, mail) => `${k}[${name}](mailto:${mail})`);
  return linkPrRefs(co, web).split('\n').map(l => l.replace(/\s+$/, '')).join('  \n').replace(/ {2}\n {2}\n/g, '\n\n');
}
export function prNumberFromMessage(message: string): number | undefined {
  const m = /\(#(\d+)\)|Merge pull request #(\d+)/.exec(message); return m ? +(m[1] ?? m[2]) : undefined;
}
/** Editor blame hover in the GitLens layout. */
export function blameHoverMarkdown(d: CommitDetails, o: { avatar?: string; web?: string; nowMs?: number; dateText?: string; root: string; file?: string; line?: number; hunk?: string }): string {
  const sha = d.sha.slice(0, 7); const at = { root: o.root, sha: d.sha };
  const who = `${o.avatar ? `<img src="${o.avatar}" width="16" height="16"/> ` : '$(account) '}**${escapeMd(d.author)}**${o.web ? ' $(github)' : ''}`;
  const when = `$(history) ${relativeTime(d.time, o.nowMs)} (${o.dateText ?? new Date(d.time * 1000).toLocaleString()})`;
  const copy = `<span style="float:right;">${actionLink({ icon: 'copy', tip: 'Copy SHA', command: 'gitKitchen.commit.copySha', args: { sha: d.sha } })}</span>`;
  const parts = [`${who}&nbsp;&nbsp;${when}${copy}`, messageMarkdown(d.message, o.web)];
  const pr = prNumberFromMessage(d.message);
  if (pr && o.web) parts.push(`$(git-pull-request) [GitHub Issue or Pull Request #${pr}](${o.web}/pull/${pr})`);
  const fa = { ...at, file: o.file, line: o.line };
  const actions: CardAction[] = [
    { icon: 'git-commit', label: sha, tip: 'Copy SHA', command: 'gitKitchen.commit.copySha', args: { sha: d.sha } },
    { icon: 'copy', tip: 'Copy Message', command: 'gitKitchen.commit.copyMessage', args: at },
    ...(o.web ? [{ icon: 'globe', tip: 'Open Commit on Remote', command: 'gitKitchen.commit.openOnRemote', args: at }] : []),
    { icon: 'search', tip: 'Search Commits by This SHA', command: 'gitKitchen.commit.search', args: { ...at, direct: true } },
    { icon: 'list-tree', tip: 'Show in Commits View', command: 'gitKitchen.commit.reveal', args: at },
    ...(o.file ? [
      { icon: 'git-compare', tip: 'Open Changes for This File', command: 'gitKitchen.openCommitDiff', args: { ...at, file: o.file } },
      { icon: 'files', tip: 'Open All Changes in Commit', command: 'gitKitchen.openCommitDiff', args: at },
      { icon: 'diff', tip: 'Compare Working File with Previous Revision', command: 'gitKitchen.blame.comparePrevious', args: fa },
      { icon: 'file-code', tip: 'Open File at This Revision', command: 'gitKitchen.blame.openRevision', args: fa },
      { icon: 'history', tip: 'Blame Previous Revision', command: 'gitKitchen.blame.previous', args: fa },
    ] : [{ icon: 'git-compare', tip: 'Open Changes', command: 'gitKitchen.openCommitDiff', args: at }]),
  ];
  parts.push('---', actionBar(actions), '---');
  if (o.hunk) parts.push('```diff\n' + o.hunk + '\n```', `Changes added in ${actionLink({ icon: 'git-commit', label: sha, tip: 'Open Changes', command: 'gitKitchen.openCommitDiff', args: { ...at, file: o.file } })}`);
  return parts.join('\n\n');
}
export function branchCardMarkdown(b: Branch, o: { state?: string; syncText?: string; freshness?: string; when?: string; avatar?: string; author?: string; pr?: { number: number; state: string; url?: string }; root: string }): string {
  const details = [
    b.upstream ? `$(cloud) ${b.gone ? `~~${escapeMd(b.upstream)}~~ (gone)` : escapeMd(b.upstream)}${!b.gone ? ` · $(arrow-down) ${b.behind} $(arrow-up) ${b.ahead}` : ''}` : '$(cloud) no upstream',
    `${o.avatar ? `<img src="${o.avatar}" width="14" height="14"/>` : '$(git-commit)'} \`${b.sha}\` ${escapeMd(b.subject)}${o.author ? ` — ${escapeMd(o.author)}` : ''}${o.when ? `, ${o.when}` : ''}`,
    ...(o.pr ? [`$(git-pull-request) ${o.pr.url ? `[PR #${o.pr.number}](${o.pr.url})` : `PR #${o.pr.number}`} ${o.pr.state.toLowerCase()}`] : []),
    ...(b.worktreePath && !b.current ? [`$(worktree) ${escapeMd(b.worktreePath)}`] : []),
    ...(o.freshness ? [`$(pulse) ${o.freshness}`] : []),
  ];
  return mdCard({ title: b.name, icon: 'git-branch', status: [o.state, o.syncText].filter(Boolean).join(' · ') || undefined, details,
    actions: [{ icon: 'git-compare', tip: 'Compare with HEAD', command: 'gitKitchen.branch.compareHead', args: { data: { branch: b } } }, { icon: 'copy', tip: 'Copy Name', command: 'gitKitchen.copyText', args: b.name }] });
}
export function stashCardMarkdown(s: Stash, o: { branch?: string; dateText: string; when: string; files: number; insertions: number; deletions: number }): string {
  return mdCard({ title: s.message, icon: 'archive', status: `${s.ref}${o.branch ? ` · on \`${escapeMd(o.branch)}\`` : ''}`,
    details: [`$(history) ${o.when} (${o.dateText})`, `$(files) ${o.files} file${o.files === 1 ? '' : 's'} · <span style="color:#3fb950;">+${o.insertions}</span> <span style="color:#f85149;">-${o.deletions}</span>`],
    actions: [{ icon: 'check', label: 'Apply', tip: 'Apply Stash', command: 'gitKitchen.stash.applyRef', args: s.ref }, { icon: 'copy', tip: 'Copy Message', command: 'gitKitchen.copyText', args: s.message }] });
}
export function worktreeCardMarkdown(w: Worktree, o: { dirty: boolean; subject?: string }): string {
  return mdCard({ title: w.branch ?? (w.detached ? 'detached HEAD' : w.path), icon: 'worktree', status: `${o.dirty ? '$(circle-filled) uncommitted changes' : '$(check) clean'}${w.locked ? ' · $(lock) locked' : ''}${w.main ? ' · main worktree' : ''}`,
    details: [`$(folder) ${escapeMd(w.path)}`, ...(w.head ? [`$(git-commit) \`${w.head.slice(0, 7)}\` ${escapeMd(o.subject ?? '')}`] : [])],
    actions: [{ icon: 'copy', tip: 'Copy Path', command: 'gitKitchen.copyText', args: w.path }] });
}
export function remoteCardMarkdown(o: { name: string; fetchUrl: string; pushUrl: string; branches: number; web?: string }): string {
  return mdCard({ title: o.name, icon: 'cloud', status: `${o.branches} branch${o.branches === 1 ? '' : 'es'}`,
    details: [`$(arrow-down) fetch ${escapeMd(o.fetchUrl)}`, `$(arrow-up) push ${escapeMd(o.pushUrl)}`],
    actions: [...(o.web ? [{ icon: 'globe', tip: 'Open on Remote', url: o.web }] : []), { icon: 'copy', tip: 'Copy URL', command: 'gitKitchen.copyText', args: o.fetchUrl }] });
}
export function prCardMarkdown(p: PullRequest, o: { avatar?: string } = {}): string {
  const checks = { pass: '$(pass) checks passing', fail: '$(error) checks failing', pending: '$(clock) checks pending', none: '$(circle-slash) no checks' }[p.checks];
  return mdCard({ title: `#${p.number} ${p.title}`, avatar: o.avatar, icon: p.isDraft ? 'git-pull-request-draft' : 'git-pull-request',
    status: `${p.isDraft ? 'Draft' : 'Open'} · by ${escapeMd(p.author)}${p.reviewDecision ? ` · ${p.reviewDecision.toLowerCase().replace(/_/g, ' ')}` : ''}`,
    details: [checks, `$(git-merge) \`${escapeMd(p.baseRefName)}\` ← \`${escapeMd(p.headRefName)}\``, ...(p.mergeable && p.mergeable !== 'UNKNOWN' ? [`mergeable: ${p.mergeable.toLowerCase()}`] : [])],
    actions: [{ icon: 'globe', label: 'Open on GitHub', tip: p.url, url: p.url }] });
}
export function syncGroupCardMarkdown(kind: 'Incoming' | 'Outgoing', count: number, branch: string, upstream: string): string {
  const verb = kind === 'Incoming' ? `to pull from \`${escapeMd(upstream)}\` into \`${escapeMd(branch)}\`` : `to push from \`${escapeMd(branch)}\` to \`${escapeMd(upstream)}\``;
  return mdCard({ title: kind, icon: kind === 'Incoming' ? 'cloud-download' : 'cloud-upload', status: `${count} commit${count === 1 ? '' : 's'} ${verb}` });
}
