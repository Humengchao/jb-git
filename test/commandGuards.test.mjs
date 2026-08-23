import assert from "node:assert/strict";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const extension = readSource("../src/extension.ts", import.meta.url);

test("aborts clone when no destination folder was chosen", () => {
  // `?? process.cwd()` sent the clone into the extension host's cwd (typically /) when the
  // user pressed Escape in the folder picker.
  assert.doesNotMatch(extension, /pickWorkspaceRoot\(\) \?\? process\.cwd\(\)/);
  const clone = extension.slice(extension.indexOf('"jbGit.cloneRepository"'));
  assert.match(clone.slice(0, 1200), /if \(!cloneRoot\) return void vscode\.window\.showInformationMessage/);
});

test("confirms restricting the working tree and validates the sparse paths", () => {
  const sparse = extension.slice(extension.indexOf('"jbGit.sparseCheckoutSet"'), extension.indexOf('"jbGit.sparseCheckoutDisable"'));
  // Setting the cone deletes every file outside it; the destructive direction was the one
  // without a confirmation.
  assert.match(sparse, /showWarningMessage\(\s*`Restrict the working tree/);
  assert.match(sparse, /modal: true/);
  assert.match(sparse, /validateInput/);
});

test("rejects resolving a file that has no conflict instead of opening another one", () => {
  const resolve = extension.slice(extension.indexOf('"jbGit.resolveConflict"'));
  assert.match(resolve.slice(0, 700), /has no merge conflict to resolve/);
});

test("keeps the tool window's repository for every forwarded command", () => {
  for (const command of ["commit", "bisectGood", "bisectBad", "bisectSkip", "bisectReset", "createChangelist", "deleteTag"]) {
    assert.match(
      extension,
      new RegExp(`registerCommand\\("jbGit\\.${command}", async \\(rootPath\\?: string\\)`),
      `${command} should accept a repository root`,
    );
  }
});

test("acts on stashes by commit id and reports conflicts as conflicts", () => {
  // Positional stash refs shift on every push/pop/drop; the confirmation modal was letting
  // the user confirm an index, not a stash.
  assert.match(extension, /applyStash\(node\.repositoryRoot, node\.entry\.ref, pop, node\.entry\.oid\)/);
  assert.match(extension, /dropStash\(node\.repositoryRoot, node\.entry\.ref, node\.entry\.oid\)/);
  assert.match(extension, /Drop the stash '\$\{node\.entry\.message \|\| node\.entry\.ref\}'/);
  assert.match(extension, /The stash was applied with conflicts\./);
  const repositorySource = readSource("../src/git/repository.ts", import.meta.url);
  assert.match(repositorySource, /private async resolveStashRef/);
});

test("continues fetching the remaining repositories when one remote fails", () => {
  const manager = readSource("../src/repositoryManager.ts", import.meta.url);
  const fetch = manager.slice(manager.indexOf("public async fetch("));
  assert.match(fetch.slice(0, 1200), /isGitAbort\(error\)/);
  assert.match(fetch.slice(0, 1200), /Fetch failed for \$\{failures\.length\} of \$\{targets\.length\}/);
  // A disposed manager must not keep scanning or setting context keys.
  assert.match(manager, /const guarded = async \(\): Promise<void> => \{\s*if \(this\.disposed\) return;/);
});

test("tracks debounced refreshes by root and generation", () => {
  assert.match(extension, /class RefreshGenerationTracker/);
  assert.match(extension, /if \(this\.roots\.get\(root\) === generation\) this\.roots\.delete\(root\)/);
  assert.match(extension, /pendingRefreshes\.complete\(batch\)/);
  // A manager change can describe A while B is still waiting. It must never
  // clear the whole pending set as the previous implementation did.
  const managerChange = extension.slice(extension.indexOf("manager.onDidChange"), extension.indexOf("vscode.workspace.onDidChangeWorkspaceFolders"));
  assert.doesNotMatch(managerChange, /pendingRefresh(?:Roots|es).*(?:clear|delete)/s);
});

test("watches ordinary worktree files changed by external tools without metadata noise", () => {
  const watcher = extension.slice(extension.indexOf("const repositoryWorktreeWatchers"), extension.indexOf("const pickRepository"));
  assert.match(watcher, /new vscode\.RelativePattern\(root, "\*\*\/\*"\)/);
  assert.match(watcher, /watcher\.onDidChange\(onWorktreeChange\)/);
  assert.match(watcher, /watcher\.onDidCreate\(onWorktreeChange\)/);
  assert.match(watcher, /watcher\.onDidDelete\(onWorktreeChange\)/);
  assert.match(extension, /WORKTREE_WATCH_IGNORED_SEGMENTS = new Set\(\["\.git", "node_modules"/);
  assert.match(watcher, /isWorktreeWatchPathIgnored\(root, uri\.fsPath\)/);
});

test("validates the configured Git runtime and reacts to gitPath changes", () => {
  assert.match(extension, /runner\.version\(context\.extensionPath\)/);
  assert.match(extension, /requires Git 2\.23 or newer/);
  assert.match(extension, /event\.affectsConfiguration\("jbGit\.gitPath"\)/);
  assert.match(extension, /workbench\.action\.reloadWindow/);
});

test("routes branch checkout through the Smart Checkout recovery flow", () => {
  assert.match(extension, /checkoutWithLocalChanges\(manager, root, selected\.branch!\)/);
  assert.match(extension, /checkoutWithLocalChanges\(manager, snapshot\.repository\.info\.rootPath, selected\)/);
});

test("routes every user-facing push through target preview and branch protection", () => {
  const pushRemoteCommand = extension.slice(extension.indexOf('registerCommand("jbGit.pushRemote"'));
  assert.match(pushRemoteCommand.slice(0, 1_200), /previewAndPush\(manager, root, \{ remote: name \}\)/);
  assert.doesNotMatch(extension, /manager\.pushRemote\(/);
  const preview = readSource("../src/pushPreview.ts", import.meta.url);
  assert.match(preview, /isProtectedBranch\(target\.branch/);
  assert.match(preview, /const refspec = `\$\{sourceRef\}:refs\/heads\/\$\{target\.branch\}`/);
});
