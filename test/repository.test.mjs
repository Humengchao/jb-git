import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepository } from "../dist/git/repository.js";
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
  assert.equal(status.branch.head, "master");
  assert.deepEqual(status.changes.map((change) => change.path).sort(), ["README.md", "untracked.txt"]);
  assert.equal(status.changes.find((change) => change.path === "README.md")?.unstaged, true);
  assert.equal(status.changes.find((change) => change.path === "untracked.txt")?.kind, "untracked");
  const branches = await repository.branches();
  assert.equal(branches.find((branch) => branch.name === "master")?.kind, "local");
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
  await repository.stageHunk("hunks.txt", 0);
  assert.equal((await repository.status()).changes[0].staged, true);
  assert.equal((await repository.diffHunks("hunks.txt")).length, 1);
  assert.equal((await repository.diffHunks("hunks.txt", true)).length, 1);
  await repository.unstageHunk("hunks.txt", 0);
  assert.equal((await repository.diffHunks("hunks.txt", true)).length, 0);
  assert.equal((await repository.diffHunks("hunks.txt")).length, 2);
});
