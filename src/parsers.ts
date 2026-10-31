// Pure parsers for git / gh output. No vscode imports so they run under Vitest.

export const SEP = '\x1f';

export interface Branch { name: string; current: boolean; upstream?: string; ahead: number; behind: number; gone: boolean; sha: string; subject: string; worktreePath?: string; time: number }
export const BRANCH_FORMAT = ['%(HEAD)', '%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)', '%(contents:subject)', '%(worktreepath)', '%(committerdate:unix)'].join(SEP);

export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const a = /ahead (\d+)/.exec(track); const b = /behind (\d+)/.exec(track);
  return { ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0, gone: track.includes('gone') };
}

export function parseBranches(out: string): Branch[] {
  return out.split('\n').filter(l => l.trim()).map(l => {
    const [head, name, upstream, track, sha, subject, wt, time] = l.split(SEP);
    return { name, current: head === '*', upstream: upstream || undefined, ...parseTrack(track || ''), sha, subject: subject ?? '', worktreePath: wt || undefined, time: +(time || 0) };
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

export interface PullRequest { number: number; title: string; headRefName: string; baseRefName: string; url: string; isDraft: boolean; reviewDecision: string; author: string; checks: 'pass' | 'fail' | 'pending' | 'none'; mergeable: string }
export const PR_FIELDS = 'number,title,headRefName,baseRefName,url,isDraft,reviewDecision,author,statusCheckRollup,mergeable';
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
    reviewDecision: p.reviewDecision || '', author: p.author?.login ?? '', checks: summarizeChecks(p.statusCheckRollup), mergeable: p.mergeable ?? '' }));
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
/** Group names like `feat/a/b` into nested folders. Folders sort before leaves, each alphabetically. */
export function groupByPrefix<T>(items: T[], nameOf: (t: T) => string): TreeEntry<T>[] {
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
  const sort = (es: TreeEntry<T>[]) => { es.sort((a, b) => a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)); es.forEach(e => e.kind === 'folder' && sort(e.children)); return es; };
  return sort(root.children);
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
