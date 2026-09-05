import assert from "node:assert/strict";
import test from "node:test";
import { panelHost, panelScript, readSource } from "./sourceText.mjs";

const extension = readSource("../src/extension.ts", import.meta.url);

test("aborts clone when no destination folder was chosen", () => {
  // `?? process.cwd()` sent the clone into the extension host's cwd (typically /) when the
  // user pressed Escape in the folder picker.
  assert.doesNotMatch(extension, /pickWorkspaceRoot\(\) \?\? process\.cwd\(\)/);
  const clone = extension.slice(extension.indexOf('"jbGit.cloneRepository"'));
  assert.match(clone.slice(0, 1200), /if \(!cloneRoot\) return void vscode\.window\.showInformationMessage/);
});

test("redacts credentials from the clone progress title", () => {
  const clone = extension.slice(extension.indexOf('"jbGit.cloneRepository"'));
  assert.match(clone.slice(0, 1800), /Cloning \$\{redactGitText\(source\.trim\(\)\)\}/);
  assert.doesNotMatch(clone.slice(0, 1800), /Cloning \$\{source\.trim\(\)\}/);
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
  assert.match(fetch.slice(0, 1200), /Fetch failed for \{0} of \{1} repositories/);
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
  assert.match(extension, /scheduleRefreshForPath\(uri\.fsPath, root\)/);
  assert.match(extension, /const lexical = path\.normalize\(filePath\)/);
  assert.match(extension, /deepestContaining\(manager\.all, lexical/);
});

test("validates the configured Git runtime and reacts to gitPath changes", () => {
  assert.match(extension, /runner\.version\(context\.extensionPath\)/);
  assert.match(extension, /requires Git 2\.23 or newer/);
  assert.match(extension, /void gitRuntimeCheck\.catch\(\(\) => undefined\);/);
  assert.doesNotMatch(extension, /await gitRuntimeCheck;/);
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

test("never blocks a progress notification on a toast being dismissed", () => {
  // A notification promise settles only when the notification is dismissed, so
  // awaiting one from inside a progress task pins that progress on screen — and
  // a non-cancellable progress has no close button, which is what made a binary
  // diff look like it was comparing forever.
  const checkout = readSource("../src/smartCheckout.ts", import.meta.url);
  for (const [, args] of checkout.matchAll(/await vscode\.window\.show\w+Message\(([\s\S]{0,300}?)\);/g)) {
    assert.match(args, /modal: true/, `only a modal question may be awaited here: ${args.slice(0, 60)}`);
  }
  assert.match(checkout, /void vscode\.window\.showInformationMessage\(vscode\.l10n\.t\("Checked out \{0} and restored/);
  // The diff path stopped reporting binary content in a notification altogether.
  const diff = readSource("../src/views/diffProvider.ts", import.meta.url);
  assert.doesNotMatch(diff, /vscode\.window\.show\w+Message/);
  assert.match(diff, /isBinaryContent\(content\) \? content : content\.toString\("utf8"\)/);
  // The one long step left in a diff is reading a blob, so it can be cancelled.
  assert.match(extension, /\(signal\) => openChangeDiff\(manager, diffProvider, node, signal\),\r?\n\s*true,/);
});

test("Checkout and Rebase onto Current rebases while the parked changes are still stashed", () => {
  // Restoring the stash first would make the rebase refuse a dirty worktree,
  // and replaying it onto a conflict would mix it into the resolution.
  const checkout = readSource("../src/smartCheckout.ts", import.meta.url);
  const hookAt = checkout.indexOf("await options.afterCheckout(lease);");
  const restoreAt = checkout.indexOf("const restore = await restoreTemporaryStash(manager, rootPath, temporary, lease);");
  assert.ok(hookAt >= 0 && restoreAt >= 0 && hookAt < restoreAt, "the follow-up runs before the parked changes come back");
  assert.match(checkout, /if \(manager\.snapshot\(rootPath\)\?\.operation\.kind !== "none"\) \{[\s\S]{0,600}?throw error;/);
  // A clean worktree still runs checkout and follow-up under one lease.
  assert.match(checkout, /await manager\.withExclusive\(rootPath, async \(lease\) => \{\s*\n\s*await manager\.checkout\(rootPath, branch\.name, branch\.kind, branch\.fullName, lease\);\s*\n\s*await options\.afterCheckout\?\.\(lease\);/);

  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const host = panelHost(import.meta.url);
  const action = host.slice(host.indexOf('message.action === "checkoutAndRebase"'), host.indexOf('message.action === "fetchRef"'));
  assert.match(action, /modal: true/);
  assert.match(action, /afterCheckout: \(lease\) => this\.manager\.rebase\(root, onto, lease\)/);
  const script = panelScript(import.meta.url);
  assert.match(script, /label: 'Checkout ' \+ branch\.name \+ ' and Rebase onto ' \+ into, disabled: !current, run: act\('checkoutAndRebase'\)/);
});

test("Accept Yours / Accept Theirs label the sides by the running operation and confirm first", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panelScript(import.meta.url);
  assert.match(script, /label: 'Accept Yours', run: \(\) => post\('resolveWith', \{ path: change\.path, side: 'ours' \}\)/);
  assert.match(script, /label: 'Accept Theirs', run: \(\) => post\('resolveWith', \{ path: change\.path, side: 'theirs' \}\)/);
  const host = panelHost(import.meta.url);
  const resolve = host.slice(host.indexOf('message.type === "resolveWith"'), host.indexOf('message.type === "ignorePath"'));
  assert.match(resolve, /if \(!change\?\.conflicted\) return;/);
  // During a rebase "yours" is the rebase target, not the replayed commit; the
  // shared label helper knows that, so the confirmation names the right side.
  assert.match(resolve, /const labels = await conflictSideLabels\(snapshot\);/);
  assert.match(resolve, /modal: true/);
  assert.match(resolve, /await this\.manager\.acceptConflictSide\(root, change\.path, message\.side\)/);
});

test("the merge command offers IDEA's merge options and refuses contradictory ones before Git runs", () => {
  const merge = extension.slice(extension.indexOf('registerCommand("jbGit.merge"'), extension.indexOf('registerCommand("jbGit.rebase"'));
  assert.match(merge, /canPickMany: true/);
  for (const flag of ["--no-ff", "--ff-only", "--squash", "--no-commit", "--allow-unrelated-histories"]) {
    assert.ok(merge.includes(`description: "${flag}"`), `${flag} is offered`);
  }
  assert.match(merge, /mergeArguments\(options\)/);
  assert.match(merge, /manager\.merge\(first\.repository\.info\.rootPath, ref, options\)/);
});

test("Reset offers IDEA's Keep mode", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  assert.match(panel, /label: vscode\.l10n\.t\("Keep"\), description: vscode\.l10n\.t\("Move the branch; keep local changes[^"]*"\), mode: "keep"/);
  const repository = readSource("../src/git/repository.ts", import.meta.url);
  assert.match(repository, /public async reset\(ref: string, mode: GitResetMode\)/);
});

test("the rebase command is IDEA's dialog: Onto, an optional From (--onto), Preserve merges, and smart stashing", () => {
  const rebase = extension.slice(extension.indexOf('registerCommand("jbGit.rebase"'), extension.indexOf('registerCommand("jbGit.resolveSimpleConflicts"'));
  assert.match(rebase, /canPickMany: true/);
  assert.match(rebase, /description: "--rebase-merges"/);
  assert.match(rebase, /description: "--onto"/);
  // From is a commit of the current branch; the picked Onto becomes the new base.
  assert.match(rebase, /options\.onto = ref;\s*\n\s*upstream = from\.hash;/);
  assert.match(rebase, /await rebaseWithLocalChanges\(manager, root, upstream, ref, options\)/);
  // A conflict stop is reported as one, not as a raw error.
  assert.match(rebase, /operation\.kind === "rebase"\) \{\s*\n\s*await vscode\.window\.showWarningMessage\(vscode\.l10n\.t\("The rebase stopped before the end of the plan/);

  const smart = readSource("../src/smartRebase.ts", import.meta.url);
  // Parked changes come back only after a rebase that finished; a paused one keeps the stash.
  const keptAt = smart.indexOf("Your local changes are kept in {0}");
  const restoredAt = smart.lastIndexOf("await restoreTemporaryStash(manager, rootPath, parked, lease)");
  assert.ok(keptAt >= 0 && restoredAt >= 0 && keptAt < restoredAt);
  assert.match(smart, /manager\.rebase\(rootPath, upstream, lease, options\)/);
  for (const [, args] of smart.matchAll(/await vscode\.window\.show\w+Message\(([\s\S]{0,300}?)\);/g)) {
    assert.match(args, /modal: true/, `only a modal question may be awaited inside the smart rebase: ${args.slice(0, 60)}`);
  }
});

test("Hide Revision is cumulative per document, guarded to object ids, and reversible from the hover", () => {
  const controller = readSource("../src/views/blameDecorations.ts", import.meta.url);
  assert.match(controller, /private readonly hidden = new Map<string, Set<string>>\(\);/);
  assert.match(controller, /const ignoreRevisions = this\.hiddenRevisions\(document\.uri\);/);
  assert.match(controller, /\{ \.\.\.readBlameOptions\(\), ignoreRevisions \}/);
  // Turning the annotation off forgets the hidden set with everything else.
  const forget = controller.slice(controller.indexOf("private forget(uri: vscode.Uri): void {"), controller.indexOf("private schedule("));
  assert.match(forget, /this\.hidden\.delete\(key\);/);
  assert.match(controller, /\[Hide Revision\]\(command:jbGit\.blameHideRevision\?\$\{argument\}\)/);
  assert.match(controller, /\[Show Hidden Revisions\]\(command:jbGit\.blameShowHiddenRevisions\?\$\{argument\}\)/);
  const repository = readSource("../src/git/repository.ts", import.meta.url);
  assert.match(repository, /\(options\.ignoreRevisions \?\? \[\]\)\.filter\(\(hash\) => \/\^\[0-9a-f\]\{4,64\}\$\/i\.test\(hash\)\)\.flatMap\(\(hash\) => \["--ignore-rev", hash\]\)/);
  const manifest = JSON.parse(readSource("../package.json", import.meta.url));
  for (const command of ["jbGit.blameHideRevision", "jbGit.blameShowHiddenRevisions"]) {
    assert.ok(manifest.contributes.commands.some((item) => item.command === command), `${command} is contributed`);
  }
  // The hide command uses the same "annotate first" guard as the other hover commands.
  const hide = extension.slice(extension.indexOf('registerCommand("jbGit.blameHideRevision"'), extension.indexOf('registerCommand("jbGit.blameShowHiddenRevisions"'));
  assert.match(hide, /await requireAnnotatedLine\(argument\)/);
});

test("the commit form has IDEA's Author field and pre-fills from commit.template", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panelScript(import.meta.url);
  assert.match(script, /authorInput\.setAttribute\('list', 'commit-authors'\)/);
  assert.match(script, /for \(const author of state\.recentAuthors \|\| \[\]\)/);
  assert.match(script, /author: authorInput\.value\.trim\(\) \|\| undefined/);
  // The template is not a draft: an emptied box shows it again, and a box
  // holding only the template does not enable Commit.
  assert.match(script, /message\.value = drafts\[root\] \|\| template;/);
  assert.match(script, /const effectivelyEmpty = value => /);
  assert.match(script, /disabled = !available \|\| effectivelyEmpty\(message\.value\)/);
  // The author is for that one commit.
  assert.match(script, /const authors = \{ \.\.\.\(uiState\.commitAuthors \|\| \{\}\) \}; delete authors\[state\.selectedRoot \|\| ''\];/);
  const host = panelHost(import.meta.url);
  // Comments are stripped exactly when a template is configured, as Git's own editor does.
  assert.match(host, /const stripComments = commitTemplate !== null;/);
  assert.match(host, /author: message\.author\?\.trim\(\) \|\| undefined, stripComments/);
  // Authors are re-read only when HEAD moves; the template is configuration with a short cache.
  assert.match(host, /if \(!authors \|\| authors\.head !== head\)/);
  assert.match(host, /Date\.now\(\) - template\.readAt > 30_000/);
});

test("Update Project parks local changes like IDEA, with a way to update anyway, and stays cancellable", () => {
  const pull = extension.slice(extension.indexOf('registerCommand("jbGit.pull"'), extension.indexOf('registerCommand("jbGit.push"'));
  assert.match(pull, /await pullWithLocalChanges\(manager, root, strategy\.value, strategy\.label\)/);
  assert.match(pull, /if \(isGitAbort\(error\)\) return;/);
  assert.match(pull, /kind === "rebase" \|\| kind === "merge"/);

  const smart = readSource("../src/smartRebase.ts", import.meta.url);
  const update = smart.slice(smart.indexOf("export function pullWithLocalChanges"));
  // A merge can integrate around unrelated local changes, so the user may proceed without a stash.
  assert.match(update, /proceedButton: vscode\.l10n\.t\("Update Anyway"\)/);
  assert.match(update, /pausedKinds: \["rebase", "merge"\]/);
  assert.match(update, /cancellable: true/);
  assert.match(update, /manager\.pull\(rootPath, strategy, signal, lease\)/);
  // The generic runner: park only when the stash button was chosen, restore the
  // stash when the operation never started, keep it when a conflict paused it.
  const runner = smart.slice(smart.indexOf("export async function runWithParkedChanges"), smart.indexOf("export function rebaseWithLocalChanges"));
  assert.match(runner, /park = answer === spec\.stashButton;/);
  assert.match(runner, /const paused = spec\.pausedKinds\.includes\(manager\.snapshot\(rootPath\)\?\.operation\.kind \?\? "none"\);/);
  const keptAt = runner.indexOf("Your local changes are kept in {0}");
  const restoredAt = runner.lastIndexOf("await restoreTemporaryStash(manager, rootPath, parked, lease)");
  assert.ok(keptAt >= 0 && restoredAt > keptAt);
  // A cancelled progress aborts the Git command instead of leaving it running under the lease.
  assert.match(runner, /token\.onCancellationRequested\(\(\) => controller\.abort\(\)\)/);
});

test("Compare with Branch… and Compare with Revision… diff a ref's version of the file against the working copy", () => {
  const manifest = JSON.parse(readSource("../package.json", import.meta.url));
  for (const command of ["jbGit.compareWithBranch", "jbGit.compareWithRevision"]) {
    assert.ok(manifest.contributes.commands.some((item) => item.command === command), `${command} is contributed`);
    assert.ok(manifest.contributes.menus["editor/context"].some((item) => item.command === command), `${command} is in the editor menu`);
    assert.ok(manifest.contributes.menus["explorer/context"].some((item) => item.command === command && /!explorerResourceIsFolder/.test(item.when)), `${command} is in the explorer menu for files`);
  }
  const branch = extension.slice(extension.indexOf('registerCommand("jbGit.compareWithBranch"'), extension.indexOf('registerCommand("jbGit.compareWithRevision"'));
  // The current branch's version is the working copy's base, so it is not offered.
  assert.match(branch, /!\(candidate\.kind === "local" && candidate\.name === current\)/);
  assert.match(branch, /compareFileWithRef\(diffProvider, snapshot\.repository, root, relativePath, branch\.candidate\.fullName, branch\.candidate\.name\)/);
  const revision = extension.slice(extension.indexOf('registerCommand("jbGit.compareWithRevision"'), extension.indexOf('registerCommand("jbGit.historyForSelection"'));
  // The file's own history, followed through renames, is what the picker offers.
  assert.match(revision, /logRef\("HEAD", 100, relativePath, \{ exactPath: true, follow: true \}\)/);
  // Paths are canonical before they are made relative: a symlinked folder must not produce ../../.
  assert.match(extension, /async function locateFile\([\s\S]*?const filePath = await canonicalPath\(uri\.fsPath\);/);
});
