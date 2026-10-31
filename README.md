# Git Kitchen

A lightweight git toolkit for VS Code and Cursor. Git Kitchen adds branches, remotes, stashes, worktrees,
GitHub pull requests and more to the Source Control panel, plus inline blame and file history in the editor.
It runs the `git` and `gh` command-line tools you already have. No accounts, no paid tiers.

## Features

### Source Control views
- **Branches**: switch, create, rename, delete, merge into current, rebase current onto, reset current to tip,
  pull, fetch, change upstream, create tag, open on remote, copy name, and compare with upstream, HEAD,
  common base or the working tree (or select any two branches to compare). Shows ahead/behind counts,
  worktree markers and pull request badges.
- **Remotes**: fetch, pull and push per remote; expand to browse and check out remote branches.
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
- Current-line blame (author, relative time, message) at the end of the line.
- Full-file blame toggle in the editor title bar.
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
