# JB Git implementation plan

This repository follows the IDEA-parity plan discussed for the project.

## Milestones

1. P0: behavior map and high-risk proof of concepts for partial commit, multi-repository rollback, operation state, and log graph.
2. P1: Git Core, repository discovery, machine-readable status parsing, operation coordination, and VS Code integration.
3. P2: daily workflow—Local Changes, Diff, Stage/Unstage, Commit, Branch, Fetch/Pull/Push.
4. P3: Changelist, partial commit, Staging Area, Shelf, Patch, History, and Blame.
5. P4: Log Graph, Merge/Rebase/Cherry-pick/Revert/Reset, interactive rebase, and conflict workflow.
6. P5: multi-root, Worktree, Submodule, Sparse Checkout, LFS, Bisect, and large-repository tuning.
7. P6: cross-platform hardening, accessibility, remote extension hosts, CI, and release.

## Reference map

The public IntelliJ Community repository is used as a behavior and test-case reference:

- `plugins/git4idea/backend/src/commands` — Git command execution and output handling.
- `plugins/git4idea/backend/src/repo` — repository state and repository files.
- `plugins/git4idea/backend/src/index` and `status` — index and status behavior.
- `plugins/git4idea/backend/src/branch`, `rebase`, `merge`, `stash` — operation workflows.
- `platform/vcs-impl` — changelists, partial changes, shelf, patch, diff, and merge infrastructure.
- `platform/vcs-log` — commit graph and log data layers.
- `plugins/git4idea/tests` — independent parity test inventory.

The implementation is clean-room TypeScript. Any future source reuse requires per-file license review and attribution.

## Implementation checkpoint

The staged local implementation currently reaches the following checkpoint:

| Milestone | Status | Delivered |
| --- | --- | --- |
| P0 | Foundation complete | Reference map, risk notes, parser and hunk-operation tests |
| P1 | Complete for local extension host | Git Core runner, repository discovery, porcelain-v2 status, serialized mutations, operation-state detection |
| P2 | Complete for MVP workflows | Local Changes, diff, stage/unstage/discard, commit, branch, fetch/pull/push, remotes, clone |
| P3 | Core and primary UI complete | Bottom Git tool window with Local Changes and Shelf tabs, Changelist-based selected-file commit, Patch import, File History, Blame, Stash |
| P4 | Core workflows and Log UI complete | Bottom Log and Console tabs, colored log graph, branch filters, Changed Files and Details panes, Merge/Rebase/Cherry-pick/Revert/Reset, continue/abort/skip, conflict ours/theirs/mark-resolved, Bisect |
| P5 | Partial | Worktree, Submodule, Sparse Checkout, LFS pull; large-repository tuning and full multi-root transaction semantics remain |
| P6 | Partial | Windows/macOS/Linux core CI and VS Code 1.95/stable Extension Host matrix; Git-version fallbacks, accessibility, remote-host testing, release/signing remain |

The current code deliberately stops short of claiming complete IntelliJ parity. The remaining work should be implemented as separate commits: a three-way merge editor, interactive rebase sequencing, full multi-root rollback, large-log indexing/pagination, capability-based command fallbacks, and cross-platform/package verification.
