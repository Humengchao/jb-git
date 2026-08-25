# JB Git implementation plan

This checkpoint describes the current source tree. It separates a workflow being present from full IntelliJ IDEA parity so that README feature lists, implementation milestones and release claims use the same boundary.

## Status model

- **Implemented**: the workflow is present and covered by the current implementation/tests.
- **Partial**: useful end-to-end behavior exists, but IDEA offers materially deeper behavior.
- **Planned**: not implemented in the current tree.
- **Out of scope**: an explicit project non-goal.

## IDEA behavior baseline

The parity baseline comes from current JetBrains documentation and the public IntelliJ Community source layout:

- [Commit and push changes](https://www.jetbrains.com/help/idea/commit-and-push-changes.html) — Staging Area, partial commit, per-chunk/per-line selection and Changelist workflows.
- [Resolve Git conflicts](https://www.jetbrains.com/help/idea/resolve-conflicts.html) — Base-aware three-pane merge, non-conflicting/simple-conflict actions and result review.
- [Merge, rebase, or cherry-pick changes](https://www.jetbrains.com/help/idea/apply-changes-from-one-branch-to-another.html) — branch integration and interactive rebase.
- [Investigate changes](https://www.jetbrains.com/help/idea/investigate-changes.html) — Log, file history and editor-gutter Blame annotations.
- [Changelist settings](https://www.jetbrains.com/help/idea/settings-version-control-changelist-conflicts.html) — same-file partial-change ownership and inactive-Changelist conflict policies.
- `plugins/git4idea/backend/src/commands` and `repo` — Git command execution and repository state.
- `plugins/git4idea/backend/src/index`, `status`, `branch`, `rebase`, `merge` and `stash` — Index, status and operation workflows.
- `platform/vcs-impl` — Changelists, Shelf, Patch, Diff and Merge infrastructure.
- `platform/vcs-log` — commit graph and log data layers.
- `plugins/git4idea/tests` — independent parity-test inventory.

The implementation is clean-room TypeScript. Any future source reuse requires per-file license review and attribution.

## Capability checkpoint

| IDEA capability | Status | Current implementation and remaining boundary |
| --- | --- | --- |
| HEAD / Index / Working Tree model | Implemented | The UI keeps `HEAD → Index` and `Index → Working Tree` separate. It supports file Diff and text-Hunk stage/unstage, with stale-Hunk identity checks before applying a patch. |
| Two commit sources | Implemented | **Staging area (Index)** commits exactly the staged snapshot. **Selected files (complete contents)** uses an isolated temporary Index and therefore does not destroy the real Index if staging, hooks or commit fail. Selected-Changelist commit uses the same complete-path model. |
| Changelists | Partial | Create, describe, activate, delete and move whole files; preserve assignments through renames; commit a selected Changelist. Per-Hunk or overlapping-line ownership inside one file, task context and inactive-Changelist conflict handling are planned. |
| Rollback and recovery | Implemented | Tracked-file Rollback first persists a recovery Shelf. Untracked deletion goes through the operating-system Trash. Individual conflicted-file rollback is blocked so one conflict side is not silently lost. |
| Shelf, Stash and Patch | Partial | Shelf create/apply/delete, Stash create/apply/pop/delete, commit-patch export and patch import are present. Recovery uses persisted Shelf patches and stash OIDs; arbitrary local-change patch construction and IDEA's broader Unshelve targeting/options remain gaps. |
| Smart Checkout | Implemented | Dirty checkout stashes tracked, staged and untracked changes, identifies the temporary stash by immutable OID, checks out, and restores Working Tree plus Index. Failed/conflicting recovery keeps the stash. |
| Push preview and recovery | Implemented | Fetch-before-preview, an exact fully-qualified source/destination refspec, outgoing commit list, initial upstream, configurable destination-branch protection, Force with Lease only, and checked-out existing-upstream non-fast-forward recovery through Pull with Rebase/Merge followed by a new preview. IDEA's richer multi-repository Push dialog and background incoming/outgoing model are not claimed. |
| Log and object IDs | Partial | Graph, filters, branch comparison, progressive 300-commit loading, virtualization after 500 entries and a 5,000-entry cap are present. Full 40-character SHA-1 and 64-character SHA-256 IDs pass through UI validation. Persistent indexing and exhaustive huge-history search remain planned. |
| Conflict resolution | Partial | The three-pane editor renders the merge the way IDEA does: the result is marker-free text whose conflicts live on as coloured ranges (the mergeRegions model, injected into the Webview so one tested implementation serves both sides), the strips between panes draw per-change connectors, and each change carries a pair of gutter actions on both strips — an arrow applies that side, and the outer slot holds `×` while the change is open and a revert arrow once it is settled, so no change is ever left with an empty gutter. Applying the second side keeps both; revert undoes one change without disturbing any other decision. Unresolved/applied/hand-edited/ignored states are coloured red/green/blue/grey, a remaining-changes counter gates the staged Apply, an action scrolls the change it moved on to back into view, a marker strip shows every change in the file, the syntax layer paints only the visible slice (a keystroke on a 3,000-line merge cost ~148ms before and now stays inside a frame), Escape aborts, every decision or typing burst is one model-level undo step (textarea history dies on programmatic assignment), zero-length conflicts render as deletion marks, and the wheel scrolls across the strips, and per-block and whole-file choices, navigation (including F7), external-change detection and marker-form drafts remain. Rebase stage labels correctly say **Rebase Target** and **Replayed Commit** using replay metadata. The merge is now replayed in `diff3` on copies of the three stages, so every conflict carries its base: **Resolve Simple Conflicts** settles the blocks with one possible outcome (both sides made the same edit, only one side changed the base, or the two differ only in whitespace) and stages a file only once nothing is left to decide. A file whose own content holds conflict markers is refused rather than framed by guesswork. The base is now displayed per block: a **Base** toggle floats IDEA's "previous contents" frame for the change you are on, above the change when it fits and below it when it does not, hidden outright once that change scrolls away rather than parked at an edge where it would read as belonging to another line. Pairing a replayed base to a working-tree conflict is refused unless the replay produced the same conflicts, in the same order, with the same two sides — Git's merge strategy can match lines the plain three-way replay does not, and a block labelled with another block's history would be worse than no base — so the toggle is simply unavailable where that check fails. Compare contents is implemented as a Quick Pick over all six pairings of Left/Base/Result/Right, opening a native read-only diff rather than a fourth surface rendered inside the Webview; the result travels with the request because it is the one version the extension host does not have, and the base pairings are withheld from an add/add conflict that has no common ancestor. Still missing against IDEA: full semantic alignment. |
| Merge/Rebase/Cherry-pick/Revert/Reset | Partial | Start plus Continue/Abort/Skip operations are present, but history-editing depth remains below IDEA. |
| Interactive rebase editor | Implemented | A visual sequence editor reorders commits and applies `pick`, `reword`, `squash`, `fixup` and `drop`. Every message-changing action is lowered onto a todo Git can run unattended, so no editor is ever spawned and a paused rebase resumes from persisted message files. The plan is re-validated against the repository's own commit set before it runs. Narrower than IDEA: the starting commit must be an ancestor of HEAD, ranges containing merges are refused rather than flattened, a dirty worktree is refused instead of autostashed, `exec`/`break` rows are not offered, and the range is capped at 1,000 commits. |
| File History and Blame | Partial | File History and command/output Blame are implemented, including literal special-path handling. |
| Editor-gutter Blame | Partial | Inline annotations and previous-revision traversal are implemented. `JB Git: Annotate with Git Blame` decorates each line with padded author/date/object-ID columns tinted by the commit's recency within that file, and the hover carries the subject, author, both the commit's own date and how long ago it was, and links to reveal the commit in the Log, copy the revision number and annotate the previous revision. Traversal uses Git's own `previous <commit> <path>`, so it follows a rename backwards instead of asking for today's path in yesterday's tree, and it names a boundary or first-commit line rather than opening nothing. Blame is read in `--porcelain`, which sends a commit's header block once rather than per line and costs roughly a quarter of the bytes on a large file, and an unsaved buffer is annotated through `--contents` so the annotation follows the lines being typed. Revealing a commit reports whether the Log's window actually reached it and falls back to the commit's own patch instead of quietly selecting a different one. IDEA's annotation Options are settings — `-w` to look through a reindent, `-M` to credit a block moved inside the file, `-C` to follow one copied in from another file the same commit touched — and changing one of those re-runs Git while the purely visual settings only repaint. The caret stands in for IDEA's hover: putting it on an annotated line highlights every other line of that commit, because a decoration gives an extension no pointer position. `JB Git: Annotate Revision` annotates the file as of any revision and draws that revision's own lines in bold, sharing one code path with previous-revision traversal. `Hide Revision` and issue-tracker links remain. |
| Multi-root, nested repositories and Worktrees | Partial | Discovery, per-repository mutation serialization and linked-worktree metadata watching are present. External ordinary working-file changes now trigger debounced refreshes while `.git`, dependency and cache noise is ignored. Pending refreshes are retained by root/generation, and rediscovery reuses the same repository object and mutation lock when identity is unchanged. Cross-repository transactional rollback remains planned. |
| JetBrains-native UI/assets and pixel parity | Out of scope | The extension uses VS Code Panel/Webview/Diff primitives. It does not copy JetBrains source, controls, UI assets or trademarks. |

## Milestone checkpoint

| Milestone | Status | Delivered / boundary |
| --- | --- | --- |
| P0 — behavior map and high-risk proofs | Implemented | Reference map plus parser, partial-commit, Hunk, conflict, refresh and repository-operation tests. |
| P1 — Git Core and repository lifecycle | Implemented | Argument-array Git runner, porcelain-v2 parsing, discovery, serialized mutations, operation-state detection and stable rediscovery identity. |
| P2 — daily Git workflow | Implemented | Local Changes, two-layer Diff, file/Hunk stage/unstage, two commit sources, branch operations, Smart Checkout, remotes, Fetch/Pull and guarded Push. |
| P3 — Changelist, Shelf, Patch, History and Blame | Partial | Core UI, commit-patch export/import and safe recovery are present; advanced same-file Changelist ownership and gutter Blame remain. |
| P4 — Log and history-changing operations | Partial | Log graph/UI, Merge/Rebase/Cherry-pick/Revert/Reset, Continue/Abort/Skip, an interactive-rebase sequence editor and a usable conflict editor are present; complete Base-aware merge parity remains. |
| P5 — workspace scale and advanced repositories | Partial | Multi-root/nested/Bare discovery, Worktree, Submodule, Sparse Checkout, LFS pull, Bisect, progressive Log loading, virtualization and reliable external refresh are present; persistent log indexing and cross-root transaction semantics remain. |
| P6 — hardening and delivery | Partial | Windows/macOS/Linux unit CI, VS Code 1.95/stable Extension Host CI and the automated release pipeline are implemented. Accessibility depth, SSH/WSL/Dev Container/remote-host verification and systematic Git-version fallbacks still need work. |

## Prioritized parity work

1. Model Changelist ownership below the file level so independent or overlapping changes in one file can be separated safely.
2. Add `Hide Revision` to editor-gutter Blame, and issue-tracker links from an annotation's hover.
3. Add explicit multi-repository transaction planning, partial-failure reporting and compensating rollback where operations are reversible.
4. Add persistent large-history indexing/search and benchmark graph behavior beyond the current 5,000-commit window.
5. Widen interactive rebase towards IDEA: merge-preserving ranges, an offer to stash a dirty worktree, and `exec`/`break` rows.
6. Expand capability-based Git fallbacks, accessibility testing and SSH/WSL/Dev Container/remote Extension Host coverage.

## Release and signing status

Release automation is implemented, not a remaining feature. A push to `main` (unless its subject contains `[skip release]`) runs the cross-platform verification matrix, bumps the version, packages a new VSIX, commits and tags the release, and creates a GitHub Release. Marketplace upload is automatic only when `VSCE_PAT` is configured; otherwise the workflow still produces the versioned GitHub release and reports that Marketplace upload was skipped.

The project does not currently claim cryptographic VSIX/code signing or Git Commit GPG signing. Those are distinct from the implemented `Sign-off` commit option and are not prerequisites for the existing release pipeline.

## Explicit non-goals

- Pixel-perfect reproduction of IntelliJ IDEA or replacement of VS Code's native Panel/editor chrome.
- Copying JetBrains source code, UI assets, controls, product names or trademarks.
- Reimplementing Git itself; the user's configured system Git remains the source of truth.
