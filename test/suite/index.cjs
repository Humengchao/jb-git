const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { access, mkdir, mkdtemp } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension("local.jb-git");
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
    [{ id: "jbGit.commitTool", type: "webview" }],
    "the activity bar should expose one cohesive Commit tool window instead of fragmented legacy trees",
  );

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
  assert.deepEqual(changelists.files(parent, feature.id), [], "clean paths should be removed from persisted assignments");
  changelists.dispose();

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
