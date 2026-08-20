# Changelog

## 0.1.3

- Route active files to the deepest matching nested repository and keep lightweight startup discovery from flooding the system with Git commands.
- Make rollback, operation-state, first-push, runner cancellation, large-output, binary diff, and invalid-revision behavior safer and more predictable.
- Add guided Worktree, Remote, Stash, and Submodule management flows and make context-sensitive commands usable from the Command Palette.
- Virtualize large histories, move author/date filtering into Git, cap history loading, and keep filter and context menus stable during background refreshes.
- Match the commit graph to real visible topology, keep graph lanes interactive, and improve narrow-window and independently resizable three-column layouts.
- Improve the three-pane merge editor with bounded draft persistence, syntax highlighting, smarter scroll alignment, responsive panes, and clearer Chinese labels.
- Preserve newly added files when rolling back staged changes, restore staged renames completely, and support unstaging before the first commit.

## 0.1.2

- Debounce repository refreshes, narrow Git metadata watchers, cache stable snapshots, and stop loading Log data while another tool-window tab is active.
- Preserve context menus, filters, focus, selections, and scroll positions while repository state updates in the background.
- Add progressive history loading, clearer search scope, safer path filtering, synchronized filtered selection, and compact ref labels.
- Improve Local Changes with repository-scoped selections and drafts, collapsible changelists, keyboard navigation, responsive splitters, and guarded commit actions.
- Add an incremental, filterable Git Console that hides successful background queries by default and caps retained command output.
- Reuse branch-comparison sessions, add changed-file search/status filters, guard asynchronous selections, and handle binary files explicitly.
- Persist merge-conflict drafts, detect externally changed files before Apply, improve conflict navigation and scroll synchronization, and confirm destructive whole-file choices.
- Validate user-provided Git names and paths, add cancellation to network operations, improve accessibility and responsive layout, and add initial Chinese UI localization.

## 0.1.1

- Stabilize context menus and filter popovers during background repository refreshes.
- Scope commit graph lanes to visible branch and tag refs instead of internal Git refs.
- Remove the obsolete five-button action strip from commit details.
- Add an IntelliJ-inspired three-pane merge conflict editor and improve branch comparison diffs.
- Keep release metadata and VSIX installation documentation aligned through an automated version test.

## 0.1.0-alpha.4

- Replace nine fragmented Tree Views and the Activity Bar view with one IntelliJ-inspired bottom Git tool window.
- Unify Log, Console, Local Changes, and Shelf as tabs inside the bottom Panel instead of opening a sidebar or editor tab.
- Add Changelist-grouped file selection, inline change actions, commit options, Commit and Push, and Shelf workflows.
- Add a three-pane Log with branch filters, a colored commit graph, commit search, changed files, details, and commit actions.
- Add a credential-redacted Git Console, VCS-style branch popup, Git operations popup, and one-key Extension Host launch configuration.
- Make Log commits and Changed Files selectable by mouse or keyboard, and open file-specific commit diffs on double-click.
- Strip record-separator newlines from parsed commit hashes so every Log row, not only the first one, can be selected.
- Keep the Log table header and rows in one stable scroll area without jumping when commit details load.
- Add IntelliJ-style context menus for branches, commits, and changed files, backed by validated Git operations.
- Group changed files by folder and add a persistent draggable splitter for resizing the commit details pane.
- Add persistent horizontal resizing for all three Log columns, Command/Ctrl branch multi-selection, branch comparison, and Branch/User/Date/Paths/order filters.
- Replace raw Show Files Diff output with a Changes Between file tree and native side-by-side, syntax-highlighted file diffs.
- Add an IntelliJ-inspired three-pane merge conflict editor with an editable result, per-block Left/Both/Right choices, conflict navigation, resizable panes, deletion handling, and automatic staging on Apply.
- Keep context menus and filter popovers open during background repository refreshes, scope graph lanes to visible branch/tag refs instead of internal Git refs, and remove the five-button commit-detail action strip.

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
