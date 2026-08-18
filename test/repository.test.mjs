import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepositories, discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("discovers a repository and reads its status", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-repository-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "README.md"), "one\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "README.md"), "two\n");
  writeFileSync(join(root, "untracked.txt"), "new\n");

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  assert.equal(repository.info.rootPath, realpathSync(root));
  const status = await repository.status();
  const initialBranch = git(root, "branch", "--show-current");
  assert.equal(status.branch.head, initialBranch);
  assert.deepEqual(status.changes.map((change) => change.path).sort(), ["README.md", "untracked.txt"]);
  assert.equal(status.changes.find((change) => change.path === "README.md")?.unstaged, true);
  assert.equal(status.changes.find((change) => change.path === "untracked.txt")?.kind, "untracked");
  const branches = await repository.branches();
  assert.equal(branches.find((branch) => branch.name === initialBranch)?.kind, "local");
});

test("discovers nested and bare repositories", async () => {
  const container = mkdtempSync(join(tmpdir(), "jb-git-discovery-container-"));
  const nestedA = join(container, "projects", "a");
  const nestedB = join(container, "projects", "b");
  const bare = join(container, "remotes", "archive.git");
  mkdirSync(nestedA, { recursive: true });
  mkdirSync(nestedB, { recursive: true });
  mkdirSync(bare, { recursive: true });
  git(nestedA, "init", "-q");
  git(nestedB, "init", "-q");
  git(bare, "init", "--bare", "-q");

  const repositories = await discoverRepositories([container], new GitRunner());
  assert.equal(repositories.length, 3);
  assert.equal(repositories.filter((repository) => repository.info.isBare).length, 1);
  assert.ok(await discoverRepository(bare, new GitRunner()));
});

test("runs commit, branch, and stash operations through Git Core", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-operations-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "one\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const defaultBranch = git(root, "branch", "--show-current");

  writeFileSync(join(root, "file.txt"), "two\n");
  await repository.stage(["file.txt"]);
  const revision = await repository.commit("update");
  assert.equal(git(root, "rev-parse", "HEAD"), revision);
  const history = await repository.log(10);
  assert.equal(history[0].hash, revision);
  assert.equal(history[0].subject, "update");
  assert.equal((await repository.operationState()).kind, "none");
  assert.match(await repository.showCommit(revision), /update/);
  const blame = await repository.blame("file.txt");
  assert.equal(blame.length, 1);
  assert.equal(blame[0].author, "JB Git Test");
  assert.equal(blame[0].content, "two");

  await repository.createBranch("feature/test");
  assert.equal(git(root, "branch", "--show-current"), "feature/test");
  await repository.renameBranch("feature/test", "feature/renamed");
  assert.equal(git(root, "branch", "--show-current"), "feature/renamed");
  await repository.checkout(defaultBranch);

  await repository.createTag("v0.1.0-test", "HEAD");
  assert.ok((await repository.branches()).some((branch) => branch.kind === "tag" && branch.name === "v0.1.0-test"));
  await repository.checkout("v0.1.0-test", "tag");
  assert.equal(git(root, "branch", "--show-current"), "");
  assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-list", "-n", "1", "v0.1.0-test"));
  await repository.checkout(defaultBranch, "local");
  await repository.deleteTag("v0.1.0-test");

  const remotePath = mkdtempSync(join(tmpdir(), "jb-git-remote-"));
  git(remotePath, "init", "--bare", "-q");
  await repository.addRemote("origin", remotePath);
  assert.deepEqual(await repository.remotes(), [{ name: "origin", fetchUrl: remotePath, pushUrl: remotePath }]);
  await repository.setRemoteUrl("origin", remotePath, true);
  await repository.removeRemote("origin");
  assert.deepEqual(await repository.remotes(), []);

  const worktreePath = `${root}-worktree`;
  await repository.addWorktree(worktreePath, defaultBranch, "feature/worktree");
  const worktrees = await repository.worktrees();
  assert.ok(worktrees.some((worktree) => worktree.path === realpathSync(worktreePath) && worktree.branch === "feature/worktree"));
  await repository.removeWorktree(worktreePath);
  assert.deepEqual(await repository.submodules(), []);

  writeFileSync(join(root, "file.txt"), "stashed\n");
  await repository.stash("temporary work");
  const stashes = await repository.stashes();
  assert.equal(stashes.length, 1);
  assert.match(stashes[0].message, /temporary work/);
  await repository.applyStash(stashes[0].ref);
  assert.equal((await repository.status()).changes.find((change) => change.path === "file.txt")?.unstaged, true);
  const patch = await repository.patch(["file.txt"]);
  assert.match(patch, /diff --git/);
  const patchFile = join(root, "shelf.patch");
  writeFileSync(patchFile, patch);
  git(root, "restore", "file.txt");
  await repository.applyPatchFile(patchFile);
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "stashed\n");
  const applied = (await repository.status()).changes.find((change) => change.path === "file.txt");
  assert.equal(applied?.staged, false);
  assert.equal(applied?.unstaged, true);
});

test("shelves tracked changes and restores them as unstaged work", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-shelf-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "base\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "file.txt"), "shelved\n");
  git(root, "add", "file.txt");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const patchFile = join(mkdtempSync(join(tmpdir(), "jb-git-shelf-patch-")), "saved.patch");
  writeFileSync(patchFile, await repository.patch(["file.txt"]));

  await repository.shelveTrackedPaths(["file.txt"]);
  assert.equal((await repository.status()).changes.length, 0);
  await repository.applyPatchFile(patchFile);
  const restored = (await repository.status()).changes[0];
  assert.equal(restored.staged, false);
  assert.equal(restored.unstaged, true);
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "shelved\n");
});

test("keeps the real index intact when a selected-path commit fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-changelist-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), Array.from({ length: 16 }, (_, index) => `line ${index + 1}\n`).join(""));
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "file.txt"), Array.from({ length: 16 }, (_, index) => {
    if (index === 0) return "first change\n";
    if (index === 14) return "second change\n";
    return `line ${index + 1}\n`;
  }).join(""));
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  await repository.stageHunk("file.txt", (await repository.diffHunks("file.txt"))[0]);
  const cachedBefore = git(root, "diff", "--cached");
  writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  await assert.rejects(repository.commitPaths(["file.txt"], "must fail"));
  assert.equal(git(root, "diff", "--cached"), cachedBefore);
  assert.equal((await repository.status()).changes[0].staged, true);
  assert.equal((await repository.status()).changes[0].unstaged, true);
});

test("commits selected paths with an isolated index", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-selected-commit-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "selected.txt"), "base\n");
  writeFileSync(join(root, "other.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "selected.txt"), "selected change\n");
  writeFileSync(join(root, "other.txt"), "other change\n");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  await repository.commitPaths(["selected.txt"], "selected only");
  assert.equal(git(root, "show", "HEAD:selected.txt"), "selected change");
  assert.equal(git(root, "show", "HEAD:other.txt"), "base");
  const status = await repository.status();
  assert.equal(status.changes.find((change) => change.path === "other.txt")?.unstaged, true);
  assert.equal(status.changes.some((change) => change.staged), false);
});

test("commits both sides of a selected rename", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-rename-commit-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "old.txt"), "content\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  git(root, "mv", "old.txt", "new.txt");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  await repository.commitPaths(["new.txt"], "rename file");
  assert.deepEqual(git(root, "ls-tree", "--name-only", "HEAD").split("\n"), ["new.txt"]);
  assert.equal((await repository.status()).changes.length, 0);
});

test("shelves renames and unborn tracked additions completely", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-shelf-edges-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "old.txt"), "content\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  git(root, "mv", "old.txt", "new.txt");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const renamePatch = join(mkdtempSync(join(tmpdir(), "jb-git-rename-patch-")), "rename.patch");
  writeFileSync(renamePatch, await repository.patch(["old.txt", "new.txt"]));
  await repository.shelveTrackedPaths(["old.txt", "new.txt"]);
  assert.equal((await repository.status()).changes.length, 0);
  await repository.applyPatchFile(renamePatch);
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "content\n");

  const unborn = mkdtempSync(join(tmpdir(), "jb-git-unborn-shelf-"));
  git(unborn, "init", "-q");
  writeFileSync(join(unborn, "first.txt"), "first\n");
  git(unborn, "add", "first.txt");
  const unbornRepository = await discoverRepository(unborn, new GitRunner());
  assert.ok(unbornRepository);
  const unbornPatch = join(mkdtempSync(join(tmpdir(), "jb-git-unborn-patch-")), "unborn.patch");
  writeFileSync(unbornPatch, await unbornRepository.patch(["first.txt"]));
  await unbornRepository.shelveTrackedPaths(["first.txt"]);
  assert.equal((await unbornRepository.status()).changes.length, 0);
  await unbornRepository.applyPatchFile(unbornPatch);
  assert.equal(readFileSync(join(unborn, "first.txt"), "utf8"), "first\n");
});

test("does not allow an option-like reset ref to override the selected mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-safe-reset-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "file.txt"), "valuable work\n");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  await assert.rejects(repository.reset("--hard", "soft"));
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "valuable work\n");
});

test("detects an in-progress merge operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-state-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "conflict.txt"), "base\n");
  git(root, "add", "conflict.txt");
  git(root, "commit", "-qm", "base");
  const defaultBranch = git(root, "branch", "--show-current");
  git(root, "switch", "-q", "-c", "feature");
  writeFileSync(join(root, "conflict.txt"), "feature\n");
  git(root, "commit", "-qam", "feature change");
  git(root, "switch", "-q", defaultBranch);
  writeFileSync(join(root, "conflict.txt"), "main\n");
  git(root, "commit", "-qam", "main change");
  try {
    git(root, "merge", "feature");
    assert.fail("merge should conflict");
  } catch {
    // Expected conflict leaves MERGE_HEAD in place.
  }
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const operation = await repository.operationState();
  assert.equal(operation.kind, "merge");
  assert.equal(operation.canContinue, true);
  assert.equal(operation.canAbort, true);
  await repository.resolveConflict("conflict.txt", "ours");
  await repository.markResolved(["conflict.txt"]);
  assert.equal((await repository.status()).changes.find((change) => change.path === "conflict.txt")?.conflicted ?? false, false);
  git(root, "merge", "--abort");
});

test("stages and unstages individual text diff hunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-hunks-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "hunks.txt"), Array.from({ length: 16 }, (_, index) => `line ${index + 1}\n`).join(""));
  git(root, "add", "hunks.txt");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "hunks.txt"), Array.from({ length: 16 }, (_, index) => {
    if (index === 0) return "first change\n";
    if (index === 14) return "second change\n";
    return `line ${index + 1}\n`;
  }).join(""));
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const hunks = await repository.diffHunks("hunks.txt");
  assert.equal(hunks.length, 2);
  await repository.stageHunk("hunks.txt", hunks[0]);
  assert.equal((await repository.status()).changes[0].staged, true);
  assert.equal((await repository.diffHunks("hunks.txt")).length, 1);
  assert.equal((await repository.diffHunks("hunks.txt", true)).length, 1);
  await repository.unstageHunk("hunks.txt", (await repository.diffHunks("hunks.txt", true))[0]);
  assert.equal((await repository.diffHunks("hunks.txt", true)).length, 0);
  assert.equal((await repository.diffHunks("hunks.txt")).length, 2);
});

test("refuses to stage a stale hunk identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-stale-hunk-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "one\ntwo\nthree\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "file.txt"), "ONE\ntwo\nthree\n");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const staleHunk = (await repository.diffHunks("file.txt"))[0];
  writeFileSync(join(root, "file.txt"), "DIFFERENT\ntwo\nthree\n");

  await assert.rejects(repository.stageHunk("file.txt", staleHunk), /changed since it was displayed/);
  assert.equal(git(root, "diff", "--cached"), "");
});

test("runs and resets a Git bisect session", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-bisect-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "bisect.txt"), "one\n");
  git(root, "add", "bisect.txt");
  git(root, "commit", "-qm", "one");
  writeFileSync(join(root, "bisect.txt"), "two\n");
  git(root, "commit", "-qam", "two");
  writeFileSync(join(root, "bisect.txt"), "three\n");
  git(root, "commit", "-qam", "three");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  await repository.bisectStart("HEAD", "HEAD~2");
  assert.equal((await repository.operationState()).kind, "bisect");
  await repository.bisectReset();
  assert.equal((await repository.operationState()).kind, "none");
});
