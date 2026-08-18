# JB Git

JB Git is a VS Code extension project that brings an IntelliJ IDEA-inspired Git workspace to VS Code.

The implementation is intentionally layered:

- Git Core executes the user's system `git` binary with safe argument arrays.
- Repository state is parsed from machine-readable Git output and refreshed incrementally.
- The extension host owns Git operations; the UI is built with VS Code Tree Views and output/diff surfaces.
- Changelists, Shelf, hunk staging, history, conflict actions, Worktrees, Remotes, Stashes, and Submodules are implemented as independent layers.
- CI validates core behavior on Windows, macOS, and Linux, plus Extension Host activation on VS Code 1.95 and stable.

## Current status

The local MVP now covers repository discovery, porcelain-v2 status, Local Changes with staged/unstaged/untracked/conflict groups, file and hunk stage/unstage, diff, commit/amend/sign-off/no-verify, branches/tags, fetch/pull/push, remotes, stash, shelf, changelists, history/file history, blame, merge/rebase/cherry-pick/revert/reset, continue/abort/skip, conflict ours/theirs/mark-resolved, Worktrees, Submodules, Clone, Sparse Checkout, Patch import, LFS pull, and Bisect.

This is behavior-compatible Git infrastructure, not a claim of complete IntelliJ UI parity. The remaining high-risk work is tracked in `docs/implementation-plan.md`: a full interactive log-graph Webview, three-way conflict editor, interactive rebase editor, multi-root transactional rollback, Git-version capability fallbacks, and release/remote-host hardening.

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
