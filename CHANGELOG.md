# Changelog

## 0.1.0-alpha.4

- Replace nine fragmented Tree Views and the Activity Bar view with one IntelliJ-inspired bottom Git tool window.
- Unify Log, Console, Local Changes, and Shelf as tabs inside the bottom Panel instead of opening a sidebar or editor tab.
- Add Changelist-grouped file selection, inline change actions, commit options, Commit and Push, and Shelf workflows.
- Add a three-pane Log with branch filters, a colored commit graph, commit search, changed files, details, and commit actions.
- Add a credential-redacted Git Console, VCS-style branch popup, Git operations popup, and one-key Extension Host launch configuration.
- Make Log commits and Changed Files selectable by mouse or keyboard, and open file-specific commit diffs on double-click.
- Strip record-separator newlines from parsed commit hashes so every Log row, not only the first one, can be selected.

## 0.1.0-alpha.3

- Harden reset refs, credential redaction, rename-aware Changelist commits, and Shelf transactions.
- Discover nested and bare repositories and refresh linked-worktree metadata.
- Reconcile persisted Changelist paths, surface Tree View errors, and report Shelf deletion failures.
- Validate VS Code 1.95 and stable Extension Hosts and add Windows, macOS, and Linux CI coverage.

## 0.1.0-alpha.2

- Add IDEA-inspired Local Changes, Changelists, Shelf, History, Blame, Remotes, Stashes, Worktrees, Submodules, and conflict workflows.
- Add hunk-level stage/unstage, file history, Bisect, Sparse Checkout, Patch import, LFS pull, Clone, and tag operations.
- Add repository-level integration tests for status, commit, branch, stash, shelf patch, merge conflict, hunk staging, Blame, Worktree, remote, and Bisect behavior.

## 0.1.0-alpha.1

- Initialize the JB Git extension workspace.
- Add the Git Core and repository discovery foundation.
- Add the first Local Changes and Repositories Tree Views.
