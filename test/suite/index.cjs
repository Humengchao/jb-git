const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { access, mkdir, mkdtemp } = require("node:fs/promises");
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
  const { RepositoryManager } = require(path.join(extension.extensionPath, "dist", "repositoryManager.js"));
  const { GitRunner } = require(path.join(extension.extensionPath, "dist", "git", "runner.js"));
  const manager = new RepositoryManager(new GitRunner(), () => [child]);
  try {
    await manager.discoverAndRefresh();
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
  } finally {
    providerRegistration.dispose();
    diffProvider.dispose();
  }

  const { ShelfStore } = require(path.join(extension.extensionPath, "dist", "shelves", "store.js"));
  const shelfRoot = await mkdtemp(path.join(tmpdir(), "jb-git-shelf-delete-"));
  const invalidPatch = path.join(shelfRoot, "patch-is-a-directory");
  await mkdir(invalidPatch);
  const shelfStore = new ShelfStore(shelfRoot);
  await assert.rejects(shelfStore.remove(parent, {
    id: "broken", repositoryRoot: parent, name: "Broken", createdAt: new Date().toISOString(),
    patchFile: invalidPatch, paths: [],
  }), "shelf deletion errors must be reported");
  shelfStore.dispose();
}

module.exports = { run };
