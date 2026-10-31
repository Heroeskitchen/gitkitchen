# Git Kitchen

A lightweight git toolkit for VS Code and Cursor. Git Kitchen adds branches, remotes, stashes, worktrees,
GitHub pull requests and more to the Source Control panel, plus inline blame and file history in the editor.
It runs the `git` and `gh` command-line tools you already have. No accounts, no paid tiers.

## Features

### Source Control views
- **Commits**: commits on the current branch (50 at a time, with load more); expand a commit to its changed
  files, shown as a folder tree (single-folder chains compacted) with M/A/D/R badges, and click one for a
  side-by-side diff against the parent. While a merge, rebase, cherry-pick or revert is in progress, a row at the top
  shows the operation and the conflicts remaining, with Continue, Skip (rebase only) and Abort (after a confirm).
  Worktrees are supported.
- **Branches**: switch, create, rename, delete, merge into current, rebase current onto, reset current to tip,
  pull, fetch, change upstream, create tag, open on remote, copy name, and compare with upstream, HEAD,
  common base or the working tree (or select any two branches to compare). Branches are grouped into folders by their
  `/` prefix (`feat/`, `fix/`, ...) or shown as a flat list, with upstream tracking, ahead/behind counts,
  last-commit time, worktree markers and pull request badges. Expand a branch to browse its commits.
  Icons show state: the active branch is a filled green check, an open pull request shows the pull request icon
  (draft or ready), a branch merged into main shows the merge icon, a worktree branch shows the worktree icon.
  Other branches are tinted by freshness (fresh, aging, stale) with the numbers in the tooltip. Hover a row for
  inline actions: pull, push and create pull request on the current branch; switch, compare with the current
  branch and create or open a pull request on the others.
- **Remotes**: fetch, pull and push per remote; expand to browse remote branches (grouped by prefix) and check them out.
- **Stashes**: save (optionally with untracked files), apply, pop, drop, view changed files as diffs,
  hover preview, and stash-and-switch in one step.
- **Worktrees**: each worktree with its branch, dirty marker and ahead/behind counts. Create a worktree from
  any branch (default folder `<repo>/worktrees/<branch>`, or choose one) or from a new branch; open in a new or
  the current window, reveal, open a terminal, lock/unlock, move, remove and prune.
- **Pull Requests**: open GitHub pull requests with check status and review state. Open, check out, compare,
  and merge, squash-merge or rebase-merge. Create a pull request from any branch with the title and body
  prefilled from its commits.
- **File History**: every commit that touched the current file.
- **Compare Remotes**: commits on one remote's main branch that are missing from another remote. Shown only when the repository has more than one remote. With two remotes it compares `origin` (or the current branch's upstream remote, or the first alphabetically) against the other; with more it asks once which pair to compare. The title bar can swap the direction or pick another pair, and the choice is saved per folder.
- **Merged Branches**: branches already merged into main, deleted only after you confirm each one.
- **TODOs**: `TODO` and `FIXME` comments across the repository, grouped by file.

### Editor
- **Commit details hover** (blame hover, commit rows and status bar): author with GitHub avatar, relative and exact
  time, short SHA (click to copy), files added/changed/deleted, lines added and deleted, the full message with
  `#123` linked to the pull request, and the remote branches containing the commit.
- Current-line blame (author, relative time, message) at the end of the line, with a subtle current-line highlight.
- Status bar blame for the current line (author and relative time); click it to open the commit's changes.
- The blame hover includes the line's diff hunk from the commit that last changed it.
- Other lines from the same commit are highlighted while the cursor is on a line or you hover its blame.
- Gutter markers for added, changed and deleted lines against HEAD, including unsaved edits.
- Code lens at the top of the file and above functions and classes: last author and time (opens that commit's
  changes) and the number of authors (shows file blame).
- **Previous / Next Revision** and **Choose Revision** buttons in the editor title to step through the file's history
  in the diff editor.
- **File Annotations** menu in the editor title: Toggle File Blame, Toggle File Heatmap (gutter or background,
  colored by line age), Toggle File Changes (lines changed since a chosen commit or HEAD), and Open Annotation Settings.
- Commit hover with links to open the changes, compare with the working file, or copy a link.
- **Copy Commit Link with Line**: a GitHub permalink to the selected lines.
- **File History** (`Alt+H`): click a commit for a side-by-side diff against its parent; right-click to compare
  with the working copy, copy the link or open it on GitHub.

### Explorer
- **Reopen Here** and **Open in New Window** on folders and `.code-workspace` files.
- **Set as Default Workspace for This Folder** / **Clear Default Workspace** on `.code-workspace` files.
  When the folder is opened, it reopens as that workspace.

Destructive actions (delete, drop, reset, remove, prune, push, merge) ask for confirmation first.

## Requirements
- [git](https://git-scm.com/) on your `PATH`.
- [GitHub CLI](https://cli.github.com/) (`gh`), signed in with `gh auth login`, for the Pull Requests view
  and pull request badges. Everything else works without it.

## Install

### From GitHub Releases
```sh
gh release download -R Heroeskitchen/gitkitchen -p "*.vsix"
cursor --install-extension gitkitchen-<version>.vsix   # Cursor
code --install-extension gitkitchen-<version>.vsix     # VS Code
```

### From a .vsix file
Download or build `gitkitchen-<version>.vsix`, then run `cursor --install-extension <file>` or
`code --install-extension <file>`, or use **Extensions: Install from VSIX…** in the command palette.

## Settings
| Setting | Default | Description |
| --- | --- | --- |
| `gitKitchen.blame.currentLine` | `true` | Show blame at the end of the current line. |
| `gitKitchen.blame.hover` | `true` | Show commit details on hover. |
| `gitKitchen.blame.highlightLine` | `true` | Highlight the current line while line blame is shown. |
| `gitKitchen.statusBar.enabled` | `true` | Show the current line's author and time in the status bar. |
| `gitKitchen.blame.changesHover` | `true` | Show the line's diff hunk in the blame hover. |
| `gitKitchen.blame.highlightSameCommit` | `true` | Highlight other lines from the same commit. |
| `gitKitchen.changes.gutter` | `true` | Mark added, changed and deleted lines against HEAD in the gutter. |
| `gitKitchen.branches.layout` | `tree` | `tree` groups branches by `/` prefix; `list` shows them flat. |
| `gitKitchen.heatmap.location` | `gutter` | Draw the heatmap in the `gutter` or as a line `background`. |
| `gitKitchen.codeLens.enabled` | `true` | Show the author code lens. |
| `gitKitchen.codeLens.symbols` | `true` | Also show it above functions and classes. |
| `gitKitchen.mainBranch` | `main` | Main branch for merged cleanup, pull request base and the remote comparison. |
| `gitKitchen.dualRemote.source` | _(auto)_ | Base remote for Compare Remotes (saved per folder). |
| `gitKitchen.dualRemote.target` | _(auto)_ | Remote to compare against (saved per folder). |
| `gitKitchen.files.layout` | `tree` | Show a commit's files as a folder `tree` or a flat `list`. |
| `gitKitchen.staleness.agingDays` | `14` | Days without commits before a branch counts as aging. |
| `gitKitchen.staleness.staleDays` | `60` | Days without commits before a branch counts as stale. |
| `gitKitchen.staleness.behindCount` | `20` | Commits behind before a branch counts as stale. |
| `gitKitchen.branches.colorLabels` | `true` | Color branch names with the same active or freshness color as their icon. |

## Development
```sh
npm install
npm test           # unit tests (Vitest)
npm run smoke      # headless VS Code smoke test; on Linux: xvfb-run -a npm run smoke
npm run package    # builds gitkitchen-<version>.vsix
```

Built with AI-assisted development.

## License
[MIT](LICENSE)
