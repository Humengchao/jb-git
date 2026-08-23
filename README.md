# JB Git

Languages: English · [简体中文](./README.zh-CN.md)

JB Git is a VS Code extension project that brings an IntelliJ IDEA-inspired Git workspace to VS Code.

The implementation is intentionally layered:

- Git Core executes the user's system `git` binary with safe argument arrays.
- Repository state is parsed from machine-readable Git output and refreshed incrementally.
- The extension host owns Git operations; the UI uses one IntelliJ-inspired Git Webview contributed to VS Code's bottom Panel plus native diff surfaces.
- Changelists, Shelf, hunk staging, history, conflict actions, Worktrees, Remotes, Stashes, and Submodules are implemented as independent layers.
- CI validates core behavior on Windows, macOS, and Linux, plus Extension Host activation on VS Code 1.95 and stable.

## Current status

The status terms below are intentional: **Implemented** means the workflow is present in the current tree, **Partial** means it is usable but does not yet match IDEA's depth, **Planned** means it is not implemented, and **Out of scope** is a deliberate non-goal.

| IntelliJ IDEA workflow | Status | JB Git behavior and boundary |
| --- | --- | --- |
| Git tool window and Log | Partial | One bottom `Git` panel provides Log, Console, Local Changes and Shelf. The graph, filters, branch comparison, progressive 300-commit loading and virtualized large lists are implemented; persistent history indexing and exhaustive very-large-repository search are not. |
| HEAD / Index / Working Tree review | Implemented | Local Changes exposes the two distinct comparisons—`HEAD → Index` (staged) and `Index → Working Tree` (unstaged)—with file diff plus text-hunk stage/unstage. Hunk application verifies that the displayed hunk is still current before mutating the Index. |
| Commit sources | Implemented | The commit form has two explicit sources: **Staging area (Index)** commits exactly the staged snapshot, while **Selected files (complete contents)** commits the checked files through an isolated temporary Index. A failed selected-file/Changelist commit leaves the user's real Index intact. |
| Changelists | Partial | Create, rename/describe, activate, delete and move whole files, including rename tracking and selected-Changelist commit. IDEA-style ownership of different hunks or overlapping lines in the same file, task context and changelist-conflict policies remain gaps. |
| Rollback, Shelf and untracked deletion | Implemented | Rolling back a tracked file first keeps a recovery entry in Shelf. An untracked file is moved through the operating system Trash instead of being permanently deleted. Conflicted paths are not individually rolled back because that could discard one side. |
| Branch checkout with local changes | Implemented | Smart Checkout stores tracked, staged and untracked changes in a temporary stash identified by immutable OID, checks out the branch, then restores the Working Tree and Index. A failed or conflicting restore leaves the stash available for recovery. |
| Push safety | Implemented | Push fetches before preview, shows and executes the exact local-ref-to-remote-ref target plus outgoing commits, and supports initial upstream setup. Force push is unavailable whenever the destination branch matches a configurable protected-branch pattern; other destinations only offer Force with Lease. A non-fast-forward rejection on the checked-out branch's existing upstream offers pull-with-rebase or pull-with-merge and then previews again. |
| SHA-1 and SHA-256 object IDs | Implemented | Log selection and protocol validation accept complete 40- and 64-hex object IDs; Git still remains the authority that resolves and validates the object. |
| Merge conflict resolution | Partial | The three-pane editor works the way IDEA's does: the result shows clean file content with no `<<<<<<<` markers, each conflict is a coloured range that follows edits, and the strips between the panes draw connectors from every side chunk to its result region with per-change `»`/`«` apply and `×` ignore actions. Unresolved conflicts are red, applied sides green, hand-edited regions blue and ignored ones grey; applying the second side of a conflict keeps both, and a "changes left to resolve" counter gates the staged Apply. Whole-file choices, navigation (including F7), recoverable drafts, stale-result checks and an editable result remain. Rebase labels correctly identify **Rebase Target** and **Replayed Commit** instead of treating stage 2/3 as ordinary ours/theirs. `JB Git: Resolve Simple Conflicts` replays the merge in `diff3` on copies of the three stages, so each conflict carries its base, and settles the blocks with only one possible outcome: both sides made the same edit, only one side changed the base, or the two differ only in whitespace. A partly resolved file is deliberately left unstaged, and a file containing conflict markers of its own is refused rather than framed by guesswork. The editor does not yet show the base per block, and base/result comparison modes remain. |
| Merge/rebase/cherry-pick/revert/reset operations | Partial | Start plus continue/abort/skip flows are implemented; history-editing depth remains below IDEA. |
| Interactive rebase editor | Implemented | `JB Git: Interactively Rebase from Commit` opens a visual sequence editor for reordering plus `pick`, `reword`, `squash`, `fixup` and `drop`. Message changes are lowered onto a todo Git runs unattended, so no editor is spawned and a rebase paused by a conflict still applies the reworded message after `Continue`. Narrower than IDEA: the starting commit must be an ancestor of HEAD, a range containing merges is refused instead of flattened, a dirty worktree is refused instead of autostashed, and `exec`/`break` rows are not offered. |
| File history and Blame | Partial | File History and command/output Blame are implemented, including literal special-path handling. |
| Editor-gutter Blame | Planned | Inline annotations, previous-revision navigation and movement detection are not implemented. |
| Multi-root, nested repositories and Worktrees | Partial | Discovery, per-repository mutation serialization, linked-worktree metadata watching and debounced external working-file refresh are implemented. Refreshes are tracked per root/generation and rediscovery retains repository identity and its mutation lock. Cross-repository transactional rollback is still planned. |
| JetBrains-native UI/assets and pixel parity | Out of scope | JB Git is a clean-room VS Code extension. VS Code renders its native panel/editor chrome; JetBrains source, UI assets, controls and trademarks are not copied. |

The broader command inventory also includes branches/tags, fetch/pull/remotes, stash, Worktrees, Submodules, Clone, Sparse Checkout, Patch import and commit export, LFS pull and Bisect. See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the prioritized parity gaps rather than treating the inventory as a claim of complete IntelliJ IDEA parity.

## Development

```bash
npm install
npm run compile
npm test
npm run package
```

Press `F5` in VS Code to launch the Extension Development Host.

## Versioning

Every installable update receives a new semantic version and produces a newly named VSIX instead of replacing an earlier package. Patch releases are used for fixes, minor releases for substantial new functionality, and major releases for incompatible changes. Automated tests keep the manifest, lockfile, changelog, and installation documentation aligned.

## Releasing

The release pipeline is implemented and automated. Every push to `main` runs the `Release` workflow, which:

1. Runs the unit tests on Linux, macOS and Windows and the extension-host tests against VS Code 1.95.0 and stable.
2. Raises the patch version and updates the lockfile, changelog and installation docs together.
3. Packages the VSIX and, when `VSCE_PAT` is configured, publishes it to the Visual Studio Marketplace.
4. Pushes a `chore: release <version>` commit, tags it `v<version>`, and attaches the VSIX to a GitHub release.

Nothing is published unless the whole matrix passes. To land a change without releasing, put `[skip release]` in the commit subject:

```bash
git commit -m "docs: fix a typo [skip release]"
```

For a minor or major release, run the workflow manually from the Actions tab and pick the version part to raise; the same steps apply.

Marketplace publishing needs a repository secret named `VSCE_PAT`: an Azure DevOps personal access token scoped to **All accessible organizations** with the `Marketplace (Manage)` scope, created from the Microsoft account that owns the `hmc` publisher. Creating one requires an Azure DevOps organization, so visit <https://aex.dev.azure.com/> — not the Azure portal, which rejects personal Microsoft accounts.

Without that secret the workflow still runs: it tests, versions, tags, and attaches the VSIX to a GitHub release, and warns that the Marketplace upload was skipped so it can be done by hand from the publisher page.

The release commit is pushed with the built-in `GITHUB_TOKEN`, whose pushes do not start another workflow run, so releases cannot loop.

## Scope and attribution

The feature behavior is informed by the public IntelliJ Community Git/VCS implementation and documentation. This project is an independent TypeScript implementation; it does not copy JetBrains source code, UI assets, or trademarks.
