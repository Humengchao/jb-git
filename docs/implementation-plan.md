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

