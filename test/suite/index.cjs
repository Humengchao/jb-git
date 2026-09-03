const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { access, mkdir, mkdtemp, unlink } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension("hmc.jb-git");
  assert.ok(extension, "the development extension should be discoverable");
  await extension.activate();
  assert.equal(extension.isActive, true, "the extension should activate without throwing");

  const manifest = JSON.parse(await readFile(path.join(extension.extensionPath, "package.json"), "utf8"));
  const declared = manifest.contributes.commands.map((item) => item.command);
  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = declared.filter((command) => !registered.has(command));
  assert.deepEqual(missing, [], `all contributed commands must be registered: ${missing.join(", ")}`);

  assert.deepEqual(
    manifest.contributes.views.jbGit.map((view) => ({ id: view.id, type: view.type })),
    [{ id: "jbGit.toolWindow", type: "webview" }],
    "the bottom Git panel should expose one cohesive tool window instead of fragmented legacy trees",
  );
  assert.deepEqual(
    manifest.contributes.viewsContainers.panel.map((container) => ({ id: container.id, title: container.title })),
    [{ id: "jbGit", title: "Git" }],
    "the Git tool window must be contributed to the bottom panel",
  );
  assert.equal(manifest.contributes.viewsContainers.activitybar, undefined, "Git must not add an activity bar sidebar");

  const parent = await mkdtemp(path.join(tmpdir(), "jb-git-nested-init-"));
  execFileSync("git", ["init", "-q"], { cwd: parent });
  const child = path.join(parent, "workspace-child");
  await mkdir(child);
  const { RefreshGenerationTracker, isWorktreeWatchPathIgnored, parseGitVersion } = require(path.join(extension.extensionPath, "dist", "extension.js"));
  assert.deepEqual(parseGitVersion("git version 2.51.0"), { major: 2, minor: 51, patch: 0, text: "git version 2.51.0" });
  assert.deepEqual(parseGitVersion("git version 2.39.3 (Apple Git-146)"), { major: 2, minor: 39, patch: 3, text: "git version 2.39.3 (Apple Git-146)" });
  const { isProtectedBranch } = require(path.join(extension.extensionPath, "dist", "pushPreview.js"));
  assert.equal(isProtectedBranch("main", ["main", "release/*"]), true);
  assert.equal(isProtectedBranch("release/2026.2", ["main", "release/*"]), true);
  assert.equal(isProtectedBranch("feature/release-notes", ["main", "release/*"]), false);
  const { safeWorktreeUri } = require(path.join(extension.extensionPath, "dist", "discardSafety.js"));
  assert.equal(safeWorktreeUri(parent, "src/..foo").fsPath, path.join(parent, "src", "..foo"));
  assert.throws(() => safeWorktreeUri(parent, "../outside"), /outside the repository/);
  const tracker = new RefreshGenerationTracker();
  tracker.addRoot("repository-a");
  const refreshA = tracker.capture();
  tracker.addRoot("repository-b");
  tracker.complete(refreshA);
  assert.deepEqual([...tracker.capture().roots.keys()], ["repository-b"], "finishing repository A must not clear pending repository B");
  const staleA = new RefreshGenerationTracker();
  staleA.addRoot("repository-a");
  const firstA = staleA.capture();
  staleA.addRoot("repository-a");
  staleA.complete(firstA);
  assert.deepEqual([...staleA.capture().roots.keys()], ["repository-a"], "a newer generation for the same root must remain pending");
  assert.equal(isWorktreeWatchPathIgnored(parent, path.join(parent, ".git", "index")), true);
  assert.equal(isWorktreeWatchPathIgnored(parent, path.join(parent, "node_modules", "dependency", "index.js")), true);
  assert.equal(isWorktreeWatchPathIgnored(parent, path.join(parent, "src", "index.js")), false);

  const { RepositoryManager } = require(path.join(extension.extensionPath, "dist", "repositoryManager.js"));
  const { GitRunner } = require(path.join(extension.extensionPath, "dist", "git", "runner.js"));
  const manager = new RepositoryManager(new GitRunner(), () => [child]);
  try {
    await manager.discoverAndRefresh();
    const repositoryBeforeRescan = manager.repository();
    assert.ok(repositoryBeforeRescan);
    await manager.discoverAndRefresh();
    assert.equal(manager.repository(), repositoryBeforeRescan, "rediscovery must preserve repository identity and its mutation lock");
    assert.equal(await manager.initializeRepository(child), false, "initialization inside a parent repository should be a no-op");
    await assert.rejects(access(path.join(child, ".git")), "a nested .git directory must not be created");
  } finally {
    manager.dispose();
  }

  const memory = new Map();
  const memento = {
    get: (key) => memory.get(key),
    update: async (key, value) => { memory.set(key, value); },
    keys: () => [...memory.keys()],
  };
  const { ChangelistStore } = require(path.join(extension.extensionPath, "dist", "changelists", "store.js"));
  const changelists = new ChangelistStore(memento);
  const feature = await changelists.create(parent, "Feature");
  await changelists.update(parent, feature.id, "Feature A", "Scoped implementation work");
  assert.equal(changelists.lists(parent).find((list) => list.id === feature.id).name, "Feature A");
  assert.equal(changelists.lists(parent).find((list) => list.id === feature.id).description, "Scoped implementation work");
  await changelists.assign(parent, "old.txt", feature.id);
  await changelists.reconcile(parent, [{
    path: "new.txt", originalPath: "old.txt", indexStatus: "R", workTreeStatus: " ",
    kind: "renamed", staged: true, unstaged: false, conflicted: false,
  }]);
  assert.equal(changelists.listForFile(parent, "new.txt").id, feature.id, "rename assignments should migrate");
  await changelists.reconcile(parent, []);
  assert.deepEqual(
    changelists.files(parent, feature.id),
    ["new.txt"],
    "assignments survive while their change is stashed or parked on another branch",
  );
  await changelists.reconcile(parent, [{
    path: "fresh.txt", indexStatus: " ", workTreeStatus: "M",
    kind: "modified", staged: false, unstaged: true, conflicted: false,
  }]);
  assert.equal(changelists.listForFile(parent, "fresh.txt").id, feature.id, "new changes join the active changelist");
  // A rename whose new path was already assigned elsewhere must not duplicate the file into
  // the list that held the old path.
  const elsewhere = await changelists.create(parent, "Elsewhere");
  await changelists.assign(parent, "moved-old.txt", feature.id);
  await changelists.assign(parent, "moved-new.txt", elsewhere.id);
  await changelists.reconcile(parent, [{
    path: "moved-new.txt", originalPath: "moved-old.txt", indexStatus: "R", workTreeStatus: " ",
    kind: "renamed", staged: true, unstaged: false, conflicted: false,
  }]);
  assert.equal(changelists.listForFile(parent, "moved-new.txt").id, elsewhere.id, "the explicit assignment wins");
  assert.equal(
    changelists.files(parent, feature.id).includes("moved-new.txt"),
    false,
    "the renamed file must not appear in two changelists",
  );
  await changelists.remove(parent, elsewhere.id);
  assert.equal(changelists.lists(parent).some((list) => list.id === elsewhere.id), false, "a Changelist can be deleted from the UI lifecycle");
  // Per-hunk ownership: a file belongs to one list, individual changes in it can
  // be claimed by another, and a Changelist commit has to take exactly its own.
  const home = await changelists.create(parent, "Home");
  const bugfix = await changelists.create(parent, "Bugfix");
  await changelists.assign(parent, "split.txt", home.id);
  assert.equal(changelists.homeListId(parent, "split.txt"), home.id);
  assert.deepEqual(changelists.commitPlan(parent, home.id, ["split.txt"]), { paths: ["split.txt"], hunkSelections: new Map() },
    "a file nobody split is still committed whole");

  await changelists.assignHunks(parent, "split.txt", ["bbb:0"], bugfix.id);
  assert.deepEqual([...changelists.claims(parent, "split.txt")], [[bugfix.id, ["bbb:0"]]]);
  assert.deepEqual(changelists.splitPaths(parent, ["split.txt", "whole.txt"]), ["split.txt"]);
  const homePlan = changelists.commitPlan(parent, home.id, ["split.txt"]);
  assert.deepEqual(homePlan.paths, ["split.txt"]);
  assert.deepEqual(homePlan.hunkSelections.get("split.txt"), { mode: "except", keys: ["bbb:0"] });
  const bugfixPlan = changelists.commitPlan(parent, bugfix.id, ["split.txt"]);
  assert.deepEqual(bugfixPlan.hunkSelections.get("split.txt"), { mode: "only", keys: ["bbb:0"] });

  // Claiming a hunk back for the list that owns the file removes the claim
  // rather than recording a redundant one.
  await changelists.assignHunks(parent, "split.txt", ["bbb:0"], home.id);
  assert.equal(changelists.claims(parent, "split.txt").size, 0);
  assert.deepEqual(changelists.commitPlan(parent, home.id, ["split.txt"]).hunkSelections, new Map());

  // A claim outlives an edit and dies with the change it names.
  await changelists.assignHunks(parent, "split.txt", ["bbb:0", "ccc:0"], bugfix.id);
  await changelists.reconcileHunks(parent, "split.txt", ["aaa:0", "bbb:0"]);
  assert.deepEqual(changelists.claims(parent, "split.txt").get(bugfix.id), ["bbb:0"], "only the vanished change loses its claim");
  assert.deepEqual(changelists.claimedPaths(parent), ["split.txt"]);

  // Renaming the file takes its claims with it, or they would name nothing.
  await changelists.reconcile(parent, [{
    path: "renamed.txt", originalPath: "split.txt", indexStatus: "R", workTreeStatus: " ",
    kind: "renamed", staged: true, unstaged: false, conflicted: false,
  }]);
  assert.deepEqual(changelists.claims(parent, "renamed.txt").get(bugfix.id), ["bbb:0"]);
  assert.equal(changelists.claims(parent, "split.txt").size, 0);

  // Deleting the claiming list must not leave those hunks belonging to nothing.
  await changelists.remove(parent, bugfix.id);
  assert.equal(changelists.claims(parent, "renamed.txt").size > 0, true, "the fallback list inherits the claims");

  // Moving the whole file is a decision about all of it.
  await changelists.assign(parent, "renamed.txt", home.id);
  assert.equal(changelists.claims(parent, "renamed.txt").size, 0);

  changelists.dispose();

  // Generated diffs must not open as untitled documents: those start dirty, so closing a
  // patch the user only wanted to read pops VS Code's unsaved-changes prompt. Measured in
  // this host: untitled -> isDirty true; a read-only file system -> isDirty false.
  const { DiffContentProvider } = require(path.join(extension.extensionPath, "dist", "views", "diffProvider.js"));
  assert.equal(DiffContentProvider.scheme, "jb-git-diff");
  const probeScheme = "jb-git-diff-probe";
  const diffProvider = new DiffContentProvider(probeScheme);
  const providerRegistration = vscode.workspace.registerFileSystemProvider(probeScheme, diffProvider, {
    isCaseSensitive: true,
    isReadonly: true,
  });
  try {
    const uri = diffProvider.registerFile(parent, "abc123", "abc123.diff", "diff --git a/a b/a\n");
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.isUntitled, false, "diff documents must not be untitled");
    assert.equal(document.isDirty, false, "a diff must never open dirty");
    assert.equal(document.languageId, "diff", "the .diff name should select the diff language");
    assert.equal(document.getText(), "diff --git a/a b/a\n");
    // A readonly file system refuses every mutation, which is what keeps the editor read-only.
    await assert.rejects(vscode.workspace.fs.writeFile(uri, Buffer.from("nope")), "writes must be refused");
    await assert.rejects(vscode.workspace.fs.delete(uri), "deletes must be refused");
    const untitled = await vscode.workspace.openTextDocument({ content: "x\n", language: "diff" });
    assert.equal(untitled.isDirty, true, "the pattern this replaced is what caused the save prompt");

    // A binary side must reach the editor as bytes. Reporting "this file is
    // binary" in a notification instead left nothing on screen, and awaited from
    // inside a progress task it held the spinner open with no cancel button.
    const { diffSide } = require(path.join(extension.extensionPath, "dist", "views", "diffProvider.js"));
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
    const left = diffSide(diffProvider, parent, "logo:left", "logo.png", png);
    assert.deepEqual(
      Buffer.from(await vscode.workspace.fs.readFile(left)),
      png,
      "binary bytes must survive registration; a UTF-8 round trip would replace them with U+FFFD",
    );
    const right = diffSide(diffProvider, parent, "logo:right", "logo.png", Buffer.concat([png, Buffer.from([1, 2, 3])]));
    // How it renders is the editor's business; what matters is that it opens.
    await vscode.commands.executeCommand("vscode.diff", left, right, "logo.png", { preview: true });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    // Text still arrives as text, so ordinary diffs are untouched.
    const textSide = diffSide(diffProvider, parent, "note:left", "note.txt", Buffer.from("hello\n", "utf8"));
    assert.equal((await vscode.workspace.openTextDocument(textSide)).getText(), "hello\n");
  } finally {
    providerRegistration.dispose();
    diffProvider.dispose();
  }

  const { ShelfStore } = require(path.join(extension.extensionPath, "dist", "shelves", "store.js"));
  const { discoverRepository } = require(path.join(extension.extensionPath, "dist", "git", "repository.js"));
  const shelfRoot = await mkdtemp(path.join(tmpdir(), "jb-git-shelf-delete-"));
  const shelfStore = new ShelfStore(shelfRoot);
  const shelfRepository = await discoverRepository(parent, new GitRunner());
  // A real entry, so its patch sits where the store puts it: metadata read
  // from disk cannot send `remove` at a file outside that directory, so the
  // undeletable file has to be the entry's own.
  // The store keys its directory by the repository root it is given, and the
  // repository's own root is canonical — on macOS the temp dir arrives as
  // /var and comes back as /private/var — so both calls have to use that one.
  const shelfRoot2 = shelfRepository.info.rootPath;
  const entry = await shelfStore.record(shelfRepository, "Broken", [], "not a real patch\n");
  await unlink(entry.patchFile);
  await mkdir(entry.patchFile);
  await assert.rejects(shelfStore.remove(shelfRoot2, entry), "shelf deletion errors must be reported");
  // An entry whose metadata points somewhere else is ignored rather than acted on.
  await assert.doesNotReject(shelfStore.remove(shelfRoot2, {
    ...entry, id: "broken", patchFile: path.join(shelfRoot, "elsewhere.patch"),
  }), "an entry outside the store is not this store's to delete");
  shelfStore.dispose();

  // Commit Message History: IDEA offers back the messages that made it into a
  // commit. Newest first, re-use moves to the front, and the list stays bounded.
  const { IntelliJGitToolWindowProvider } = require(path.join(extension.extensionPath, "dist", "webviews", "logPanel.js"));
  const historyMemory = new Map();
  const historyMemento = {
    get: (key) => historyMemory.get(key),
    update: async (key, value) => { historyMemory.set(key, value); },
    keys: () => [...historyMemory.keys()],
  };
  const stubEvent = () => ({ dispose() {} });
  const toolWindow = new IntelliJGitToolWindowProvider(
    { onDidChange: stubEvent, all: [] },
    { onDidChange: stubEvent },
    { onDidChange: stubEvent },
    { registerFile: () => undefined },
    historyMemento,
  );
  assert.deepEqual(toolWindow.commitMessageHistory(parent), []);
  await toolWindow.recordCommitMessage(parent, "first message");
  await toolWindow.recordCommitMessage(parent, "second message\n\nwith a body");
  assert.deepEqual(toolWindow.commitMessageHistory(parent), ["second message\n\nwith a body", "first message"]);
  await toolWindow.recordCommitMessage(parent, "first message");
  assert.deepEqual(
    toolWindow.commitMessageHistory(parent),
    ["first message", "second message\n\nwith a body"],
    "re-using a message moves it to the front instead of duplicating it",
  );
  await toolWindow.recordCommitMessage(parent, "   ");
  assert.equal(toolWindow.commitMessageHistory(parent).length, 2, "a blank message is not history");
  for (let index = 0; index < 30; index += 1) await toolWindow.recordCommitMessage(parent, "bulk " + index);
  assert.equal(toolWindow.commitMessageHistory(parent).length, 25, "the list stays bounded");
  assert.equal(toolWindow.commitMessageHistory("/some/other/root").length, 0, "history is per repository");
  toolWindow.dispose();
}

module.exports = { run };
