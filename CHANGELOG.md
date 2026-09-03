# Changelog

## 0.1.28

- feat: per-hunk Rollback, Create Patch from local changes, and Recent/Favorites in the Log's Branches pane

## 0.1.27

- fix: stop claiming a paused history rewrite succeeded, and refuse a comment-only commit message

## 0.1.26

- fix: compare ignore-file paths by file identity so the test passes on Windows
- fix: run the unit suite from an explicit file list so Windows and Node 20 can run it
- docs: describe the new IDEA workflows, their boundaries and the macOS screenshot tool
- chore: let scripts/screenshot.mjs run on macOS and add a History for Selection scenario
- feat: Undo/Edit/Fixup Commit, Accept Yours/Theirs, Ignore, History for Selection, Rebase dialog, Hide Revision, branch popup groups
- chore: keep the release bump atomic, report the real Open VSX outcome, test Node 20 and 22

## 0.1.25

- feat: Drop Commit and Squash Selected, IDEA's history editing in the log
- feat: log multi-select with batch cherry-pick and Compare Versions

## 0.1.24

- feat: Issue Navigation, IDEA's issue-id-to-tracker links
- feat: whole-history log search, IDEA's two-layer search field

## 0.1.23

- feat: IDEA's incoming/outgoing markers on every local branch
- feat: the edit rebase action, IDEA's stop-to-amend
- feat: IDEA's commit-message conveniences, and stop pre-checking junk

## 0.1.22

- feat: localize every remaining host-side dialog, notification and picker

## 0.1.21

- feat: speak the user's language in the commit, push, checkout and conflict flows

## 0.1.20

- feat: let two changes in one file belong to different Changelists
- chore: add a way to look at a surface, and keep dev scripts out of the VSIX
- fix: make the interactive rebase editor render at all
- feat: offer to park local changes before an interactive rebase
- fix: four things only visible once the extension was actually rendered
- feat: add IDEA's Compare contents to the merge editor
- feat: give Blame IDEA's annotation options, commit highlight and Annotate Revision
- fix: stop the merge editor's draft from duplicating and swallowing text
- feat: show what each conflict started from, like IDEA's previous-contents frame
- feat: annotate the editor with Git Blame the way IDEA does
- fix: pin cherry-pick and revert revisions so a flag cannot slip past the second parser

## 0.1.19

- feat: drag-and-drop rebase reordering, and the last two webviews learn Chinese

## 0.1.18

- fix: survive a render throw, and finish the tool window's colours and locale

## 0.1.17

- feat: give the merge editor an undo it can trust, and mark deletions

## 0.1.16

- fix: stop a binary diff from pinning a progress notification open

## 0.1.15

- perf: paint only the visible slice, and keep the acted-on change in view

## 0.1.14

- fix: keep a gutter action on every change and draw the icons as SVG

## 0.1.13

- feat: render the merge IDEA-style with connectors and gutter actions
- feat: model merge conflicts as ranges so the result can drop Git's markers
- fix: show each conflict as a coloured band instead of a text selection

## 0.1.12

- fix: settle terminated Git commands and hand the shell portable paths
- feat: resolve conflicts that only have one outcome once the base is known
- feat: add an interactive rebase sequence editor
- feat: separate Index from Working Tree and guard push, checkout, rollback
- fix: harden Git execution, path handling, and conflict semantics

## 0.1.11

- test: read sources with normalised line endings
- fix: guard merges, stashes, and encodings; settle pending UI state

## 0.1.10

- feat: add an extension icon and a status bar entry for the tool window

## 0.1.9

- fix: insert the changelog entry on a CRLF checkout
- ci: build a release even without a marketplace token
- ci: publish a new version on every push to main
- fix: keep focus, scroll, and popups stable across rerenders
- fix: keep splitters, keyboard focus, and row activation reliable
- fix: target refs exactly and stop misreporting cancellation
- fix: unblock push, make diffs read-only, and surface refs
- fix a hyperlink in readme.
- ci: publish tagged releases to the marketplace
- chore: prepare marketplace release 0.1.4
- fix: unstick webview filters and stale state, repair Windows CI
- refactor: cache log refreshes, adopt IntelliJ changelists, drop dead views
- fix: repair hunk staging, shelf integrity, and merge confirmations
- fix: preserve new files during rollback
- fix: refine filtering and merge editor usability
- fix: scale history and harden diff and push flows
- feat: expose repository management workflows
- fix: harden repository routing and Git operation state
- fix: stabilize Git tool window UX
- chore: bump extension version to 0.1.1
- …and 54 earlier commits.

## 0.1.8

- Fix keyboard navigation of the commit list: holding an arrow key never scrolled a virtualised list (assigning `scrollTop` after `replaceChildren` was clamped back to 0) and dropped focus entirely once the list did move, so further arrow keys did nothing.
- Fix focus and scroll being lost after a background refresh: the commit window was rebuilt only after focus had been restored, so a row far down a large history could not be found; changed rows and tool tabs carried no identity at all and lost focus on every refresh.
- Fix arrow-key tab switching leaving focus on the document body, because activating a tab re-renders the header and detaches the element that was about to be focused.
- Fix scroll positions being dropped when switching tool tabs: they are now remembered per pane across renders.
- Fix Branch, User, Date, and sort popups not closing when their own button is clicked again — the press closed the popup and the click immediately reopened it.
- Fix tabbing out of a context menu leaving it open, which also silently suspended every background refresh for as long as it stayed open.
- Fix the Changed Files tree jumping to the top on every keystroke in the commit filter.
- Fix panel resizing permanently shrinking the details column and commit-message pane: the clamped width was fed back as the new preference, so widening never restored the size you set.
- Space on a file in Local Changes now toggles whether it is included in the commit, matching the IntelliJ commit tool window; Enter still opens the diff.

## 0.1.7

- Fix splitters sticking to the cursor: releasing the mouse button outside the window delivered no `mouseup`, so the branch, commit, commit-message, and merge-editor panes kept resizing when the pointer came back. Drags now use pointer capture, which always delivers an end event.
- Fix the commit list becoming unreachable with Tab: rows were only tab-focusable while selected, so scrolling the selected commit out of the virtualised window left no tab stop in the list at all.
- Fix double-clicking a file in Local Changes only working on the file name: the status letter, the staged marker, and the empty part of the row did nothing. The whole row now opens the diff, and Space activates it like Enter.

## 0.1.6

- Fix checking out a remote branch that already has a local counterpart: it ran `git switch --track origin/<b>` and failed with "a branch named '<b>' already exists", because the local branch was looked for under the remote-prefixed name. Checking out a branch or tag whose short name is shared (git reports those as `heads/x` and `tags/x`) also failed, since neither `git switch heads/x` nor `refs/tags/tags/x` is a usable reference; every ref-targeted operation now carries the full ref path.
- Fix the branch column's "New branch" button, and the Skip button during a rebase or cherry-pick, re-asking which repository to use: those commands were typed to take a tree node and silently dropped the repository root the tool window passes. The tree-node types they referenced were dead code and are gone.
- Stop reporting a cancelled fetch, pull, or push as an error dialog; a deliberate cancellation is no longer indistinguishable from a Git failure.
- Fix "Fetch" and "Pull into <current>" silently fetching the wrong remote for refs left behind by `git remote remove`: the remote is now resolved from the ref itself instead of falling back to the only configured remote.
- Fix pushing a branch that is not checked out: it targeted `origin` even when the branch tracked another remote, claimed "no remote to push to" when several remotes existed without an `origin`, and left a new branch untracked. It now prefers the branch's upstream, offers a picker, and sets upstream.
- Confirm before "Rebase <current> onto <branch>", show progress for merge, rebase, and tag creation, and drop Merge/Rebase from tag context menus to match the command palette.

## 0.1.5

- Fix "Commit & Push" appearing to skip the push: the push was gated on the commit notification, which only settles when the toast is dismissed, so it could sit idle for as long as the notification stayed up.
- Open generated diffs (double-clicking a commit, "Compare with Local", branch diffs) in a read-only editor. They used to open as untitled documents, which start dirty and made VS Code ask to save a patch that was only meant to be read; the virtual scheme is now a readonly file system rather than a text-document content provider.
- Expand the branch context menu to the IntelliJ set: Push, Fetch, "Pull into <current> using Merge/Rebase", "Merge <branch> into <current>", "Rebase <current> onto <branch>", New Tag, Delete Tag, alongside the existing checkout, worktree, rename, and delete actions.
- Give the branch column its own toolbar (fetch, pull, push, new branch, more actions) and a name filter for branches, remotes, and tags.
- Mark decorations with per-kind icons: local branches, remote branches, and tags are now visually distinct in the commit list, and every ref of the selected commit is listed in the details pane.

## 0.1.4

- Change the Marketplace publisher identity from the local development placeholder to `hmc` and prepare a distinct installable release for publishing.

- Fix the branch filter never returning to "All": tool-window state fields that reset to undefined (selected ref, path filter, error text, empty flag) are now sent explicitly, so the merging webview no longer keeps stale values.
- Merge deferred state patches instead of overwriting them, and stop discarding commits that arrive together with a repository switch; both previously left the log stuck on stale data with Refresh unable to recover.
- Clear graph-series highlights when the recomputed graph no longer contains them, deselect by clicking empty graph space, keep the search box casing, sync the "All" branches row during multi-select, blur the repository dropdown so switching renders immediately, and preserve scroll positions in the changes, shelf, and console panes.
- Reuse a single error banner, apply deferred state as soon as a splitter drag ends, keep the DOM intact during IME composition, honor the requested tab when the tool window opens fresh, reset per-repository log filters when commands open another repository, and drop stale webview listeners when the view is rebuilt.
- Fix Windows CI: the path-canonicalization test now expands 8.3 short names in its expected value, matching fsPromises.realpath.

- Reuse cached `git log` output while refs and HEAD are unchanged, resend branch/trace/commit payloads to the tool window only when they actually changed, read the shelf list only while its tab is open, and guard every state message against stale overwrites.
- Keep changelist assignments across stashes and branch switches and route new changes into the active changelist, matching the IntelliJ model, with a bounded assignment store.
- Remove the unused legacy tree-view layer and the unreachable "Show Commit" command; command payloads are now plain data nodes, and stricter compiler checks keep dead code out.
- Stage/unstage exactly the selected hunk: a patch built for a later hunk no longer silently includes every earlier hunk.
- Keep hunk staging working in CRLF files and preserve their line endings in the index.
- Store shelf patches as raw bytes so non-UTF-8 (e.g. GBK) file content survives shelving, and skip conflicted files instead of silently resolving a merge to HEAD.
- Replace the sandbox-blocked window.confirm() in the merge editor with host-side confirmation dialogs, restoring Accept Left, Accept Right, and Cancel.
- Show first-parent changed files for merge commits in commit details.
- Parse remotes whose URLs contain spaces, and treat option-like revision input (e.g. --abort) as a revision rather than a Git flag.
- Refresh repository state even when a Git operation fails, cap the auto-refresh debounce delay, and stop re-decoding huge Git output for the console trace.
- Disable Git terminal credential prompts, drop optional index locks, and ignore repository-targeting GIT_* variables inherited from hook environments.
- Fix commit-option checkboxes overwriting each other's saved state, duplicate merge/comparison panels from rapid double-clicks, and extension-host tests failing in Electron-spawned terminals.

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
