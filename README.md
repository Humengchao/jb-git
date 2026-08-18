# JB Git

Languages: English · 简体中文版本见 `README.zh-CN.md`

JB Git is a VS Code extension project that brings an IntelliJ IDEA-inspired Git workspace to VS Code.

The implementation is intentionally layered:

- Git Core executes the user's system `git` binary with safe argument arrays.
- Repository state is parsed from machine-readable Git output and refreshed incrementally.
- The extension host owns Git operations; the UI uses IntelliJ-inspired Commit and Git Log Webviews plus VS Code diff surfaces.
- Changelists, Shelf, hunk staging, history, conflict actions, Worktrees, Remotes, Stashes, and Submodules are implemented as independent layers.
- CI validates core behavior on Windows, macOS, and Linux, plus Extension Host activation on VS Code 1.95 and stable.

## Current status

The local MVP now covers repository discovery, porcelain-v2 status, a Changelist-based Commit tool window, file and hunk stage/unstage, diff, selected-file commit/amend/sign-off/no-verify, Commit and Push, branches/tags, fetch/pull/push, remotes, stash, shelf, history/file history, blame, merge/rebase/cherry-pick/revert/reset, continue/abort/skip, conflict ours/theirs/mark-resolved, Worktrees, Submodules, Clone, Sparse Checkout, Patch import, LFS pull, and Bisect.

The UI is organized around the same main workflow boundaries as IntelliJ IDEA: a narrow Commit tool window, a wide Git Log with Branches / Commits / Changed Files / Details panes, a branch widget, and an operations popup. This is still an independent VS Code implementation rather than pixel-for-pixel IntelliJ UI parity. Remaining high-risk work is tracked in `docs/implementation-plan.md`: a three-way conflict editor, interactive rebase editor, multi-root transactional rollback, Git-version capability fallbacks, and release/remote-host hardening.

## Development

```bash
npm install
npm run compile
npm test
npm run package
```

Press `F5` in VS Code to launch the Extension Development Host.

## Scope and attribution

The feature behavior is informed by the public IntelliJ Community Git/VCS implementation and documentation. This project is an independent TypeScript implementation; it does not copy JetBrains source code, UI assets, or trademarks.
