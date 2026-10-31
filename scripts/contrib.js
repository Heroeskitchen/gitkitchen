const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync('package.json'));
const C = []; const menus = { 'view/title': [], 'view/item/context': [], 'editor/title': [], 'gitKitchen.annotations': [], 'editor/context': [], 'explorer/context': [], commandPalette: [] };
function c(id, title, ic, opt = {}) { C.push({ command: id, title, category: 'Git Kitchen', ...(ic ? { icon: `$(${ic})` } : {}) }); if (opt.hidePalette) menus.commandPalette.push({ command: id, when: 'false' }); }
function item(id, when, group) { menus['view/item/context'].push({ command: id, when, group }); }
function title(id, view, group = 'navigation') { menus['view/title'].push({ command: id, when: `view == ${view}`, group }); }
const V = v => `view == gitKitchen.${v}`;
c('gitKitchen.refresh', 'Refresh', 'refresh');
for (const v of ['commits', 'branches', 'remotes', 'stashes', 'worktrees', 'prs', 'dual', 'merged', 'todos', 'history']) title('gitKitchen.refresh', `gitKitchen.${v}`, 'navigation@9');
// Branches
const B = `${V('branches')} && viewItem =~ /^branch/`, NC = `${B} && viewItem =~ /^branch(?!\\.current)/`;
const br = [
  ['switch', 'Switch to Branch', 'arrow-swap', NC, '1_a@1'], ['create', 'Create Branch…', 'git-branch-create', B, '1_a@2'], ['rename', 'Rename…', null, B, '1_a@3'], ['delete', 'Delete…', 'trash', NC, '1_a@9'],
  ['merge', 'Merge into Current Branch', 'git-merge', NC, '2_b@1'], ['rebase', 'Rebase Current Branch onto…', null, NC, '2_b@2'], ['reset', 'Reset Current Branch to Tip…', null, NC, '2_b@3'],
  ['pull', 'Pull', 'arrow-down', `${B} && viewItem =~ /tracked/`, '3_c@1'], ['fetch', 'Fetch', 'sync', B, '3_c@2'], ['setUpstream', 'Change Upstream…', null, B, '3_c@3'],
  ['createTag', 'Create Tag…', 'tag', B, '4_d@1'], ['openOnRemote', 'Open on Remote', 'link-external', B, '4_d@2'], ['copyName', 'Copy Name', 'copy', B, '4_d@3'],
  ['compareUpstream', 'Compare with Upstream', null, `${B} && viewItem =~ /tracked/`, '5_e@1'], ['compareHead', 'Compare with HEAD', null, NC, '5_e@2'], ['compareBase', 'Compare with Common Base', null, NC, '5_e@3'],
  ['compareWorking', 'Compare Working Tree to Here', null, B, '5_e@4'], ['selectForCompare', 'Select for Compare', null, B, '5_e@5'],
];
for (const [id, t, ic, w, g] of br) { c(`gitKitchen.branch.${id}`, t, ic, { hidePalette: !['switch', 'create'].includes(id) }); item(`gitKitchen.branch.${id}`, w, g); }
c('gitKitchen.branch.compareSelected', 'Compare with Selected', null, { hidePalette: true }); item('gitKitchen.branch.compareSelected', `${B} && gitKitchen.hasCompareSelection`, '5_e@6');
item('gitKitchen.branch.switch', NC, 'inline@1');
title('gitKitchen.branch.create', 'gitKitchen.branches', 'navigation@1');
// Worktree from branch
c('gitKitchen.worktree.create', 'Create Worktree…', 'repo', { hidePalette: true }); item('gitKitchen.worktree.create', `${B} && viewItem =~ /noWorktree/ && viewItem =~ /^branch(?!\\.current)/`, '6_wt@1');
c('gitKitchen.worktree.createNewBranch', 'Create Worktree from New Branch…', 'repo-forked'); item('gitKitchen.worktree.createNewBranch', B, '6_wt@2'); title('gitKitchen.worktree.createNewBranch', 'gitKitchen.worktrees', 'navigation@1');
const WT = `(${V('worktrees')} && viewItem =~ /^worktree/) || (${B} && viewItem =~ /\\.worktree/)`;
const WTX = `${V('worktrees')} && viewItem =~ /^worktree(?!\\.main)/`;
for (const [id, t, ic, w, g] of [
  ['openNewWindow', 'Open Worktree in New Window', 'empty-window', WT, '6_wt@3'], ['openHere', 'Open Worktree in This Window', 'window', WT, '6_wt@4'], ['reveal', 'Reveal in File Explorer', null, WT, '6_wt@5'], ['terminal', 'Open Terminal Here', 'terminal', WT, '6_wt@6'],
  ['lock', 'Lock Worktree…', 'lock', `${WTX} && viewItem != worktree.locked`, '7_wt@1'], ['unlock', 'Unlock Worktree', 'unlock', `${V('worktrees')} && viewItem == worktree.locked`, '7_wt@2'],
  ['move', 'Move Worktree…', null, WTX, '7_wt@3'], ['remove', 'Remove Worktree…', 'trash', `${WTX} || (${B} && viewItem =~ /\\.worktree/)`, '7_wt@9']]) { c(`gitKitchen.worktree.${id}`, t, ic, { hidePalette: true }); item(`gitKitchen.worktree.${id}`, w, g); }
item('gitKitchen.worktree.openNewWindow', `${V('worktrees')} && viewItem =~ /^worktree/`, 'inline@1');
c('gitKitchen.worktree.prune', 'Prune Stale Worktrees', 'clear-all'); title('gitKitchen.worktree.prune', 'gitKitchen.worktrees', 'navigation@2');
// PR from branch
c('gitKitchen.pr.create', 'Create Pull Request…', 'git-pull-request-create'); item('gitKitchen.pr.create', `${B} && viewItem =~ /^branch(?!.*hasPr)/`, '8_pr@1'); title('gitKitchen.pr.create', 'gitKitchen.prs', 'navigation@1');
c('gitKitchen.pr.open', 'Open Pull Request on GitHub', 'link-external', { hidePalette: true }); item('gitKitchen.pr.open', `(${V('prs')} && viewItem == pr)`, '1_a@1'); item('gitKitchen.pr.open', `${B} && viewItem =~ /hasPr/`, '8_pr@2'); item('gitKitchen.pr.open', `${V('prs')} && viewItem == pr`, 'inline@1');
for (const [id, t, g] of [['checkout', 'Check Out', '1_a@2'], ['compare', 'Compare Changes', '1_a@3'], ['merge', 'Merge…', '2_m@1'], ['squash', 'Squash and Merge…', '2_m@2'], ['rebase', 'Rebase and Merge…', '2_m@3']]) { c(`gitKitchen.pr.${id}`, t, null, { hidePalette: true }); item(`gitKitchen.pr.${id}`, `${V('prs')} && viewItem == pr`, g); }
// Remotes
for (const [id, t, ic, g] of [['fetch', 'Fetch', 'sync', '1@1'], ['pull', 'Pull Current Branch', 'arrow-down', '1@2'], ['push', 'Push Current Branch…', 'arrow-up', '1@3']]) { c(`gitKitchen.remote.${id}`, t, ic, { hidePalette: true }); item(`gitKitchen.remote.${id}`, `${V('remotes')} && viewItem == remote`, g); }
item('gitKitchen.remote.fetch', `${V('remotes')} && viewItem == remote`, 'inline@1');
c('gitKitchen.remoteBranch.checkout', 'Check Out', 'arrow-swap', { hidePalette: true }); item('gitKitchen.remoteBranch.checkout', `${V('remotes')} && viewItem == remoteBranch`, '1@1');
c('gitKitchen.remoteBranch.compareHead', 'Compare with HEAD', null, { hidePalette: true }); item('gitKitchen.remoteBranch.compareHead', `${V('remotes')} && viewItem == remoteBranch`, '1@2');
// Stashes
c('gitKitchen.stash.save', 'Stash Changes…', 'add'); title('gitKitchen.stash.save', 'gitKitchen.stashes', 'navigation@1');
c('gitKitchen.stash.stashAndSwitch', 'Stash and Switch…', 'arrow-swap'); title('gitKitchen.stash.stashAndSwitch', 'gitKitchen.stashes', 'navigation@2'); item('gitKitchen.stash.stashAndSwitch', NC, '1_a@1.5');
for (const [id, t, ic, g] of [['apply', 'Apply Stash', 'check', '1@1'], ['pop', 'Pop Stash', 'arrow-up', '1@2'], ['drop', 'Drop Stash…', 'trash', '2@9']]) { c(`gitKitchen.stash.${id}`, t, ic, { hidePalette: true }); item(`gitKitchen.stash.${id}`, `${V('stashes')} && viewItem == stash`, g); }
item('gitKitchen.stash.apply', `${V('stashes')} && viewItem == stash`, 'inline@1');
c('gitKitchen.stash.openFile', 'Open Changes', null, { hidePalette: true }); c('gitKitchen.stash.compareWorking', 'Compare with Working File', null, { hidePalette: true }); item('gitKitchen.stash.compareWorking', `${V('stashes')} && viewItem == stashFile`, '1@1');
// Commits (history, PR commits, dual)
const CM = `viewItem == commit || viewItem == historyCommit`;
c('gitKitchen.openCommitDiff', 'Open Changes with Previous', 'diff', {}); item('gitKitchen.openCommitDiff', CM, '1@1');
c('gitKitchen.compareCommitWorking', 'Compare with Working Copy', null, {}); c('gitKitchen.history.compareWorking', 'Compare with Working Copy', null, { hidePalette: true }); item('gitKitchen.history.compareWorking', CM, '1@2');
c('gitKitchen.commit.openAllFiles', 'Open All Changed Files', null, { hidePalette: true }); item('gitKitchen.commit.openAllFiles', CM, '1@3');
c('gitKitchen.commit.copyLink', 'Copy Link', 'link', { hidePalette: true }); item('gitKitchen.commit.copyLink', CM, '2@1');
c('gitKitchen.commit.copySha', 'Copy SHA', null, { hidePalette: true }); item('gitKitchen.commit.copySha', CM, '2@2');
c('gitKitchen.commit.openOnGitHub', 'Open on GitHub', 'github', { hidePalette: true }); item('gitKitchen.commit.openOnGitHub', CM, '2@3');
// Blame / editor
c('gitKitchen.blame.toggleFile', 'Toggle File Blame', 'person');
c('gitKitchen.blame.toggleLine', 'Toggle Line Blame');
c('gitKitchen.blame.openLineCommit', 'Open Changes for Current Line');
c('gitKitchen.copyCommitLink', 'Copy Commit Link with Line');
c('gitKitchen.fileHistory', 'File History', 'history');
menus['editor/title'].push({ command: 'gitKitchen.fileHistory', when: 'resourceScheme == file', group: 'navigation@90' });
menus['editor/context'].push({ command: 'gitKitchen.copyCommitLink', when: 'resourceScheme == file', group: '9_gitkitchen@1' }, { command: 'gitKitchen.blame.openLineCommit', when: 'resourceScheme == file', group: '9_gitkitchen@2' }, { command: 'gitKitchen.fileHistory', when: 'resourceScheme == file', group: '9_gitkitchen@3' });
menus['explorer/context'].push({ command: 'gitKitchen.fileHistory', when: '!explorerResourceIsFolder', group: '9_gitkitchen@1' });
// Commits view
c('gitKitchen.commits.loadMore', 'Load More Commits', null, { hidePalette: true });
c('gitKitchen.diffFile', 'Open Changes', null, { hidePalette: true });
// Revision navigation
c('gitKitchen.rev.prev', 'Open Previous Revision', 'arrow-left'); c('gitKitchen.rev.next', 'Open Next Revision', 'arrow-right'); c('gitKitchen.rev.choose', 'Choose Revision…', 'versions');
menus['editor/title'].push({ command: 'gitKitchen.rev.prev', when: 'resourceScheme == file || resourceScheme == gitkitchen', group: 'navigation@80' },
  { command: 'gitKitchen.rev.choose', when: 'resourceScheme == file || resourceScheme == gitkitchen', group: 'navigation@81' },
  { command: 'gitKitchen.rev.next', when: 'resourceScheme == gitkitchen || isInDiffEditor && resourceScheme == file', group: 'navigation@82' });
// Annotations submenu
c('gitKitchen.annotations.heatmap', 'Toggle File Heatmap'); c('gitKitchen.annotations.changes', 'Toggle File Changes…'); c('gitKitchen.annotations.settings', 'Open Annotation Settings');
c('gitKitchen.lens.blame', 'Show File Blame', null, { hidePalette: true });
menus['gitKitchen.annotations'].push({ command: 'gitKitchen.blame.toggleFile', group: '1@1' }, { command: 'gitKitchen.annotations.heatmap', group: '1@2' }, { command: 'gitKitchen.annotations.changes', group: '1@3' }, { command: 'gitKitchen.annotations.settings', group: '2@1' });
menus['editor/title'].push({ submenu: 'gitKitchen.annotations', when: 'resourceScheme == file', group: 'navigation@91' });
// Dual + merged
c('gitKitchen.dual.chooseRemote', 'Choose Remotes to Compare…', 'settings-gear'); title('gitKitchen.dual.chooseRemote', 'gitKitchen.dual', 'navigation@1');
c('gitKitchen.dual.fetch', 'Fetch All Remotes', 'sync'); title('gitKitchen.dual.fetch', 'gitKitchen.dual', 'navigation@2');
c('gitKitchen.merged.delete', 'Delete Branch…', 'trash', { hidePalette: true }); item('gitKitchen.merged.delete', `${V('merged')} && viewItem == mergedBranch`, 'inline@1'); item('gitKitchen.merged.delete', `${V('merged')} && viewItem == mergedBranch`, '1@1');
c('gitKitchen.merged.reviewAll', 'Review Merged Branches One by One…', 'checklist'); title('gitKitchen.merged.reviewAll', 'gitKitchen.merged', 'navigation@1');
// Explorer
const FW = '(explorerResourceIsFolder || resourceExtname == .code-workspace)';
c('gitKitchen.explorer.reopenHere', 'Reopen Here', null, { hidePalette: true }); c('gitKitchen.explorer.openNewWindow', 'Open in New Window', null, { hidePalette: true });
c('gitKitchen.explorer.setDefaultWorkspace', 'Set as Default Workspace for This Folder', null, { hidePalette: true }); c('gitKitchen.explorer.clearDefaultWorkspace', 'Clear Default Workspace', null, { hidePalette: true });
menus['explorer/context'].push({ command: 'gitKitchen.explorer.reopenHere', when: FW, group: '0_open@1' }, { command: 'gitKitchen.explorer.openNewWindow', when: FW, group: '0_open@2' },
  { command: 'gitKitchen.explorer.setDefaultWorkspace', when: 'resourceExtname == .code-workspace && resource not in gitKitchen.defaultWorkspaceFiles', group: '0_open@3' },
  { command: 'gitKitchen.explorer.clearDefaultWorkspace', when: 'resourceExtname == .code-workspace && resource in gitKitchen.defaultWorkspaceFiles', group: '0_open@3' });
pkg.contributes = {
  commands: C, menus,
  submenus: [{ id: 'gitKitchen.annotations', label: 'File Annotations', icon: '$(eye)' }],
  colors: [{ id: 'gitKitchen.currentLineBackground', description: 'Background of the current line while line blame is shown.', defaults: { dark: '#ffffff0b', light: '#0000000a', highContrast: null, highContrastLight: null } }],
  views: { scm: [
    { id: 'gitKitchen.commits', name: 'Commits' }, { id: 'gitKitchen.branches', name: 'Branches' }, { id: 'gitKitchen.remotes', name: 'Remotes' }, { id: 'gitKitchen.stashes', name: 'Stashes' }, { id: 'gitKitchen.worktrees', name: 'Worktrees' },
    { id: 'gitKitchen.prs', name: 'Pull Requests' }, { id: 'gitKitchen.history', name: 'File History' }, { id: 'gitKitchen.dual', name: 'Not on Client Remote', visibility: 'collapsed' },
    { id: 'gitKitchen.merged', name: 'Merged Branches', visibility: 'collapsed' }, { id: 'gitKitchen.todos', name: 'TODOs', visibility: 'collapsed' } ] },
  keybindings: [{ command: 'gitKitchen.fileHistory', key: 'alt+h', when: 'editorTextFocus || resourceScheme == file' }],
  configuration: { title: 'Git Kitchen', properties: {
    'gitKitchen.blame.currentLine': { type: 'boolean', default: true, description: 'Show blame at the end of the current line.' },
    'gitKitchen.blame.highlightLine': { type: 'boolean', default: true, description: 'Highlight the whole current line while line blame is shown.' },
    'gitKitchen.branches.layout': { type: 'string', enum: ['tree', 'list'], default: 'tree', description: 'Show branches grouped into folders by their / prefix, or as a flat list.' },
    'gitKitchen.heatmap.location': { type: 'string', enum: ['gutter', 'background'], default: 'gutter', description: 'Where the file heatmap is drawn.' },
    'gitKitchen.codeLens.enabled': { type: 'boolean', default: true, description: 'Show the last author and author count above the file and its functions and classes.' },
    'gitKitchen.codeLens.symbols': { type: 'boolean', default: true, description: 'Also show the code lens above functions and classes, not only at the top of the file.' },
    'gitKitchen.blame.hover': { type: 'boolean', default: true, description: 'Show commit details on hover.' },
    'gitKitchen.mainBranch': { type: 'string', default: 'main', description: 'Main branch used for merged cleanup, PR base and the client remote view.' },
    'gitKitchen.dualRemote.source': { type: 'string', default: 'origin', description: 'Our remote.' },
    'gitKitchen.dualRemote.target': { type: 'string', default: '', description: 'Client remote to compare against.' } } }
};
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(C.length, 'commands');
