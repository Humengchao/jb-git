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

The local MVP now covers repository discovery, porcelain-v2 status, a Changelist-based Commit tool window, file and hunk stage/unstage, diff, selected-file commit/amend/sign-off/no-verify, Commit and Push, branches/tags, fetch/pull/push, remotes, stash, shelf, history/file history, blame, merge/rebase/cherry-pick/revert/reset, continue/abort/skip, a three-pane merge conflict editor, Worktrees, Submodules, Clone, Sparse Checkout, Patch import, LFS pull, and Bisect.

The UI now lives in a single bottom `Git` tool window, rather than an Activity Bar sidebar or editor tab. Its `Log`, `Console`, `Local Changes`, and `Shelf` tabs follow IntelliJ IDEA's workflow boundaries; Log uses horizontally resizable Branches / Commits / Changed Files / Details panes, Command/Ctrl branch multi-selection, Branch/User/Date/Paths/order filters, and a Changes Between workspace with a grouped file tree plus native side-by-side code diffs. Local Changes combines Changelists and the commit form. Double-clicking a conflicted text file opens a resizable three-pane merge surface with current/incoming versions, an editable result, per-block Left/Both/Right actions, whole-file acceptance, conflict navigation, and an Apply action that stages the resolved result. It can be reopened from the conflicted file or `JB Git: Open Merge Conflict Editor` in the Command Palette. Binary conflicts retain a safe whole-file ours/theirs fallback. VS Code still renders its own native Panel and editor chrome. Remaining high-risk work is tracked in `docs/implementation-plan.md`: an interactive rebase editor, multi-root transactional rollback, Git-version capability fallbacks, and release/remote-host hardening.

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

Publishing is automated. Every push to `main` runs the `Release` workflow, which:

1. Runs the unit tests on Linux, macOS and Windows and the extension-host tests against VS Code 1.95.0 and stable.
2. Raises the patch version and updates the lockfile, changelog and installation docs together.
3. Packages the VSIX and publishes it to the Visual Studio Marketplace.
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
