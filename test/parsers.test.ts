import { describe, it, expect } from 'vitest';
import * as p from '../src/parsers';
const S = p.SEP;

describe('branches', () => {
  it('parses current, upstream and tracking', () => {
    const out = [`*${S}main${S}origin/main${S}[ahead 2, behind 1]${S}abc1234${S}Fix it${S}/repo${S}1700000000`, ` ${S}feat/x${S}${S}${S}def5678${S}Wip${S}`, ` ${S}old${S}origin/old${S}[gone]${S}0000000${S}Old${S}`].join('\n');
    const b = p.parseBranches(out);
    expect(b).toHaveLength(3);
    expect(b[0]).toMatchObject({ name: 'main', current: true, upstream: 'origin/main', ahead: 2, behind: 1, worktreePath: '/repo', time: 1700000000 });
    expect(b[1]).toMatchObject({ name: 'feat/x', current: false, upstream: undefined, ahead: 0 });
    expect(b[2].gone).toBe(true);
  });
});

describe('remotes', () => {
  it('merges fetch and push', () => {
    const r = p.parseRemotes('origin\tgit@github.com:acme/x.git (fetch)\norigin\tgit@github.com:acme/x.git (push)\nupstream\thttps://github.com/c/y (fetch)\n');
    expect(r.map(x => x.name)).toEqual(['origin', 'upstream']);
    expect(r[0].pushUrl).toContain('x.git');
  });
  it('builds web and line urls', () => {
    expect(p.githubWebUrl('git@github.com:acme/x.git')).toBe('https://github.com/acme/x');
    expect(p.githubWebUrl('https://github.com/a/b')).toBe('https://github.com/a/b');
    expect(p.githubWebUrl('https://gitlab.com/a/b')).toBeUndefined();
    expect(p.commitLineUrl('https://github.com/a/b', 'abc', 'src/my file.ts', 5)).toBe('https://github.com/a/b/blob/abc/src/my%20file.ts#L5');
    expect(p.commitLineUrl('https://github.com/a/b', 'abc', 'x', 5, 9)).toMatch(/#L5-L9$/);
  });
});

describe('stashes', () => {
  it('parses index', () => {
    const s = p.parseStashes(`stash@{0}${S}aaa${S}On main: wip${S}2026-10-31T01:00:00-07:00\nstash@{3}${S}bbb${S}msg${S}d`);
    expect(s[1].index).toBe(3); expect(s[0].message).toBe('On main: wip');
  });
});

describe('worktrees', () => {
  it('parses porcelain', () => {
    const out = 'worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/worktrees/x\nHEAD bbb\nbranch refs/heads/feat/x\nlocked reason\n\nworktree /tmp/gone\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n';
    const w = p.parseWorktrees(out);
    expect(w).toHaveLength(3);
    expect(w[0]).toMatchObject({ main: true, branch: 'main' });
    expect(w[1]).toMatchObject({ branch: 'feat/x', locked: true, main: false });
    expect(w[2]).toMatchObject({ detached: true, prunable: true });
  });
  it('default path', () => {
    expect(p.defaultWorktreePath('/home/me/repo', 'feat/x')).toBe('/home/me/repo.worktrees/feat-x');
    expect(p.defaultWorktreePath('/home/me/repo/', 'feat/x')).toBe('/home/me/repo.worktrees/feat-x');
    expect(p.defaultWorktreePath('/r/', 'feat/x')).toBe('/r.worktrees/feat-x');
    expect(p.defaultWorktreePath('E:\\DPFE\\clients\\LRG\\business-central', 'feature/sales-operations')).toBe('E:\\DPFE\\clients\\LRG\\business-central.worktrees\\feature-sales-operations');
    expect(p.defaultWorktreePath('E:\\DPFE\\clients\\LRG\\business-central\\', 'feature\\sales-operations')).toBe('E:\\DPFE\\clients\\LRG\\business-central.worktrees\\feature-sales-operations');
  });
});

describe('log', () => {
  it('parses records and parents', () => {
    const rec = (sha: string, par: string) => [sha, sha.slice(0, 3), 'Ann', 'a@b', '2026-10-31T00:00:00Z', 'Subj, with sep', par].join(S) + '\x1e';
    const c = p.parseLog(rec('aaaa', 'bbbb cccc') + '\n' + rec('bbbb', ''));
    expect(c).toHaveLength(2); expect(c[0].parents).toEqual(['bbbb', 'cccc']); expect(c[1].parents).toEqual([]);
  });
});

describe('blame', () => {
  it('parses porcelain with repeated shas', () => {
    const a = 'a'.repeat(40), z = '0'.repeat(40);
    const out = `${a} 1 1 2\nauthor Ann\nauthor-time 1700000000\nsummary First\nfilename f.ts\n\tline1\n${a} 2 2\n\tline2\n${z} 3 3 1\nauthor Not Committed Yet\nauthor-time 1800000000\nsummary Version of f.ts\nfilename f.ts\n\tline3\n`;
    const b = p.parseBlamePorcelain(out);
    expect(b).toHaveLength(3);
    expect(b[1]).toMatchObject({ line: 2, author: 'Ann', summary: 'First' });
    expect(b[2].uncommitted).toBe(true);
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('formats', () => {
    expect(p.relativeTime(now / 1000 - 30, now)).toBe('just now');
    expect(p.relativeTime(now / 1000 - 7200, now)).toBe('2 hours ago');
    expect(p.relativeTime(now / 1000 - 86400, now)).toBe('1 day ago');
  });
});

describe('prs', () => {
  it('summarizes checks and badges', () => {
    expect(p.summarizeChecks([])).toBe('none');
    expect(p.summarizeChecks([{ conclusion: 'SUCCESS', status: 'COMPLETED' }])).toBe('pass');
    expect(p.summarizeChecks([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { state: 'PENDING' }])).toBe('pending');
    expect(p.summarizeChecks([{ conclusion: 'FAILURE', status: 'COMPLETED' }])).toBe('fail');
    const prs = p.parsePrs(JSON.stringify([{ number: 7, title: 't', headRefName: 'h', baseRefName: 'main', url: 'u', isDraft: false, reviewDecision: 'APPROVED', author: { login: 'x' }, statusCheckRollup: [], mergeable: 'MERGEABLE' }]));
    expect(p.prBadge(prs[0])).toBe('#7 · checks none · approved');
  });
  it('prefills', () => {
    expect(p.prefillPr('feat/add-thing', ['One'])).toEqual({ title: 'One', body: '' });
    expect(p.prefillPr('feat/add-thing', ['A', 'B'])).toEqual({ title: 'Add thing', body: '- A\n- B' });
  });
});

describe('todos', () => {
  it('parses grep and groups', () => {
    const t = p.parseTodos('src/a.ts:3:  // TODO: do x\nsrc/a.ts:9:# FIXME broken\nb.md:1:nothing\nc:d.ts:2:// TODO y');
    expect(t).toHaveLength(3);
    expect(t[0]).toEqual({ file: 'src/a.ts', line: 3, tag: 'TODO', text: 'do x' });
    expect(t[2].file).toBe('c:d.ts');
    expect(p.groupByFile(t).get('src/a.ts')).toHaveLength(2);
  });
});

describe('merged + refnames', () => {
  it('filters merged list', () => {
    expect(p.parseMergedBranches('* main\n  a\n+ b\n  (HEAD detached at x)\n', 'main')).toEqual(['a', 'b']);
  });
  it('validates names', () => {
    expect(p.isValidRefName('feat/x')).toBe(true);
    for (const n of ['a b', 'a..b', 'x.lock', '/a', 'a/', '@', '']) expect(p.isValidRefName(n)).toBe(false);
  });
});

describe('groupByPrefix', () => {
  it('nests folders before leaves', () => {
    const t = p.groupByPrefix(['main', 'feat/b', 'feat/a', 'fix/x/y', 'claude/z'], s => s);
    expect(t.map(e => `${e.kind}:${e.name}`)).toEqual(['folder:claude', 'folder:feat', 'folder:fix', 'leaf:main']);
    const feat = t[1] as p.TreeFolder<string>; expect(feat.children.map(c => c.name)).toEqual(['a', 'b']);
    const fix = t[2] as p.TreeFolder<string>; expect(fix.children[0]).toMatchObject({ kind: 'folder', path: 'fix/x' });
  });
});

describe('heatBucket', () => {
  it('maps newest to 0 and oldest to last', () => {
    expect(p.heatBucket(100, 100, 0)).toBe(0);
    expect(p.heatBucket(0, 100, 0)).toBe(9);
    expect(p.heatBucket(50, 50, 50)).toBe(0);
    const mid = p.heatBucket(90, 100, 0); expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(9);
  });
});

describe('stepRevision', () => {
  const h = ['c3', 'c2', 'c1'];
  it('steps back and forward', () => {
    expect(p.stepRevision(h, undefined, 'prev')).toBe('c3');
    expect(p.stepRevision(h, undefined, 'next')).toBeUndefined();
    expect(p.stepRevision(h, 'c3', 'prev')).toBe('c2');
    expect(p.stepRevision(h, 'c1', 'prev')).toBeUndefined();
    expect(p.stepRevision(h, 'c2', 'next')).toBe('c3');
    expect(p.stepRevision(h, 'c3', 'next')).toBe('working');
    expect(p.stepRevision([], 'x', 'prev')).toBeUndefined();
  });
});

describe('changedLines', () => {
  it('reads -U0 hunks', () => {
    const r = p.changedLines('@@ -1,0 +2,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,3 +21,0 @@\n');
    expect(r.added).toEqual([2, 3, 12]); expect(r.deletedAfter).toEqual([21]);
  });
});

describe('lensSummary', () => {
  const mk = (line: number, author: string, t: number, unc = false): p.BlameLine => ({ line, sha: (unc ? '0' : author[0]).repeat(40), author, authorTime: t, summary: 's', filename: 'f', uncommitted: unc });
  const now = 1_000_000_000_000; const ts = now / 1000;
  it('picks latest author and counts authors', () => {
    const L = [mk(1, 'Ann', ts - 86400 * 2), mk(2, 'Bob', ts - 3600), mk(3, 'Ann', ts - 86400), mk(4, 'You', ts, true)];
    const r = p.lensSummary(L, 1, 4, now)!;
    expect(r.label).toBe('Bob, 1 hour ago'); expect(r.authorsLabel).toBe('2 authors (Ann, Bob)');
    expect(p.lensSummary(L, 1, 1, now)!.authorsLabel).toBe('1 author (Ann)');
    expect(p.lensSummary(L, 4, 4, now)).toBeUndefined();
  });
  it('caps the names', () => {
    const L = ['A', 'B', 'C', 'D', 'E'].map((a, i) => mk(i + 1, a, ts - i));
    expect(p.lensSummary(L, 1, 5, now)!.authorsLabel).toBe('5 authors (A, B, C, +2)');
  });
});

describe('0.2.1 helpers', () => {
  const bl = (line: number, sha: string, extra: Partial<p.BlameLine> = {}): p.BlameLine => ({ line, sha, author: 'A', authorTime: 1000, summary: 's', filename: 'f', uncommitted: /^0+$/.test(sha), ...extra });
  it('classifyChanges splits added, modified and deleted', () => {
    const d = '@@ -1,0 +2,2 @@\n+a\n+b\n@@ -5,2 +7,3 @@\n-x\n-y\n+x\n+y\n+z\n@@ -9,2 +11,0 @@\n-q\n-r\n@@ -12 +13 @@\n-o\n+n';
    expect(p.classifyChanges(d)).toEqual({ added: [2, 3, 9], modified: [7, 8, 13], deletedAfter: [11] });
  });
  it('classifyChanges marks lines removed inside a modified hunk', () => {
    expect(p.classifyChanges('@@ -1,3 +1 @@\n-a\n-b\n-c\n+A')).toEqual({ added: [], modified: [1], deletedAfter: [1] });
  });
  it('classifyChanges on empty diff', () => { expect(p.classifyChanges('')).toEqual({ added: [], modified: [], deletedAfter: [] }); });
  it('sameCommitLines finds other lines of the commit', () => {
    const lines = [bl(1, 'a'.repeat(40)), bl(2, 'b'.repeat(40)), bl(3, 'a'.repeat(40)), bl(4, '0'.repeat(40)), bl(5, '0'.repeat(40))];
    expect(p.sameCommitLines(lines, 1)).toEqual([3]);
    expect(p.sameCommitLines(lines, 2)).toEqual([]);
    expect(p.sameCommitLines(lines, 4)).toEqual([]);
    expect(p.sameCommitLines(lines, 99)).toEqual([]);
  });
  it('hunkForLine returns the changed run touching the line', () => {
    const d = 'diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -10,2 +11,2 @@\n-x\n+y\n z\n';
    expect(p.hunkForLine(d, 2)).toBe('+b');
    expect(p.hunkForLine(d, 12)).toBe('-x\n+y');
    expect(p.hunkForLine(d, 7)).toBeUndefined();
    expect(p.hunkForLine('', 1)).toBeUndefined();
    expect(p.hunkForLine('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n', 1)).toBe('-a\n+b');
    expect(p.hunkForLine('Binary files a/f and b/f differ\n', 1)).toBeUndefined();
  });
  it('hunkForLine keeps one changed block and caps a long run at 6', () => {
    const split = '@@ -1,4 +1,5 @@\n a\n-b\n+c\n d\n+e\n f\n';
    expect(p.hunkForLine(split, 2)).toBe('-b\n+c');
    expect(p.hunkForLine(split, 4)).toBe('+e');
    const added = (n: number) => `@@ -0,0 +1,${n} @@\n` + Array.from({ length: n }, (_, i) => `+line ${i + 1}`).join('\n') + '\n';
    expect(p.hunkForLine(added(10), 4)!.split('\n')).toHaveLength(10);
    expect(p.diffSliceForLine(added(10), 4)!.hidden).toBe(0);
    const long = p.diffSliceForLine(added(11), 1)!;
    expect(long.text.split('\n')).toEqual(['+line 1', '+line 2', '+line 3', '+line 4', '+line 5', '+line 6']);
    expect(long.hidden).toBe(5);
    const mid = p.diffSliceForLine(added(20), 10)!;
    expect(mid.text.split('\n')).toEqual(['+line 8', '+line 9', '+line 10', '+line 11', '+line 12', '+line 13']);
    expect(mid.total).toBe(20); expect(mid.hidden).toBe(14);
    expect(mid.text).not.toContain('@@');
  });
  it('statusBarText', () => {
    const now = 1000 * 1000 + 3 * 3600 * 1000;
    expect(p.statusBarText(bl(1, 'a'.repeat(40), { author: 'Ann' }), now)).toBe(`$(git-commit) Ann, ${p.relativeTime(1000, now)}`);
    expect(p.statusBarText(bl(1, '0'.repeat(40)))).toBe('$(git-commit) You, uncommitted');
    expect(p.statusBarText(undefined)).toBeUndefined();
  });
  it('blame porcelain keeps the original line', () => {
    const out = `${'a'.repeat(40)} 7 1 1\nauthor A\nauthor-time 5\nsummary s\nfilename f\n\tx\n`;
    expect(p.parseBlamePorcelain(out)[0].origLine).toBe(7);
  });
});

describe('0.3.0 helpers', () => {
  const day = 86400; const now = 1_000_000 * 1000;
  const at = (d: number) => now / 1000 - d * day;
  it('freshness classification and thresholds', () => {
    expect(p.freshness(0, at(1), now).state).toBe('fresh');
    expect(p.freshness(0, at(13), now).state).toBe('fresh');
    expect(p.freshness(0, at(14), now).state).toBe('aging');
    expect(p.freshness(1, at(0), now).state).toBe('aging');
    expect(p.freshness(20, at(0), now).state).toBe('aging');
    expect(p.freshness(21, at(0), now).state).toBe('stale');
    expect(p.freshness(0, at(60), now).state).toBe('aging');
    expect(p.freshness(0, at(61), now).state).toBe('stale');
    expect(p.freshness(12, at(41), now).reason).toBe('12 behind · last commit 41d ago · aging');
    expect(p.freshness(0, at(5), now, { agingDays: 3, staleDays: 4, behindCount: 0 }).state).toBe('stale');
  });
  const fsOf = (files: Record<string, string>) => (f: string) => files[f];
  it('detects operations from git dir state', () => {
    expect(p.detectOperation(fsOf({}))).toBeUndefined();
    expect(p.detectOperation(fsOf({ MERGE_HEAD: 'abc' }))).toMatchObject({ kind: 'merge', canSkip: false });
    expect(p.detectOperation(fsOf({ CHERRY_PICK_HEAD: 'abcdef1234' }))).toMatchObject({ kind: 'cherry-pick', label: 'Cherry-picking abcdef1' });
    expect(p.detectOperation(fsOf({ REVERT_HEAD: '1234567890' }))).toMatchObject({ kind: 'revert', label: 'Reverting 1234567' });
    expect(p.detectOperation(fsOf({ 'rebase-merge/head-name': 'refs/heads/feat/x', 'rebase-merge/msgnum': '2', 'rebase-merge/end': '5', 'rebase-merge/onto': 'ff' })))
      .toMatchObject({ kind: 'rebase', label: 'Rebasing feat/x (2/5)', step: 2, total: 5, canSkip: true });
    expect(p.detectOperation(fsOf({ 'rebase-apply/next': '1', 'rebase-apply/last': '3', 'rebase-apply/head-name': 'refs/heads/m' }))).toMatchObject({ kind: 'rebase', label: 'Rebasing m (1/3)' });
    expect(p.detectOperation(fsOf({ 'rebase-apply/applying': '', 'rebase-apply/next': '1' }))).toBeUndefined();
    expect(p.detectOperation(fsOf({ 'rebase-merge/head-name': 'refs/heads/a', MERGE_HEAD: 'x' }))!.kind).toBe('rebase');
  });
  it('picks the remote pair to compare', () => {
    expect(p.pickDualPair(['origin'], {})).toBeUndefined();
    expect(p.pickDualPair([], {})).toBeUndefined();
    expect(p.pickDualPair(['origin', 'upstream'], {})).toEqual({ source: 'origin', target: 'upstream' });
    expect(p.pickDualPair(['upstream', 'origin'], {}, 'upstream')).toEqual({ source: 'origin', target: 'upstream' });
    expect(p.pickDualPair(['origin', 'a', 'b'], {})).toBeUndefined();
    expect(p.pickDualPair(['origin', 'a', 'b'], { source: 'a', target: 'b' })).toEqual({ source: 'a', target: 'b' });
    expect(p.pickDualPair(['origin', 'a'], { source: 'a', target: 'origin' })).toEqual({ source: 'a', target: 'origin' });
    expect(p.pickDualPair(['origin', 'a'], { source: 'gone', target: 'a' })).toEqual({ source: 'origin', target: 'a' });
    expect(p.pickDualPair(['origin', 'a'], { source: 'a', target: 'a' })).toEqual({ source: 'origin', target: 'a' });
  });
  it('picks the remote pair without an origin', () => {
    expect(p.pickDualPair(['zeta', 'alpha'], {})).toEqual({ source: 'alpha', target: 'zeta' });
    expect(p.pickDualPair(['zeta', 'alpha'], {}, 'zeta')).toEqual({ source: 'zeta', target: 'alpha' });
    expect(p.pickDualPair(['zeta', 'alpha'], {}, 'missing')).toEqual({ source: 'alpha', target: 'zeta' });
    expect(p.pickDualPair(['github', 'gitlab', 'company'], {})).toBeUndefined();
  });
});

describe('branch state icons', () => {
  const pr = (number: number, state: any, isDraft = false, headRefName = 'b'): p.BranchPrInfo => ({ number, state, isDraft, headRefName });
  it('priority: active > open PR > merged > worktree > branch', () => {
    expect(p.branchState({ current: true, pr: pr(1, 'OPEN'), mergedInto: 'main', worktree: true })).toEqual({ icon: 'git-pull-request', state: 'Current branch · PR #1 open' });
    expect(p.branchState({ current: true, worktree: false })).toEqual({ icon: 'git-branch', state: 'Current branch' });
    expect(p.branchState({ current: false, pr: pr(12, 'OPEN'), mergedInto: 'main', worktree: true })).toEqual({ icon: 'git-merge', state: 'Merged into main' });
    expect(p.branchState({ current: false, pr: pr(12, 'OPEN'), worktree: true })).toEqual({ icon: 'git-pull-request', state: 'PR #12 open' });
    expect(p.branchState({ current: false, pr: pr(3, 'OPEN', true), worktree: false })).toEqual({ icon: 'git-pull-request-draft', state: 'PR #3 draft' });
    expect(p.branchState({ current: false, pr: pr(4, 'MERGED'), worktree: true })).toEqual({ icon: 'git-merge', state: 'PR #4 merged' });
    expect(p.branchState({ current: false, mergedInto: 'main', worktree: true })).toEqual({ icon: 'git-merge', state: 'Merged into main' });
    expect(p.branchState({ current: false, worktree: true })).toEqual({ icon: 'worktree', state: 'Checked out in a worktree' });
    expect(p.branchState({ current: false, worktree: false })).toEqual({ icon: 'git-branch' });
    expect(p.branchState({ current: false, pr: pr(5, 'CLOSED'), worktree: false })).toEqual({ icon: 'git-branch' });
  });
  it('picks the open PR, else the latest merged one', () => {
    const prs = p.parseBranchPrs(JSON.stringify([{ number: 1, state: 'MERGED', isDraft: false, headRefName: 'b' }, { number: 7, state: 'MERGED', headRefName: 'b' }, { number: 9, state: 'OPEN', headRefName: 'c' }, { number: 2, state: 'CLOSED', headRefName: 'd' }]));
    expect(p.prForBranch(prs, 'b')?.number).toBe(7); expect(p.prForBranch(prs, 'c')?.number).toBe(9);
    expect(p.prForBranch(prs, 'd')).toBeUndefined(); expect(p.prForBranch(prs, 'z')).toBeUndefined();
    expect(p.parseBranchPrs('not json')).toEqual([]);
  });
});

describe('path tree', () => {
  const shape = (es: p.TreeEntry<any>[]): any => es.map(e => e.kind === 'leaf' ? e.name : { [e.name]: shape(e.children) });
  const files = ['README.md', 'src/a.ts', 'src/ui/b.ts', 'src/ui/c.ts', 'docs/guide/intro/x.md', 'docs/guide/intro/y.md', 'pkg/one/two/z.ts', 'pkg/top.ts'];
  it('builds a compact folder tree with folders first', () => {
    expect(shape(p.buildPathTree(files, f => f))).toEqual([
      { 'docs/guide/intro': ['x.md', 'y.md'] }, { pkg: [{ 'one/two': ['z.ts'] }, 'top.ts'] }, { src: [{ ui: ['b.ts', 'c.ts'] }, 'a.ts'] }, 'README.md']);
  });
  it('can skip compaction', () => {
    expect(shape(p.buildPathTree(['a/b/c.ts'], f => f, false))).toEqual([{ a: [{ b: ['c.ts'] }] }]);
    expect(shape(p.buildPathTree(['a/b/c.ts'], f => f))).toEqual([{ 'a/b': ['c.ts'] }]);
  });
  it('compacted folder keeps the full path', () => {
    const t = p.buildPathTree(['a/b/c.ts'], f => f)[0] as p.TreeFolder<string>; expect(t.path).toBe('a/b');
  });
  it('parses name-status with renames', () => {
    expect(p.parseNameStatus('M\tsrc/a.ts\nR100\told.ts\tnew/n.ts\nA\tb.md\n')).toEqual([
      { status: 'M', path: 'src/a.ts', oldPath: undefined }, { status: 'R', path: 'new/n.ts', oldPath: 'old.ts' }, { status: 'A', path: 'b.md', oldPath: undefined }]);
  });
  it('empty input', () => { expect(p.buildPathTree([], (f: string) => f)).toEqual([]); });
});

describe('commit card', () => {
  const out = `${'d'.repeat(40)}\x1fAnn Lee\x1f12345+ann@users.noreply.github.com\x1f1000\x1ftwo (#12)\n\nBody line\x1e\n\n3\t0\td/x2\n1\t0\tnew\n0\t2\tx\n0\t1\ty\n5\t4\tsrc/a.ts\n-\t-\timg.png\n create mode 100644 d/x2\n create mode 100644 new\n delete mode 100644 x\n delete mode 100644 y\n`;
  it('parses stats from numstat and summary', () => {
    const d = p.parseCommitDetails(out)!;
    expect(d).toMatchObject({ author: 'Ann Lee', time: 1000, message: 'two (#12)\n\nBody line', filesAdded: 2, filesDeleted: 2, filesChanged: 2, additions: 9, deletions: 7 });
    expect(p.parseCommitStats('')).toEqual({ filesAdded: 0, filesChanged: 0, filesDeleted: 0, additions: 0, deletions: 0 });
    expect(p.parseCommitDetails('garbage')).toBeUndefined();
  });
  it('links PR refs only with a GitHub remote', () => {
    expect(p.linkPrRefs('Fix (#12) and #3, not a#4 or &#5', 'https://github.com/o/r')).toBe('Fix ([#12](https://github.com/o/r/pull/12)) and [#3](https://github.com/o/r/pull/3), not a#4 or &#5');
    expect(p.linkPrRefs('Fix #12')).toBe('Fix #12');
  });
  it('noreply avatar', () => {
    expect(p.noreplyAvatar('12345+ann@users.noreply.github.com')).toBe('https://avatars.githubusercontent.com/u/12345?s=32');
    expect(p.noreplyAvatar('ann@example.com')).toBeUndefined();
  });
  it('card markdown', () => {
    const d = p.parseCommitDetails(out)!;
    const md = p.commitCardMarkdown(d, { nowMs: 1000 * 1000 + 7200 * 1000, web: 'https://github.com/o/r', avatar: 'https://a/x', remoteBranches: ['origin/main'], copyCommand: 'command:copy', dateText: 'DATE' });
    expect(md).toContain('<img src="https://a/x"'); expect(md).toContain('**Ann Lee**'); expect(md).toContain('(DATE)');
    expect(md).toContain('[$(git-commit) `ddddddd`](command:copy "Copy SHA")'); expect(md).toContain('+2 ~2 -2');
    expect(md).toContain('color:#3fb950;">+9</span>'); expect(md).toContain('color:#f85149;">-7</span>');
    expect(md).toContain('[#12](https://github.com/o/r/pull/12)'); expect(md).toContain('`origin/main`');
    expect(p.commitCardMarkdown(d)).toContain('$(account) **Ann Lee**');
  });
});

describe('branch sort', () => {
  const bs = [
    { name: 'zeta', time: 50, current: false }, { name: 'feat/old', time: 10, current: false }, { name: 'feat/new', time: 90, current: false },
    { name: 'main', time: 5, current: true }, { name: 'alpha', time: 70, current: false }, { name: 'fix/x/y', time: 30, current: false },
  ];
  const o = { current: (b: any) => b.current, name: (b: any) => b.name, time: (b: any) => b.time };
  it('pins the current branch, then date or name', () => {
    expect(p.sortBranches(bs, { ...o, by: 'date' }).map(b => b.name)).toEqual(['main', 'feat/new', 'alpha', 'zeta', 'fix/x/y', 'feat/old']);
    expect(p.sortBranches(bs, { ...o, by: 'name' }).map(b => b.name)).toEqual(['main', 'alpha', 'feat/new', 'feat/old', 'fix/x/y', 'zeta']);
  });
  it('sorts folders by their newest child', () => {
    const rest = bs.filter(b => !b.current);
    const t = p.groupByPrefix(rest, b => b.name, b => b.time);
    expect(t.map(e => e.name)).toEqual(['feat', 'alpha', 'zeta', 'fix']);
    expect((t[0] as any).children.map((e: any) => e.name)).toEqual(['new', 'old']);
    expect(p.groupByPrefix(rest, b => b.name).map(e => e.name)).toEqual(['feat', 'fix', 'alpha', 'zeta']);
  });
});

describe('pinned sort in every view', () => {
  it('remotes: upstream remote first, then newest ref', () => {
    const rs = [{ name: 'acme', t: 30 }, { name: 'origin', t: 10 }, { name: 'zed', t: 90 }];
    const o = { name: (x: any) => x.name, time: (x: any) => x.t };
    expect(p.pinSort(rs, { ...o, current: x => x.name === 'origin', by: 'date' }).map(x => x.name)).toEqual(['origin', 'zed', 'acme']);
    expect(p.pinSort(rs, { ...o, current: () => false, by: 'name' }).map(x => x.name)).toEqual(['acme', 'origin', 'zed']);
  });
  it('worktrees: current first, then HEAD date', () => {
    const ws = [{ path: '/a', t: 5 }, { path: '/b', t: 50 }, { path: '/c', t: 20 }];
    expect(p.pinSort(ws, { current: w => w.path === '/c', name: w => w.path, time: w => w.t, by: 'date' }).map(w => w.path)).toEqual(['/c', '/b', '/a']);
  });
  it('pull requests: current branch PR first, then updatedAt', () => {
    const prs = [{ h: 'a', u: '2026-10-01T00:00:00Z' }, { h: 'b', u: '2026-10-30T00:00:00Z' }, { h: 'cur', u: '2026-01-01T00:00:00Z' }, { h: 'd', u: '' }];
    expect(p.pinSort(prs, { current: x => x.h === 'cur', name: x => x.h, time: x => Date.parse(x.u) || 0, by: 'date' }).map(x => x.h)).toEqual(['cur', 'b', 'a', 'd']);
    expect(p.parsePrs('[{"number":1,"updatedAt":"2026-10-30T00:00:00Z"}]')[0].updatedAt).toBe('2026-10-30T00:00:00Z');
  });
});

describe('branch description', () => {
  it('formats upstream, ahead/behind and time', () => {
    expect(p.branchDescription({ upstream: 'origin/main' }, '14 hours ago')).toBe('⇄ origin/main • 14 hours ago');
    expect(p.branchDescription({ upstream: 'origin/x', ahead: 1, behind: 2 }, '1 day ago', ['PR #3'])).toBe('2↓ 1↑ ⇄ origin/x • 1 day ago • PR #3');
    expect(p.branchDescription({ upstream: 'origin/main', behind: 21 }, 'now')).toBe('21↓ 0↑ ⇄ origin/main • now');
    expect(p.syncText({ upstream: 'origin/main', behind: 21, ahead: 0 })).toBe('21 behind, 0 ahead of origin/main');
    expect(p.branchDescription({}, 'just now', ['worktree'])).toBe('no upstream • just now • worktree');
  });
});

describe('sync tone', () => {
  const now = 10_000_000_000;
  it('red when behind, yellow when only ahead, green when in sync and recent', () => {
    expect(p.syncTone({ upstream: 'o/m', behind: 2, ahead: 3 }, now / 1000, now, 60)).toBe('behind');
    expect(p.syncTone({ upstream: 'o/m', behind: 1 }, undefined, now, 60)).toBe('behind');
    expect(p.syncTone({ upstream: 'o/m', ahead: 1 }, now / 1000, now, 60)).toBe('ahead');
    expect(p.syncTone({ upstream: 'o/m' }, now / 1000 - 30 * 60, now, 60)).toBe('synced');
    expect(p.syncTone({ upstream: 'o/m' }, now / 1000 - 61 * 60, now, 60)).toBe('');
    expect(p.syncTone({ upstream: 'o/m' }, undefined, now, 60)).toBe('');
    expect(p.syncTone({}, now / 1000, now, 60)).toBe('');
    expect(p.syncTone({ upstream: 'o/m', gone: true, behind: 1 }, now / 1000, now, 60)).toBe('');
  });
  it('reflog time and tooltip text', () => {
    expect(p.parseReflogTime('origin/main@{1793438142}\n')).toBe(1793438142);
    expect(p.parseReflogTime('')).toBeUndefined();
    expect(p.syncText({ upstream: 'origin/main', behind: 21, ahead: 0 }, 'behind')).toBe('21 behind, 0 ahead of origin/main (pull needed)');
    expect(p.syncText({ upstream: 'o/m', ahead: 2 }, 'ahead')).toBe('0 behind, 2 ahead of o/m (unpushed commits)');
  });
});

describe('avatars', () => {
  it('maps noreply emails straight to GitHub avatars', () => {
    expect(p.noreplyAvatar('12345+octo@users.noreply.github.com')).toBe('https://avatars.githubusercontent.com/u/12345?s=32');
    expect(p.noreplyAvatar('octo@users.noreply.github.com')).toBeUndefined();
    expect(p.noreplyAvatar('a@b.com')).toBeUndefined();
  });
  it('gravatar uses md5 of the trimmed lowercase email with d=404', () => {
    expect(p.gravatarUrl(' MyEmailAddress@example.com ')).toBe('https://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=32&d=404');
  });
  it('initials svg: two letters, stable color, escaped', () => {
    expect(p.initials('Ada Lovelace')).toBe('AL'); expect(p.initials('', 'grace.hopper@x.io')).toBe('GH'); expect(p.initials('bot')).toBe('BO'); expect(p.initials('')).toBe('?');
    const svg = p.initialsSvg('Ada Lovelace', 'ada@x.io');
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 16 16"/); expect(svg).toContain('>AL</text>'); expect(svg).toContain(`fill="${p.avatarColor('ada@x.io')}"`);
    expect(p.avatarColor('ADA@x.io')).toBe(p.avatarColor('ada@x.io')); expect(p.avatarColor('a@x.io')).not.toBe(p.avatarColor('b@x.io'));
    expect(p.initialsSvg('<x> y', 'e')).not.toMatch(/<x>/);
  });
  it('batched GraphQL query and parse', () => {
    expect(p.avatarQuery('o', 'r', ['abc1', 'def2'])).toContain('c1: object(oid: "def2")');
    expect(p.parseAvatarQuery('{"data":{"repository":{"c0":{"author":{"avatarUrl":"https://a/u/1"}},"c1":null}}}', 2)).toEqual(['https://a/u/1', undefined]);
    expect(p.parseAvatarQuery('nope', 1)).toEqual([undefined]);
  });
});

describe('hover cards', () => {
  const d = { sha: 'abcdef1234567890', author: 'Ann Lee', email: 'ann@x.io', time: 1000, message: 'Fix the thing (#12)\n\n- first\n- second\n\nCo-authored-by: Bo Ko <bo@x.io>', filesAdded: 0, filesChanged: 1, filesDeleted: 0, additions: 1, deletions: 1 };
  it('shared card: bold title, status, details, action bar', () => {
    const m = p.mdCard({ title: 'T*', icon: 'cloud', status: 'S', details: ['a', 'b'], actions: [{ icon: 'copy', tip: 'Copy "it"', command: 'x.y', args: { a: 1 } }] });
    expect(m).toBe(`$(cloud) **T\\***\n\nS\n\na  \nb\n\n---\n\n[$(copy)](command:x.y?${encodeURIComponent('[{"a":1}]')} "Copy 'it'")`);
  });
  it('blame hover: header, message markdown, PR line, action bar, diff', () => {
    const m = p.blameHoverMarkdown(d as any, { root: '/r', file: 'a.ts', web: 'https://github.com/o/r', nowMs: 1000 * 1000 + 3600_000, dateText: 'DATE', hunk: '-a\n+b' });
    expect(m).toContain('**Ann Lee** <span style="color:var(--vscode-descriptionForeground);">$(history)</span> <span style="color:var(--vscode-descriptionForeground);">*1 hour ago*</span> <span style="color:var(--vscode-descriptionForeground);">DATE</span>');
    expect(m).not.toContain('<em>DATE</em>'); expect(m).not.toContain('*DATE*'); expect(m).not.toContain('<em>1 hour ago</em>');
    expect(m).not.toContain('$(github)'); expect(m).not.toContain('$(account)'); expect(m).not.toContain('float:right'); expect(m).not.toMatch(/color:#[0-9a-fA-F]/);
    expect(m).toContain('**Fix the thing ([#12](https://github.com/o/r/pull/12))**');
    expect(m).toContain('- first  \n- second'); expect(m).not.toContain('**- first');
    expect(m).not.toContain('Co-authored-by');
    expect(m).toContain('[<span style="color:var(--vscode-descriptionForeground);">*+ Bo Ko*</span>](mailto:bo@x.io "Bo Ko <bo@x.io>")');
    expect(m).toContain('$(link) [Pull request #12](https://github.com/o/r/pull/12)');
    expect(m).not.toContain('$(git-pull-request)');
    const at = (cmd: string) => m.indexOf(cmd);
    expect(at('commit.copySha')).toBeLessThan(at('commit.copyMessage'));
    expect(at('commit.copyMessage')).toBeLessThan(at('codicon-compare-changes'));
    expect(at('codicon-compare-changes')).toBeLessThan(at('codicon-diff-multiple'));
    expect(at('codicon-diff-multiple')).toBeLessThan(at('codicon codicon-diff"'));
    expect(at('blame.comparePrevious')).toBeLessThan(at('blame.previous'));
    expect(at('blame.previous')).toBeLessThan(at('blame.openRevision'));
    expect(at('blame.openRevision')).toBeLessThan(at('commit.reveal'));
    expect(at('commit.reveal')).toBeLessThan(at('commit.search'));
    expect(at('commit.search')).toBeLessThan(at('commit.openOnRemote'));
    expect(m).toContain('```diff\n-a\n+b\n```');
    expect(m).toContain('[$(git-commit) `abcdef1`](command:gitKitchen.commit.copySha?');
    expect(m).toContain('<span style="color:var(--vscode-descriptionForeground);">Changes added in</span> [$(git-commit) `abcdef1`](command:gitKitchen.openCommitDiff');
    expect(m).not.toContain('[$(git-commit) abcdef1]');
    expect(m).toContain('codicon codicon-compare-changes'); expect(m).toContain('"Compare with Previous"');
    expect(m).not.toContain('more lines'); expect(m).not.toMatch(/Show all|Show less|<details/i);
    expect(p.messageMarkdown('<script>')).toBe('**&lt;script&gt;**');
    expect(p.messageMarkdown('Use `code` in the body\n\nKeep `this` code')).toBe('**Use `code` in the body**\n\nKeep `this` code');
    expect(p.messageMarkdown('**already**\n\nbody')).toBe('**already**\n\nbody');
    expect(p.messageMarkdown('# Title **x**\n\nbody')).toBe('\\# Title **x**\n\nbody');
    expect(p.messageMarkdown('')).toBe('');
    expect(p.githubLoginFromEmail('123+ann-lee@users.noreply.github.com')).toBe('ann-lee');
    expect(p.githubLoginFromEmail('Heroeskitchen@users.noreply.github.com')).toBe('Heroeskitchen');
    expect(p.githubLoginFromEmail('ann@x.io')).toBeUndefined();
    const linked = p.blameHoverMarkdown({ ...d, email: '123+ann-lee@users.noreply.github.com' } as any, { root: '/r', web: 'https://github.com/o/r', avatar: 'https://a/u', dateText: 'DATE' });
    expect(linked).toContain('<img src="https://a/u" width="24" height="24"/> [**Ann Lee**](https://github.com/ann-lee)');
    expect(p.blameHoverMarkdown(d as any, { root: '/r', web: 'https://github.com/o/r', login: 'ann-lee', dateText: 'DATE' })).toContain('[**Ann Lee**](https://github.com/ann-lee)');
    expect(p.blameHoverMarkdown({ ...d, email: '123+ann-lee@users.noreply.github.com' } as any, { root: '/r', web: 'https://gitlab.com/o/r', dateText: 'DATE' })).not.toContain('https://github.com/ann-lee');
    expect(p.longDate(Math.floor(new Date(2026, 9, 12, 11, 10).getTime() / 1000))).toBe('October 12th, 2026 11:10 AM');
    expect(p.longDate(Math.floor(new Date(2026, 0, 1, 9, 5).getTime() / 1000))).toBe('January 1st, 2026 9:05 AM');
    expect(p.longDate(Math.floor(new Date(2026, 0, 2, 0, 0).getTime() / 1000))).toBe('January 2nd, 2026 12:00 AM');
    expect(p.longDate(Math.floor(new Date(2026, 0, 3, 15, 0).getTime() / 1000))).toBe('January 3rd, 2026 3:00 PM');
    expect(p.longDate(Math.floor(new Date(2026, 0, 11, 11, 11).getTime() / 1000))).toBe('January 11th, 2026 11:11 AM');
    expect(p.longDate(Math.floor(new Date(2026, 0, 13, 13, 0).getTime() / 1000))).toBe('January 13th, 2026 1:00 PM');
  });
  const squash = [
    'Make F5 start a broken or old install (#49)',
    '',
    '* Make F5 prepare Docker, dependencies, and tables.',
    '',
    'Pressing F5 checks Docker, starts Postgres and Redis, installs when the lockfile changed, and creates missing tables. Data volumes are not deleted.',
    '',
    'Co-authored-by: Heroeskitchen <Heroeskitchen@users.noreply.github.com>',
    '',
    '* Ignore old Postgres log lines when the database is healthy.',
    '',
    'A later F5 was stopping on an incompatible-volume message left in the log after the data directory had already started.',
    '',
    'Co-authored-by: Heroeskitchen <Heroeskitchen@users.noreply.github.com>',
    '',
    '---------',
    '',
    'Co-authored-by: Cursor Agent <cursoragent@cursor.com>',
    'Co-authored-by: Heroeskitchen <Heroeskitchen@users.noreply.github.com>',
  ].join('\n');
  it('squash message keeps paragraphs and folds two co-authors', () => {
    const web = 'https://github.com/o/r';
    const body = p.messageMarkdown(squash, web);
    expect(body).toBe([
      '**Make F5 start a broken or old install ([#49](https://github.com/o/r/pull/49))**',
      '* Make F5 prepare Docker, dependencies, and tables.',
      'Pressing F5 checks Docker, starts Postgres and Redis, installs when the lockfile changed, and creates missing tables. Data volumes are not deleted.',
      '* Ignore old Postgres log lines when the database is healthy.',
      'A later F5 was stopping on an incompatible-volume message left in the log after the data directory had already started.',
    ].join('\n\n'));
    expect(body).not.toContain('Co-authored-by'); expect(body).not.toContain('---'); expect(body).not.toMatch(/^[-=]+$/m);
    expect(p.messageMarkdown('Title\n\nCo-authored-by: A <a@b.c>\n\n---------\n\nBody')).toBe('**Title**\n\nBody');
    expect(p.messageMarkdown('Title\r\n\r\nCo-authored-by: A <a@b.c>\r\n\r\n---------\r\n\r\nBody')).toBe('**Title**\n\nBody');
    expect(p.messageMarkdown('Head\n===\nTail')).toBe('**Head**  \nTail');
    expect(p.messageMarkdown('Head\n---\nTail')).toBe('**Head**  \nTail');
    const m = p.blameHoverMarkdown({ ...d, message: squash } as any, { root: '/r', file: 'a.ts', web, dateText: 'DATE' });
    expect(m).toContain(body);
    expect(m).toContain('[<span style="color:var(--vscode-descriptionForeground);">*+2 co-authors*</span>](mailto:Heroeskitchen@users.noreply.github.com "Heroeskitchen <Heroeskitchen@users.noreply.github.com>, Cursor Agent <cursoragent@cursor.com>")');
    expect(m).not.toContain('Co-authored-by'); expect(m).not.toContain('---------');
    expect(m).not.toMatch(/[^\n]\n[-=]{3,}[ \t]*\n/);
    expect(m).toContain('$(link) [Pull request #49](https://github.com/o/r/pull/49)');
  });
  it('new-file diff is capped at 6 with the lines left out', () => {
    const diff = 'diff --git a/f b/f\nnew file mode 100644\nindex 0000000..abc\n--- /dev/null\n+++ b/f\n@@ -0,0 +1,20 @@\n' + Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`).join('\n') + '\n';
    const m = p.blameHoverMarkdown(d as any, { root: '/r', file: 'f.ts', web: 'https://github.com/o/r', dateText: 'DATE', diff, origLine: 10 });
    expect(m).toContain('```diff\n+line 8\n+line 9\n+line 10\n+line 11\n+line 12\n+line 13\n```');
    expect(m).not.toContain('+line 1\n'); expect(m).not.toContain('@@'); expect(m).not.toContain('--- /dev/null'); expect(m).not.toContain('\\ No newline');
    expect(m).toContain('[<span style="color:var(--vscode-descriptionForeground);">… 14 more lines · $(diff) Open full diff</span>]');
    expect(m).toContain(`command:gitKitchen.openCommitDiff?${encodeURIComponent(JSON.stringify([{ root: '/r', sha: d.sha, file: 'f.ts' }]))}`);
    expect(m).toContain('"Open full diff"');
    expect(m).not.toMatch(/Show all|Show less|<details/i);
    const short = p.blameHoverMarkdown(d as any, { root: '/r', file: 'f.ts', dateText: 'DATE', diff: '@@ -0,0 +1,8 @@\n' + Array.from({ length: 8 }, (_, i) => `+L${i + 1}`).join('\n'), origLine: 3 });
    expect(short).toContain('+L1'); expect(short).toContain('+L8'); expect(short).not.toContain('more lines');
  });
  it('omits the pull request row when the message has none', () => {
    const m = p.blameHoverMarkdown({ ...d, message: 'Just a fix\n\nNothing to link' } as any, { root: '/r', file: 'a.ts', web: 'https://github.com/o/r', dateText: 'DATE' });
    expect(m).not.toContain('Pull request'); expect(m).not.toContain('$(link)'); expect(m).not.toContain('$(git-pull-request)');
    expect(m).toContain('**Just a fix**\n\nNothing to link');
    expect(m).not.toContain('`#');
  });
  it('drops the revisions group when there is no file', () => {
    const m = p.blameHoverMarkdown(d as any, { root: '/r', web: 'https://github.com/o/r', dateText: 'DATE' });
    expect(m).not.toContain('gitKitchen.blame.');
    expect(m).not.toContain('codicon-diff-multiple'); expect(m).not.toContain('codicon codicon-diff"');
    expect(m).not.toContain('codicon-file-code'); expect(m).not.toContain('codicon-history');
    expect(m).toContain('codicon-compare-changes'); expect(m).toContain('codicon-copy');
    expect(m).toContain('codicon-list-tree'); expect(m).toContain('codicon-search'); expect(m).toContain('codicon-globe');
    expect(p.blameHoverMarkdown(d as any, { root: '/r', file: 'a.ts', dateText: 'DATE' })).not.toContain('codicon-globe');
  });
  it('row cards', () => {
    const b = { name: 'feat/x', current: false, upstream: 'origin/feat/x', ahead: 2, behind: 1, gone: false, sha: 'abc1234', subject: 'Work', time: 0 };
    const bm = p.branchCardMarkdown(b, { root: '/r', state: 'PR #4 open', syncText: '1 behind, 2 ahead', freshness: 'fresh', author: 'Ann', when: '1 day ago', pr: { number: 4, state: 'OPEN', url: 'https://g/4' } });
    expect(bm).toContain('**feat/x**'); expect(bm).toContain('PR #4 open · 1 behind, 2 ahead'); expect(bm).toContain('$(arrow-down) 1 $(arrow-up) 2'); expect(bm).toContain('[PR #4](https://g/4) open'); expect(bm).toContain('$(pulse) fresh');
    expect(p.stashCardMarkdown({ index: 0, ref: 'stash@{0}', sha: 's', message: 'On main: wip', date: '' }, { branch: 'main', dateText: 'D', when: 'now', files: 2, insertions: 3, deletions: 1 })).toMatch(/\$\(files\) 2 files · .*\+3.*-1/);
    expect(p.worktreeCardMarkdown({ path: '/w', head: 'abcdef12', branch: 'b', bare: false, detached: false, locked: false, prunable: false, main: false }, { dirty: true, subject: 'S' })).toContain('$(circle-filled) uncommitted changes');
    expect(p.remoteCardMarkdown({ name: 'origin', fetchUrl: 'f', pushUrl: 'p', branches: 3, web: 'https://g' })).toContain('3 branches');
    const pr = p.prCardMarkdown({ number: 7, title: 'Add', headRefName: 'h', baseRefName: 'main', url: 'https://g/7', isDraft: false, reviewDecision: 'APPROVED', author: 'ann', checks: 'pass', mergeable: 'MERGEABLE' }, { avatar: 'https://a' });
    expect(pr).toContain('<img src="https://a"'); expect(pr).toContain('$(pass) checks passing'); expect(pr).toContain('`main` ← `h`');
    expect(p.syncGroupCardMarkdown('Incoming', 3, 'main', 'origin/main')).toContain('3 commits to pull from `origin/main` into `main`');
  });
});

describe('isNewerVersion', () => {
  it('compares x.y.z', () => {
    expect(p.isNewerVersion('0.3.2', '0.3.1')).toBe(true);
    expect(p.isNewerVersion('v0.4.0', '0.3.9')).toBe(true);
    expect(p.isNewerVersion('0.3.1', '0.3.1')).toBe(false);
    expect(p.isNewerVersion('0.3.0', '0.3.1')).toBe(false);
  });
});

describe('prStatus', () => {
  const base = { isDraft: false, mergeable: 'MERGEABLE', checks: 'pass' as const, reviewDecision: 'APPROVED' };
  it('picks one state in priority order', () => {
    expect(p.prStatus({ ...base, isDraft: true, mergeable: 'CONFLICTING' })).toBe('draft');
    expect(p.prStatus({ ...base, mergeable: 'CONFLICTING' })).toBe('blocked');
    expect(p.prStatus({ ...base, checks: 'fail' })).toBe('blocked');
    expect(p.prStatus({ ...base, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes requested');
    expect(p.prStatus({ ...base, reviewDecision: 'REVIEW_REQUIRED' })).toBe('needs review');
    expect(p.prStatus({ ...base, checks: 'pending' })).toBe('checks pending');
    expect(p.prStatus(base)).toBe('ready to merge');
  });
  it('treats unknown merge state and no review as ready', () => {
    expect(p.prStatus({ ...base, mergeable: 'UNKNOWN', reviewDecision: '', checks: 'none' })).toBe('ready to merge');
  });
});

describe('remoteCheckoutArgs', () => {
  it('fetches the branch before creating the tracking branch', () => {
    expect(p.remoteCheckoutArgs('origin/feat/x')).toEqual({ fetch: ['fetch', 'origin', 'feat/x'], switch: ['switch', '--track', 'origin/feat/x'] });
  });
  it('refuses a name without a remote and branch', () => {
    expect(() => p.remoteCheckoutArgs('main')).toThrow();
    expect(() => p.remoteCheckoutArgs('origin/')).toThrow();
  });
});
