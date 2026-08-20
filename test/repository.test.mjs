import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepositories, discoverRepository, logPathspec } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

function readText(filePath) {
  return readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function sameDirectory(left, right) {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

test("uses literal paths and suffix matching for the log path filter", () => {
  assert.equal(logPathspec("src/file.ts"), ":(literal)src/file.ts");
  assert.equal(logPathspec("file.ts"), ":(glob)**/file.ts");
  assert.equal(logPathspec("file[1].ts"), ":(glob)**/file\\[1].ts");
});

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
  assert.equal(sameDirectory(repository.info.rootPath, root), true);
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

test("applies IntelliJ-style Git log graph options in Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-log-options-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "history.txt"), "initial\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  const main = git(root, "branch", "--show-current");
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "feature.txt"), "feature\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "feature work");
  const featureRevision = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", main);
  writeFileSync(join(root, "main.txt"), "main\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "main work");
  git(root, "merge", "--no-ff", "-qm", "merge feature", "feature");

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const firstParent = await repository.logRef("HEAD", 20, undefined, { order: "topological", firstParent: true, noMerges: false });
  assert.equal(firstParent.some((commit) => commit.hash === featureRevision), false);
  assert.equal(firstParent.some((commit) => commit.parents.length > 1), true);
  const noMerges = await repository.logRef("HEAD", 20, undefined, { order: "date", firstParent: false, noMerges: true });
  assert.equal(noMerges.some((commit) => commit.parents.length > 1), false);
  assert.equal(noMerges.some((commit) => commit.hash === featureRevision), true);
  const byAuthor = await repository.logRef("HEAD", 20, undefined, { order: "date", firstParent: false, noMerges: false, author: "JB Git Test", since: "2000-01-01T00:00:00.000Z" });
  assert.ok(byAuthor.length > 0);
  assert.ok(byAuthor.every((commit) => commit.author === "JB Git Test"));
});

test("runs commit, branch, and stash operations through Git Core", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-operations-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "one\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  const initialRevision = git(root, "rev-parse", "HEAD");
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
  assert.equal(history[1].hash, initialRevision);
  assert.match(history[1].hash, /^[0-9a-f]{40}$/);
  const internalRevision = git(root, "commit-tree", git(root, "write-tree"), "-m", "internal ref");
  git(root, "update-ref", "refs/jb-git/internal", internalRevision);
  assert.equal((await repository.log(10)).some((commit) => commit.hash === internalRevision), false);
  assert.deepEqual(await repository.commitFiles(revision), [{ status: "M", path: "file.txt" }]);
  assert.equal((await repository.logRef(revision, 10))[0].hash, revision);
  assert.equal((await repository.operationState()).kind, "none");
  assert.match(await repository.showCommit(revision), /update/);
  assert.match(await repository.formatPatch(revision, "file.txt"), /Subject: \[PATCH\] update/);
  assert.match(await repository.compareRefHistory(initialRevision, revision), />.*update/);
  assert.match(await repository.diffRefs(initialRevision, revision), /-one[\s\S]*\+two/);
  assert.deepEqual(await repository.diffFiles(initialRevision, revision), [{ status: "M", path: "file.txt" }]);
  const blame = await repository.blame("file.txt");
  assert.equal(blame.length, 1);
  assert.equal(blame[0].author, "JB Git Test");
  assert.equal(blame[0].content, "two");

  writeFileSync(join(root, "file.txt"), "working tree\n");
  assert.match(await repository.diffAgainstWorkingTree(revision, "file.txt"), /\+working tree/);
  await repository.restoreFileFromRevision(revision, "file.txt");
  assert.equal(readText(join(root, "file.txt")), "two\n");

  await repository.checkoutRevision(initialRevision);
  assert.equal(git(root, "branch", "--show-current"), "");
  assert.equal(git(root, "rev-parse", "HEAD"), initialRevision);
  await repository.checkout(defaultBranch, "local");

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
  assert.ok(worktrees.some((worktree) => sameDirectory(worktree.path, worktreePath) && worktree.branch === "feature/worktree"));
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
  assert.equal(readText(join(root, "file.txt")), "stashed\n");
  const applied = (await repository.status()).changes.find((change) => change.path === "file.txt");
  assert.equal(applied?.staged, false);
  assert.equal(applied?.unstaged, true);
});

test("discard restores both staged and working tree changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-discard-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "original\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "file.txt"), "staged\n");
  git(root, "add", "file.txt");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  await repository.discard(["file.txt"]);
  assert.equal(readText(join(root, "file.txt")), "original\n");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("discard safely unstages newly added files and restores staged renames", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-discard-added-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "old.txt"), "tracked\n");
  git(root, "add", "old.txt");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "new.txt"), "new content\n");
  git(root, "add", "new.txt");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  await repository.discard(["new.txt"]);
  assert.equal(readText(join(root, "new.txt")), "new content\n");
  assert.equal(git(root, "status", "--porcelain"), "?? new.txt");

  git(root, "mv", "old.txt", "renamed.txt");
  await repository.discard(["renamed.txt"]);
  assert.equal(readText(join(root, "old.txt")), "tracked\n");
  assert.equal(git(root, "status", "--porcelain"), "?? new.txt");
});

test("unstage works before the repository has its first commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-unstage-unborn-"));
  git(root, "init", "-q");
  writeFileSync(join(root, "first.txt"), "first\n");
  git(root, "add", "first.txt");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  await repository.unstage(["first.txt"]);
  assert.equal(readText(join(root, "first.txt")), "first\n");
  assert.equal(git(root, "status", "--porcelain"), "?? first.txt");
});

test("pushes a new branch and records its upstream", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-push-upstream-"));
  const remote = mkdtempSync(join(tmpdir(), "jb-git-push-remote-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  git(remote, "init", "--bare", "-q");
  writeFileSync(join(root, "file.txt"), "content\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  git(root, "remote", "add", "origin", remote);
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  await repository.push();
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"), `origin/${git(root, "branch", "--show-current")}`);
});

test("does not turn an invalid revision into an empty diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-invalid-revision-"));
  git(root, "init", "-q");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  await assert.rejects(repository.fileContent("missing.txt", "not-a-revision"), /not-a-revision/);
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
  assert.equal(readText(join(root, "file.txt")), "shelved\n");
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
  assert.equal(readText(join(root, "new.txt")), "content\n");

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
  assert.equal(readText(join(unborn, "first.txt")), "first\n");
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
  assert.equal(readText(join(root, "file.txt")), "valuable work\n");
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
  const versions = await repository.conflictVersions("conflict.txt");
  assert.equal(versions.base, "base\n");
  assert.equal(versions.baseExists, true);
  assert.equal(versions.ours, "main\n");
  assert.equal(versions.oursExists, true);
  assert.equal(versions.theirs, "feature\n");
  assert.equal(versions.theirsExists, true);
  assert.equal(versions.resultExists, true);
  assert.match(versions.result, /^<<<<<<< HEAD$/m);
  assert.match(versions.result, /^=======$/m);
  assert.match(versions.result, /^>>>>>>> feature$/m);
  assert.equal(versions.binary, false);
  await repository.applyConflictResult("conflict.txt", "main\nfeature\n");
  assert.equal((await repository.status()).changes.find((change) => change.path === "conflict.txt")?.conflicted ?? false, false);
  assert.equal(readText(join(root, "conflict.txt")), "main\nfeature\n");
  assert.equal((await repository.fileContent("conflict.txt", "INDEX")).toString("utf8"), "main\nfeature\n");
  git(root, "merge", "--abort");
});

test("represents an absent conflict side and can resolve the file as deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-delete-conflict-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "delete-me.txt"), "base\n");
  git(root, "add", "delete-me.txt");
  git(root, "commit", "-qm", "base");
  const defaultBranch = git(root, "branch", "--show-current");
  git(root, "switch", "-q", "-c", "delete-file");
  git(root, "rm", "-q", "delete-me.txt");
  git(root, "commit", "-qm", "delete file");
  git(root, "switch", "-q", defaultBranch);
  writeFileSync(join(root, "delete-me.txt"), "modified\n");
  git(root, "commit", "-qam", "modify file");
  assert.throws(() => git(root, "merge", "delete-file"));

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const versions = await repository.conflictVersions("delete-me.txt");
  assert.equal(versions.oursExists, true);
  assert.equal(versions.ours, "modified\n");
  assert.equal(versions.theirsExists, false);
  assert.equal(versions.theirs, "");
  await repository.applyConflictResult("delete-me.txt", "", true);
  assert.equal(existsSync(join(root, "delete-me.txt")), false);
  assert.equal((await repository.status()).changes.some((change) => change.path === "delete-me.txt" && change.conflicted), false);
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
