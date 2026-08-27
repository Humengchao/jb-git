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
| Git tool window and Log | Partial | One bottom `Git` panel provides Log, Console, Local Changes and Shelf. The graph, filters, branch comparison, progressive 300-commit loading and virtualized large lists are implemented; persistent history indexing and exhaustive very-large-repository search are not. Each local branch carries IDEA's incoming/outgoing markers — ↓n fetched-but-unmerged, ↑n unpushed, right-aligned on the row — and a branch whose upstream was deleted says `gone` instead of showing zeros. |
| HEAD / Index / Working Tree review | Implemented | Local Changes exposes the two distinct comparisons—`HEAD → Index` (staged) and `Index → Working Tree` (unstaged)—with file diff plus text-hunk stage/unstage. Hunk application verifies that the displayed hunk is still current before mutating the Index. |
| Commit sources | Implemented | The commit form has two explicit sources: **Staging area (Index)** commits exactly the staged snapshot, while **Selected files (complete contents)** commits the checked files through an isolated temporary Index. A failed selected-file/Changelist commit leaves the user's real Index intact. Unversioned files are listed but never pre-checked, the way IDEA keeps them out of a commit until asked — auto-checking them once made Commit sweep in 2,475 editor-cache files. Checking **Amend** fills the box with the message of the commit being amended and unchecking restores what was typed, and a history button offers back the last 25 messages that made it into a commit, IDEA's Commit Message History. |
| Changelists | Partial | Create, rename/describe, activate, delete and move whole files, including rename tracking and selected-Changelist commit. Different changes **inside one file** can belong to different Changelists the way IDEA's do: expanding a file lists its changes against HEAD with the Changelist each belongs to, `Move...` reassigns one, and committing a Changelist takes exactly its own — the list a file belongs to commits everything the others did not claim, a list that claimed hunks commits only those, and the rest stay in the working tree. A change is remembered by what it changes rather than by line number, so it keeps its Changelist while the lines around it move, follows the file through a rename, and loses its assignment when the change itself is reverted. Committing complete contents says so before it sweeps another Changelist's work in. Overlapping line-level ownership inside a single hunk, task context and changelist-conflict policies remain gaps. |
| Rollback, Shelf and untracked deletion | Implemented | Rolling back a tracked file first keeps a recovery entry in Shelf. An untracked file is moved through the operating system Trash instead of being permanently deleted. Conflicted paths are not individually rolled back because that could discard one side. |
| Branch checkout with local changes | Implemented | Smart Checkout stores tracked, staged and untracked changes in a temporary stash identified by immutable OID, checks out the branch, then restores the Working Tree and Index. A failed or conflicting restore leaves the stash available for recovery. |
| Push safety | Implemented | Push fetches before preview, shows and executes the exact local-ref-to-remote-ref target plus outgoing commits, and supports initial upstream setup. Force push is unavailable whenever the destination branch matches a configurable protected-branch pattern; other destinations only offer Force with Lease. A non-fast-forward rejection on the checked-out branch's existing upstream offers pull-with-rebase or pull-with-merge and then previews again. |
| SHA-1 and SHA-256 object IDs | Implemented | Log selection and protocol validation accept complete 40- and 64-hex object IDs; Git still remains the authority that resolves and validates the object. |
| Merge conflict resolution | Partial | The three-pane editor works the way IDEA's does: the result shows clean file content with no `<<<<<<<` markers, each conflict is a coloured range that follows edits, and the strips between the panes draw connectors from every side chunk to its result region and carry per-change gutter actions: an arrow applies that side, `×` ignores the change, and a revert arrow takes a settled change back to unresolved, so applying one side never leaves the other side's gutter empty. Unresolved conflicts are red, applied sides green, hand-edited regions blue and ignored ones grey, and the change you are on is emphasised in whatever state it is in; a marker strip down the right of the result shows every change in the file and jumps to one on click; applying the second side of a conflict keeps both, and a "changes left to resolve" counter gates the staged Apply. Every decision and typing burst is one undo step (Ctrl/Cmd+Z, Shift for redo), a conflict that took nothing from the current branch is drawn as a deletion line rather than being invisible, and the wheel keeps scrolling over the strips. Toolbar per-block choices also answer to plain keys 1/2/3 while focus is outside the editable result. Whole-file choices, navigation (including F7), recoverable drafts, stale-result checks and an editable result remain. Rebase labels correctly identify **Rebase Target** and **Replayed Commit** instead of treating stage 2/3 as ordinary ours/theirs. `JB Git: Resolve Simple Conflicts` replays the merge in `diff3` on copies of the three stages, so each conflict carries its base, and settles the blocks with only one possible outcome: both sides made the same edit, only one side changed the base, or the two differ only in whitespace. A partly resolved file is deliberately left unstaged, and a file containing conflict markers of its own is refused rather than framed by guesswork. A **Base** toggle answers IDEA's "what did this start from?" for the change you are on, floating a frame of the block's common-ancestor text above it when there is room and below it when there is not; because the working tree's conflicts and the `diff3` replay are separate computations that need not frame a conflict identically, the base is offered only when the replay produced the same conflicts in the same order with the same two sides, and no base at all otherwise. A **Compare…** button is IDEA's Compare contents: any two of the four versions — the current branch, the base, the result as it stands right now, and the incoming side — open side by side in a native read-only diff, so the editor's own folding, search and whitespace settings apply to it; the base pairings are hidden for an add/add conflict, which has no common ancestor to compare against. Full semantic alignment remains. |
| Merge/rebase/cherry-pick/revert/reset operations | Partial | Start plus continue/abort/skip flows are implemented; history-editing depth remains below IDEA. |
| Interactive rebase editor | Implemented | `JB Git: Interactively Rebase from Commit` opens a visual sequence editor for reordering — drag a row by its handle or press Alt+↑/↓ — plus `pick`, `reword`, `edit`, `squash`, `fixup` and `drop`, each explained in a tooltip; squash/fixup rows tuck under the commit they join. `edit` is IDEA's stop-to-amend: the rebase applies that commit and parks (Git exits 0 there, so the extension reads the sequencer state rather than trusting the exit code), tells you to amend or test and Continue, and keeps a parked stash parked instead of restoring it onto the commit being amended. Squashing into a run whose kept commit stops for editing is refused, because the squash's subject-guarded amend would fire on the user's own legitimate edit. Message changes are lowered onto a todo Git runs unattended, so no editor is spawned and a rebase paused by a conflict still applies the reworded message after `Continue`. A dirty worktree is offered a stash the way IDEA offers one: the changes are parked only once the rebase actually starts, restored to both working tree and Index when it finishes, and kept in the stash when it stops on a conflict rather than being replayed on top of one. Git's own `rebase.autoStash` stays off, because it restores unconditionally. Untracked files are not counted as blocking, since Git replays over them happily. Narrower than IDEA: the starting commit must be an ancestor of HEAD, a range containing merges is refused instead of flattened, and `exec`/`break` rows are not offered. |
| File history and Blame | Partial | File History and command/output Blame are implemented, including literal special-path handling. |
| Editor-gutter Blame | Partial | `JB Git: Annotate with Git Blame` puts an annotation on every line: author, date and optionally the abbreviated object ID, each in its own padded column, tinted by how recent the commit is within that file. Hovering a line gives the subject, author, both the commit's own date and how long ago it was, and links to show the commit in the Log, copy the revision number, or annotate the previous revision — which follows a rename backwards because Git reports the path the line had in its previous commit. An unsaved buffer is annotated through `git blame --contents`, so the annotation stays on the line the user is reading instead of sliding out of step the moment the document goes dirty, and a commit, amend or checkout re-reads it. IDEA's annotation Options are settings: **Ignore Whitespaces** (`-w`) so a reindent stops being the last change to a line, and movement/copy detection within a file (`-M`) or across the files one commit touched (`-C`). Putting the caret on an annotated line lights up every other line that commit touched — IDEA does this on hover, which a decoration cannot observe — and `JB Git: Annotate Revision` annotates the file as of any revision, with that revision's own lines drawn in bold. `Hide Revision` and issue-tracker links remain gaps. |
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

### Looking at a surface

Nothing in the test suite renders a Webview: the tests read source text, drive
real Git, and activate the extension host. That gap once hid a sequence editor
whose script did not parse — the panel opened with the right title and nothing
in it while every test stayed green. `scripts/screenshot.mjs` opens one surface
in a real VS Code and photographs it, so that failure is one command away:

```bash
node scripts/screenshot.mjs --list
node scripts/screenshot.mjs rebase --out /tmp/rebase.png
```

It builds a throwaway repository per run, and needs a display and a screen
grabber (`xvfb`, `imagemagick`, and the usual Electron libraries). It is a
manual tool rather than a CI step, because reading the picture is the point.

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
