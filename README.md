# Git Kitchen

A lightweight git toolkit for VS Code and Cursor. Git Kitchen adds branches, remotes, stashes, worktrees,
GitHub pull requests and more to the Source Control panel, plus inline blame and file history in the editor.
It runs the `git` and `gh` command-line tools you already have. No accounts, no paid tiers.

## Features

### Source Control views
- **Commits**: commits on the current branch (50 at a time, with load more); expand a commit to its changed
  files and click one for a side-by-side diff.
- **Branches**: switch, create, rename, delete, merge into current, rebase current onto, reset current to tip,
  pull, fetch, change upstream, create tag, open on remote, copy name, and compare with upstream, HEAD,
  common base or the working tree (or select any two branches to compare). Branches are grouped into folders by their
  `/` prefix (`feat/`, `fix/`, ...) or shown as a flat list, with upstream tracking, ahead/behind counts,
  last-commit time, worktree markers and pull request badges.
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
- **Not on Client Remote**: commits on one remote's main branch that are missing from another remote.
- **Merged Branches**: branches already merged into main, deleted only after you confirm each one.
- **TODOs**: `TODO` and `FIXME` comments across the repository, grouped by file.

### Editor
- Current-line blame (author, relative time, message) at the end of the line, with a subtle current-line highlight.
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
| `gitKitchen.branches.layout` | `tree` | `tree` groups branches by `/` prefix; `list` shows them flat. |
| `gitKitchen.heatmap.location` | `gutter` | Draw the heatmap in the `gutter` or as a line `background`. |
| `gitKitchen.codeLens.enabled` | `true` | Show the author code lens. |
| `gitKitchen.codeLens.symbols` | `true` | Also show it above functions and classes. |
| `gitKitchen.mainBranch` | `main` | Main branch for merged cleanup, pull request base and the remote comparison. |
| `gitKitchen.dualRemote.source` | `origin` | Remote whose commits are checked. |
| `gitKitchen.dualRemote.target` | _(empty)_ | Remote to compare against. |

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
