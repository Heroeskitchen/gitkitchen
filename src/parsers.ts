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

/** Default worktree folder: <parent of repo>/<repo folder name>.worktrees/<branch with / and \ replaced by ->. */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const root = repoRoot.replace(/[\\/]+$/, '');
  const idx = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
  const sep = idx >= 0 && root[idx] === '\\' ? '\\' : '/';
  const parent = idx > 0 ? root.slice(0, idx) : idx === 0 ? sep : '';
  const folder = idx >= 0 ? root.slice(idx + 1) : root;
  const leaf = `${folder}.worktrees${sep}${branch.replace(/[\\/]/g, '-')}`;
  return parent.endsWith(sep) ? `${parent}${leaf}` : parent ? `${parent}${sep}${leaf}` : leaf;
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

export interface DiffSlice { text: string; total: number; hidden: number }
interface DiffRow { text: string; newNo?: number; at: number }
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_BOUNDARY = /^(diff |index |--- |\+\+\+ |new file |deleted file |similarity |rename |Binary )/;
/** Changed +/- lines nearest `newLine`: one contiguous run, no @@ header and no context. At most 6 lines, or the whole run when it is 7–10 lines. */
export function diffSliceForLine(diff: string, newLine: number): DiffSlice | undefined {
  const lines = diff.split('\n');
  let best: { rows: DiffRow[]; dist: number } | undefined;
  let i = 0;
  while (i < lines.length) {
    const m = HUNK_HEADER.exec(lines[i]);
    if (!m) { i++; continue; }
    const newStart = +m[3]; const newCount = m[4] === undefined ? 1 : +m[4];
    const covers = newLine >= newStart && newLine < newStart + Math.max(newCount, 1);
    const runs: DiffRow[][] = []; let rows: DiffRow[] = []; let n = newStart;
    i++;
    while (i < lines.length && !lines[i].startsWith('@@') && !DIFF_BOUNDARY.test(lines[i])) {
      const l = lines[i++];
      if (l.startsWith('\\') || l === '') continue;
      if (l.startsWith('+')) { rows.push({ text: l, newNo: n, at: n }); n++; }
      else if (l.startsWith('-')) rows.push({ text: l, at: n });
      else if (l.startsWith(' ')) { if (rows.length) { runs.push(rows); rows = []; } n++; }
      else { i--; break; }
    }
    if (rows.length) runs.push(rows);
    if (!covers) continue;
    for (const run of runs) {
      let dist = Infinity;
      for (const r of run) { if (r.newNo === newLine) { dist = 0; break; } dist = Math.min(dist, Math.abs((r.newNo ?? r.at) - newLine)); }
      if (!best || dist < best.dist) best = { rows: run, dist };
    }
  }
  if (!best) return undefined;
  const shown = capDiffRows(best.rows, newLine);
  return { text: shown.map(r => r.text).join('\n'), total: best.rows.length, hidden: best.rows.length - shown.length };
}
function capDiffRows(rows: DiffRow[], newLine: number): DiffRow[] {
  const cap = rows.length <= 10 ? rows.length : 6;
  if (rows.length <= cap) return rows;
  let idx = rows.findIndex(r => r.newNo === newLine);
  if (idx < 0) {
    let bestD = Infinity;
    rows.forEach((r, i) => {
      const d = Math.abs((r.newNo ?? r.at) - newLine);
      if (d < bestD || (d === bestD && (r.newNo ?? r.at) <= newLine)) { idx = i; bestD = d; }
    });
  }
  let start = idx - Math.floor((cap - 1) / 2);
  if (start < 0) start = 0;
  if (start + cap > rows.length) start = rows.length - cap;
  return rows.slice(start, start + cap);
}
/** Changed lines from the hunk covering `newLine`, capped the same way as the blame hover. */
export function hunkForLine(diff: string, newLine: number): string | undefined {
  return diffSliceForLine(diff, newLine)?.text;
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
const CO_AUTHOR_ESCAPED = /^Co-authored-by:[ \t]*(.+?)[ \t]*&lt;([^&\s]+@[^&\s]+)&gt;[ \t]*$/i;
const CO_AUTHOR_RAW = /^Co-authored-by:[ \t]*(.+?)[ \t]*<([^>\s]+@[^>\s]+)>[ \t]*$/i;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function isRuleLine(line: string): boolean {
  const compact = line.trim().replace(/[ \t]/g, '');
  return compact.length > 0 && (/^-+$/.test(compact) || /^=+$/.test(compact));
}
/** A GitHub login: letters, digits, and single hyphens, not all digits. */
export function githubLogin(name: string | undefined): string | undefined {
  const login = name?.trim();
  return login && GITHUB_LOGIN.test(login) && !/^\d+$/.test(login) ? login : undefined;
}
/** GitHub login from `id+login@users.noreply.github.com` or `login@users.noreply.github.com`. */
export function githubLoginFromEmail(email: string): string | undefined {
  const m = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})@users\.noreply\.github\.com$/i.exec(email.trim());
  return githubLogin(m?.[1]);
}
function githubProfile(email: string, web?: string, login?: string): string | undefined {
  if (!web || !/^https:\/\/github\.com\//i.test(web)) return;
  const name = githubLoginFromEmail(email) ?? githubLogin(login);
  return name ? `https://github.com/${name}` : undefined;
}
/** Local long date: `October 12th, 2026 11:10 AM`. */
export function longDate(sec: number): string {
  const d = new Date(sec * 1000);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(d);
  const day = d.getDate();
  const n = day % 100;
  const suf = n >= 11 && n <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] || 'th';
  const year = d.getFullYear();
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(d).replace(/[\u202f\u00a0]/g, ' ');
  return `${month} ${day}${suf}, ${year} ${time}`;
}
export interface CoAuthor { name: string; email: string }
/** Unique co-authors in first-seen order. Trailing spaces stop at the end of the line. */
export function coAuthors(message: string): CoAuthor[] {
  const seen = new Set<string>(); const out: CoAuthor[] = [];
  for (const line of message.split('\n')) {
    const m = CO_AUTHOR_RAW.exec(line.replace(/\r$/, '')); if (!m) continue;
    const key = m[2].toLowerCase(); if (seen.has(key)) continue;
    seen.add(key); out.push({ name: m[1].trim(), email: m[2] });
  }
  return out;
}
const muted = (inner: string) => `<span style="color:var(--vscode-descriptionForeground);">${inner}</span>`;
const GROUP_SEP = `&nbsp;&nbsp;${muted('|')}&nbsp;&nbsp;`;
function greyIconLink(icon: string, tip: string, command: string, args?: unknown): string {
  return `[${muted(`<span class="codicon codicon-${icon}"></span>`)}](${cmdUri(command, args)} "${tip.replace(/"/g, "'")}")`;
}
/** A commit message as markdown. HTML is neutralized and `#123` is linked. The first line is bold when that stays one phrase and not a heading. Co-author trailers are removed, and a line of only dashes or equals signs is dropped so it cannot become a setext heading or a rule. */
export function messageMarkdown(message: string, web?: string): string {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const kept = safe.split('\n').map(l => l.replace(/\r$/, '')).filter(l => !CO_AUTHOR_ESCAPED.test(l) && !isRuleLine(l));
  const paragraphs = kept.join('\n').split(/\n{2,}/).map(p => p.split('\n').map(l => l.replace(/[ \t]+$/, '')).filter(l => l.length > 0).join('  \n')).filter(Boolean);
  return emphasizeSubject(linkPrRefs(paragraphs.join('\n\n'), web));
}
/** Bold the first line only. A blank line, or one whose markers would not stay a single bold phrase, stays plain and is never a heading. */
function emphasizeSubject(md: string): string {
  if (!md) return md;
  const nl = md.indexOf('\n');
  const first = nl < 0 ? md : md.slice(0, nl);
  const rest = nl < 0 ? '' : md.slice(nl);
  const subject = first.replace(/[ \t]+$/, '');
  const styled = boldSubject(subject);
  return styled + first.slice(subject.length) + rest;
}
function boldSubject(line: string): string {
  if (!line.trim() || breaksBold(line)) return line.replace(/^(#{1,6})(?=[ \t]|$)/, '\\$1');
  return `**${line}**`;
}
function breaksBold(line: string): boolean {
  if (/^\s|\s$/.test(line) || line.includes('**')) return true;
  if (line.startsWith('*') || line.endsWith('*') || line.startsWith('_') || line.endsWith('_')) return true;
  return (line.split('`').length - 1) % 2 !== 0;
}
/** Italics inside a muted span. VS Code's markdown parser treats `*` between inline tags as emphasis. */
function em(text: string): string { return `*${text.replace(/[\\*_`]/g, c => '\\' + c)}*`; }
function coAuthorLine(message: string): string | undefined {
  const authors = coAuthors(message); if (!authors.length) return;
  const title = authors.map(a => `${a.name} <${a.email}>`).join(', ').replace(/"/g, "'");
  const label = authors.length === 1 ? `+ ${escapeHtml(authors[0].name)}` : `+${authors.length} co-authors`;
  return `[${muted(em(label))}](mailto:${authors[0].email} "${title}")`;
}
function shaChip(sha: string, tip: string, command: string, args: unknown): string {
  return actionLink({ icon: 'git-commit', label: `\`${sha}\``, tip, command, args });
}
export function prNumberFromMessage(message: string): number | undefined {
  const m = /\(#(\d+)\)|Merge pull request #(\d+)/.exec(message); return m ? +(m[1] ?? m[2]) : undefined;
}
/** Blame hover: author, full message, folded co-authors, pull request, actions, then the changed lines around the blamed line. */
export function blameHoverMarkdown(d: CommitDetails, o: { avatar?: string; web?: string; login?: string; nowMs?: number; dateText?: string; root: string; file?: string; line?: number; hunk?: string; hunkHidden?: number; diff?: string; origLine?: number }): string {
  const sha = d.sha.slice(0, 7); const at = { root: o.root, sha: d.sha };
  const fa = { ...at, file: o.file, line: o.line };
  const fileArgs = o.file ? { ...at, file: o.file } : at;
  const profile = githubProfile(d.email, o.web, o.login);
  const name = escapeMd(d.author);
  const who = profile ? `[**${name}**](${profile})` : `**${name}**`;
  const avatar = o.avatar ? `<img src="${o.avatar}" width="24" height="24"/> ` : '';
  const date = o.dateText ?? longDate(d.time);
  const rel = escapeHtml(relativeTime(d.time, o.nowMs));
  const parts = [`${avatar}${who} ${muted('$(history)')} ${muted(em(rel))} ${muted(escapeHtml(date))}`];
  const msg = messageMarkdown(d.message, o.web); if (msg) parts.push(msg);
  const co = coAuthorLine(d.message); if (co) parts.push(co);
  const pr = prNumberFromMessage(d.message);
  if (pr && o.web) parts.push(`$(link) [Pull request #${pr}](${o.web}/pull/${pr})`);
  const gap = '&nbsp;&nbsp;';
  const changes = [
    greyIconLink('compare-changes', o.file ? 'Open Changes for This File' : 'Open Changes', 'gitKitchen.openCommitDiff', fileArgs),
    ...(o.file ? [greyIconLink('diff-multiple', 'Open All Changes in Commit', 'gitKitchen.openCommitDiff', at)] : []),
  ].join(gap);
  const revisions = o.file ? [
    greyIconLink('diff', 'Compare Working File with Previous Revision', 'gitKitchen.blame.comparePrevious', fa),
    greyIconLink('history', 'Blame Previous Revision', 'gitKitchen.blame.previous', fa),
    greyIconLink('file-code', 'Open File at This Revision', 'gitKitchen.blame.openRevision', fa),
  ].join(gap) : '';
  const nav = [
    greyIconLink('list-tree', 'Show in Commits View', 'gitKitchen.commit.reveal', at),
    greyIconLink('search', 'Search Commits by This SHA', 'gitKitchen.commit.search', { ...at, direct: true }),
    ...(o.web ? [greyIconLink('globe', 'Open Commit on Remote', 'gitKitchen.commit.openOnRemote', at)] : []),
  ].join(gap);
  const bar = [
    shaChip(sha, 'Copy SHA', 'gitKitchen.commit.copySha', { sha: d.sha }),
    greyIconLink('copy', 'Copy Message', 'gitKitchen.commit.copyMessage', at),
    changes, revisions, nav,
  ].filter(Boolean).join(GROUP_SEP);
  parts.push('---', bar, '---');
  let hunk = o.hunk; let hidden = o.hunkHidden ?? 0;
  if (o.diff !== undefined && o.origLine) {
    const slice = diffSliceForLine(o.diff, o.origLine);
    hunk = slice?.text; hidden = slice?.hidden ?? 0;
  }
  if (hunk) {
    parts.push('```diff\n' + hunk + '\n```');
    if (hidden > 0) parts.push(`[${muted(`… ${hidden} more lines · $(diff) Open full diff`)}](${cmdUri('gitKitchen.openCommitDiff', fileArgs)} "Open full diff")`);
    let foot = `${muted('Changes added in')} ${shaChip(sha, 'Open Changes', 'gitKitchen.openCommitDiff', fileArgs)}`;
    if (o.file) foot += `${GROUP_SEP}${greyIconLink('compare-changes', 'Compare with Previous', 'gitKitchen.blame.comparePrevious', fa)}`;
    parts.push(foot);
  }
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

/** True when version a is newer than b (plain x.y.z, a leading v is ignored). */
export function isNewerVersion(a: string, b: string): boolean {
  const n = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(x => parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); }
  return false;
}

/** Local branch name used for a pull request checked out into its own worktree. */
export const prWorktreeBranch = (number: number) => `pr-${number}`;
}

/** Git argument lists that print a commit's or a stash's changes as a patch (renames detected, binary included). */
export const patchArgs = {
  commit: (sha: string) => ['show', '--format=', '-M', '--binary', '-m', '--first-parent', sha],
  stash: (ref: string) => ['stash', 'show', '-p', '-M', '--binary', ref],
};

/** The pull request badge shown on a branch row; empty when there is none or the setting hides it. */
export function branchPrBadge(pr: PullRequest | undefined, show: boolean): string {
  return pr && show ? prBadge(pr) : '';
}

export type PrStatus = 'draft' | 'blocked' | 'changes requested' | 'needs review' | 'checks pending' | 'ready to merge';
/** One state for a pull request row, from its draft flag, merge state, checks and review decision. */
export function prStatus(p: Pick<PullRequest, 'isDraft' | 'mergeable' | 'checks' | 'reviewDecision'>): PrStatus {
  if (p.isDraft) return 'draft';
  if (p.mergeable === 'CONFLICTING' || p.checks === 'fail') return 'blocked';
  if (p.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  if (p.reviewDecision === 'REVIEW_REQUIRED') return 'needs review';
  if (p.checks === 'pending') return 'checks pending';
  return 'ready to merge';
}

/** Git argument lists to check out a remote-tracking branch such as `origin/feat/x`: fetch it first, then create the tracking branch. */
export function remoteCheckoutArgs(full: string): { fetch: string[]; switch: string[] } {
  const i = full.indexOf('/');
  if (i <= 0 || i === full.length - 1) throw new Error(`Not a remote branch: ${full}`);
  return { fetch: ['fetch', full.slice(0, i), full.slice(i + 1)], switch: ['switch', '--track', full] };
}
