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
    const r = p.parseRemotes('origin\tgit@github.com:acme/x.git (fetch)\norigin\tgit@github.com:acme/x.git (push)\nclient\thttps://github.com/c/y (fetch)\n');
    expect(r.map(x => x.name)).toEqual(['origin', 'client']);
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
    expect(p.defaultWorktreePath('/r/', 'feat/x')).toBe('/r/worktrees/feat-x');
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
