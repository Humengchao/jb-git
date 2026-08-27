import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepositories, discoverRepository, logPathspec } from "../dist/git/repository.js";
import { GitRunner, isGitAbort } from "../dist/git/runner.js";

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

test("reads SHA-256 log and blame object IDs when Git supports that repository format", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-sha256-"));
  try {
    execFileSync("git", ["init", "--object-format=sha256", "-q"], { cwd: root, stdio: "ignore" });
  } catch {
    context.skip("the configured Git runtime does not support SHA-256 repositories");
    return;
  }
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "sha256\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "sha256 commit");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  const [commit] = await repository.logRef("HEAD", 1);
  assert.match(commit.hash, /^[0-9a-f]{64}$/);
  const [line] = await repository.blame("file.txt");
  assert.equal(line.hash, commit.hash);
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
  assert.deepEqual(await repository.aheadBehind(initialRevision, revision), { left: 0, right: 1 });
  assert.deepEqual((await repository.logRange(initialRevision, revision)).map((commit) => commit.hash), [revision]);
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
  assert.ok(Buffer.isBuffer(patch), "shelf patches stay raw bytes to survive non-UTF-8 content");
  assert.match(patch.toString("utf8"), /diff --git/);
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

test("restores the staging area when applying a Smart Checkout stash", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-smart-checkout-stash-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "base\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "file.txt"), "indexed\n");
  git(root, "add", "file.txt");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  await repository.stash("smart checkout", true, false);
  const [entry] = await repository.stashes();
  assert.ok(entry);
  await repository.applyStash(entry.ref, true, entry.oid, true);
  const [restored] = (await repository.status()).changes;
  assert.equal(restored.staged, true);
  assert.equal(restored.unstaged, false);
  assert.equal(readText(join(root, "file.txt")), "indexed\n");
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

test("pushes a branch that has no upstream and then pushes follow-up commits", async () => {
  const base = mkdtempSync(join(tmpdir(), "jb-git-push-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  // Not via git(): the helper configures autocrlf in cwd afterwards, and `base` is not a repository.
  execFileSync("git", ["init", "--bare", "-q", "remote.git"], { cwd: base });
  mkdirSync(work);
  git(work, "init", "-q");
  git(work, "config", "user.name", "JB Git Test");
  git(work, "config", "user.email", "jb-git-test@example.invalid");
  git(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "first");

  const repository = await discoverRepository(work, new GitRunner());
  assert.ok(repository);
  const branch = git(work, "branch", "--show-current");

  // A fresh branch has no upstream; push must establish one instead of failing.
  await repository.push();
  assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), git(work, "rev-parse", "HEAD"));
  assert.equal((await repository.status()).branch.upstream, `origin/${branch}`);

  writeFileSync(join(work, "a.txt"), "two\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "second");
  await repository.push();
  assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), git(work, "rev-parse", "HEAD"));
});

test("exposes an unambiguous ref path because git resolves a short name to a tag first", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-ambiguous-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "first");
  const first = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "two\n");
  git(root, "commit", "-qam", "second");
  const second = git(root, "rev-parse", "HEAD");

  // A tag and a branch may share a short name; git's disambiguation tries refs/tags first,
  // so operating on the short name would silently target the tag.
  git(root, "tag", "shared", first);
  git(root, "branch", "shared", second);

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const branches = await repository.branches();
  const tag = branches.find((item) => item.fullName === "refs/tags/shared");
  const local = branches.find((item) => item.fullName === "refs/heads/shared");
  assert.ok(tag && local);
  assert.equal(tag.fullName, "refs/tags/shared");
  assert.equal(local.fullName, "refs/heads/shared");
  assert.equal(tag.oid, first);
  assert.equal(local.oid, second);
  assert.equal(git(root, "rev-parse", "shared"), first, "the short name resolves to the tag");

  // git shortens an ambiguous name to "heads/shared"/"tags/shared", and neither
  // `git switch heads/shared` nor `refs/tags/tags/shared` is a usable reference.
  assert.equal(tag.name, "tags/shared");
  assert.equal(local.name, "heads/shared");
  await repository.checkout(tag.name, tag.kind, tag.fullName);
  assert.equal(git(root, "rev-parse", "HEAD"), first, "checking out the tag detaches at its commit");
  await repository.checkout(local.name, local.kind, local.fullName);
  assert.equal(git(root, "branch", "--show-current"), "shared");
  assert.equal(git(root, "rev-parse", "HEAD"), second, "checking out the branch lands on the branch tip");
});

test("reports a cancelled Git command as an abort rather than a failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-abort-"));
  git(root, "init", "-q");
  const runner = new GitRunner();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runner.text(["status"], { cwd: root, signal: controller.signal }),
    (error) => isGitAbort(error),
    "an aborted command must be recognisable so the UI does not show an error dialog",
  );
});

test("reports incoming, outgoing and a deleted upstream on each local branch", async () => {
  // IDEA's branch markers: what a fetch brought in and what a push would send.
  const remote = mkdtempSync(join(tmpdir(), "jb-git-track-remote-"));
  git(remote, "init", "-q", "--bare");
  const publisher = mkdtempSync(join(tmpdir(), "jb-git-track-pub-"));
  git(publisher, "init", "-q");
  git(publisher, "config", "user.name", "JB Git Test");
  git(publisher, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(publisher, "f.txt"), "one\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-qm", "one");
  git(publisher, "remote", "add", "origin", remote);
  git(publisher, "push", "-qu", "origin", "HEAD");
  const branchName = git(publisher, "branch", "--show-current");

  const local = mkdtempSync(join(tmpdir(), "jb-git-track-local-"));
  git(local, "clone", "-q", remote, "checkout");
  const root = join(local, "checkout");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");

  // One outgoing commit here, one incoming commit on the remote.
  writeFileSync(join(root, "local.txt"), "outgoing\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "outgoing work");
  writeFileSync(join(publisher, "f.txt"), "two\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-qm", "incoming work");
  git(publisher, "push", "-q", "origin", "HEAD");
  git(root, "fetch", "-q", "origin");

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const tracked = (await repository.branches()).find((branch) => branch.kind === "local" && branch.name === branchName);
  assert.ok(tracked);
  assert.equal(tracked.ahead, 1, "the unpushed commit is outgoing");
  assert.equal(tracked.behind, 1, "the fetched commit is incoming");
  assert.equal(tracked.upstreamGone, undefined);

  // A branch whose upstream was deleted must say so, not show zeros.
  git(root, "checkout", "-qb", "feature");
  git(root, "push", "-qu", "origin", "feature");
  git(publisher, "push", "-q", "origin", "--delete", "feature");
  git(root, "fetch", "-q", "--prune", "origin");
  const gone = (await repository.branches()).find((branch) => branch.kind === "local" && branch.name === "feature");
  assert.ok(gone);
  assert.equal(gone.upstreamGone, true);
});

test("sets upstream when pushing a branch that has none", async () => {
  const base = mkdtempSync(join(tmpdir(), "jb-git-push-remote-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  execFileSync("git", ["init", "--bare", "-q", "remote.git"], { cwd: base });
  mkdirSync(work);
  git(work, "init", "-q");
  git(work, "config", "user.name", "JB Git Test");
  git(work, "config", "user.email", "jb-git-test@example.invalid");
  git(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "first");
  git(work, "branch", "side");

  const repository = await discoverRepository(work, new GitRunner());
  assert.ok(repository);
  await repository.pushRemote("origin", "side", false, undefined, true);
  assert.equal(git(remote, "rev-parse", "refs/heads/side"), git(work, "rev-parse", "side"));
  assert.equal(git(work, "config", "--get", "branch.side.remote"), "origin");
});

test("pushes the exact fully-qualified source and destination shown by the preview", async () => {
  const base = mkdtempSync(join(tmpdir(), "jb-git-exact-push-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  execFileSync("git", ["init", "--bare", "-q", "remote.git"], { cwd: base });
  mkdirSync(work);
  git(work, "init", "-q");
  git(work, "config", "user.name", "JB Git Test");
  git(work, "config", "user.email", "jb-git-test@example.invalid");
  git(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "first");
  git(work, "branch", "source");

  const repository = await discoverRepository(work, new GitRunner());
  assert.ok(repository);
  await repository.pushRemote("origin", "refs/heads/source:refs/heads/review/source", false, undefined, true);
  assert.equal(git(remote, "rev-parse", "refs/heads/review/source"), git(work, "rev-parse", "refs/heads/source"));
  assert.equal(git(work, "config", "--get", "branch.source.merge"), "refs/heads/review/source");
});

test("checks out a remote branch that already has a local counterpart", async () => {
  const base = mkdtempSync(join(tmpdir(), "jb-git-remote-checkout-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  execFileSync("git", ["init", "--bare", "-q", "remote.git"], { cwd: base });
  mkdirSync(work);
  git(work, "init", "-q");
  git(work, "config", "user.name", "JB Git Test");
  git(work, "config", "user.email", "jb-git-test@example.invalid");
  git(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "first");
  const branch = git(work, "branch", "--show-current");
  git(work, "push", "-q", "--set-upstream", "origin", branch);
  git(work, "checkout", "-qb", "side");

  const repository = await discoverRepository(work, new GitRunner());
  assert.ok(repository);
  const tracking = (await repository.branches()).find((item) => item.fullName === `refs/remotes/origin/${branch}`);
  assert.ok(tracking);
  // `git switch --track origin/<b>` fails with "a branch named '<b>' already exists", so the
  // local counterpart has to be detected by its own name, not by the remote-prefixed one.
  await repository.checkout(tracking.name, tracking.kind, tracking.fullName);
  assert.equal(git(work, "branch", "--show-current"), branch);
});

test("creates a tracking branch when checking out a remote branch with no local counterpart", async () => {
  const base = mkdtempSync(join(tmpdir(), "jb-git-track-"));
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  const work = join(base, "work");
  execFileSync("git", ["init", "--bare", "-q", "remote.git"], { cwd: base });
  mkdirSync(seed);
  git(seed, "init", "-q");
  git(seed, "config", "user.name", "JB Git Test");
  git(seed, "config", "user.email", "jb-git-test@example.invalid");
  git(seed, "remote", "add", "origin", remote);
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", "a.txt");
  git(seed, "commit", "-qm", "first");
  git(seed, "push", "-q", "origin", "HEAD");
  git(seed, "checkout", "-qb", "feature/nested");
  writeFileSync(join(seed, "b.txt"), "two\n");
  git(seed, "add", "b.txt");
  git(seed, "commit", "-qm", "second");
  git(seed, "push", "-q", "origin", "feature/nested");

  execFileSync("git", ["clone", "-q", remote, "work"], { cwd: base });
  git(work, "config", "user.name", "JB Git Test");
  git(work, "config", "user.email", "jb-git-test@example.invalid");
  const repository = await discoverRepository(work, new GitRunner());
  assert.ok(repository);
  const tracking = (await repository.branches()).find((item) => item.fullName === "refs/remotes/origin/feature/nested");
  assert.ok(tracking);
  await repository.checkout(tracking.name, tracking.kind, tracking.fullName);
  assert.equal(git(work, "branch", "--show-current"), "feature/nested");
  assert.equal(git(work, "config", "--get", "branch.feature/nested.remote"), "origin");
});

test("refuses a partial commit that would silently conclude a merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-commit-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "shared.txt"), "base\n");
  writeFileSync(join(root, "other.txt"), "other\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "shared.txt"), "feature\n");
  writeFileSync(join(root, "other.txt"), "feature-side\n");
  git(root, "commit", "-qam", "feature");
  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "shared.txt"), "main\n");
  git(root, "commit", "-qam", "main");
  assert.throws(() => git(root, "merge", "feature"), /exit|conflict|failed/i);

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  // With MERGE_HEAD present, the temp-index commit records a two-parent merge whose tree
  // contains the conflict markers, and the follow-up reset erases the unmerged entries —
  // the merge looks finished and the other side's staged changes are gone.
  await assert.rejects(
    repository.commitPaths(["shared.txt", "other.txt"], "changelist during merge"),
    /merge is in progress/i,
  );
  assert.ok(existsSync(join(root, ".git", "MERGE_HEAD")), "the merge must still be in progress");

  // A conflicted stash application has unmerged entries without MERGE_HEAD; committing the
  // conflicted path would stage the markers as the resolution.
  git(root, "merge", "--abort");
  writeFileSync(join(root, "shared.txt"), "stash me\n");
  git(root, "stash", "push", "-q");
  writeFileSync(join(root, "shared.txt"), "diverged\n");
  git(root, "commit", "-qam", "diverge");
  try { git(root, "stash", "pop"); } catch { /* conflicts are the point */ }
  await assert.rejects(
    repository.commitPaths(["shared.txt"], "conflicted stash"),
    /unresolved conflicts/i,
  );
});

test("resolves stashes by commit id so shifted positions cannot destroy the wrong one", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-stash-oid-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "a.txt"), "base\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "base");

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  writeFileSync(join(root, "a.txt"), "first\n");
  git(root, "stash", "push", "-qm", "first");
  writeFileSync(join(root, "a.txt"), "second\n");
  git(root, "stash", "push", "-qm", "second");

  const captured = (await repository.stashes()).find((entry) => entry.message.includes("first"));
  assert.ok(captured);
  assert.equal(captured.ref, "stash@{1}");
  // The list shifts: dropping the newer stash moves "first" to stash@{0}. Acting on the
  // captured positional ref would now hit a different stash.
  git(root, "stash", "drop", "-q", "stash@{0}");
  await repository.dropStash(captured.ref, captured.oid);
  assert.equal(git(root, "stash", "list"), "", "exactly the captured stash must be gone");

  // And a stash that no longer exists is refused rather than resolved by position.
  writeFileSync(join(root, "a.txt"), "third\n");
  git(root, "stash", "push", "-qm", "third");
  await assert.rejects(repository.dropStash(captured.ref, captured.oid), /no longer exists/);
  assert.match(git(root, "stash", "list"), /third/);
});

test("routes non-UTF-8 conflicts through the binary flow instead of mangling them", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-latin1-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  // Latin-1 "café" — no NUL bytes, but 0xE9 does not survive a UTF-8 round trip.
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  writeFileSync(join(root, "text.txt"), latin1);
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "text.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]));
  git(root, "commit", "-qam", "feature");
  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "text.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x3f, 0x0a]));
  git(root, "commit", "-qam", "main");
  try { git(root, "merge", "feature"); } catch { /* conflict expected */ }

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const versions = await repository.conflictVersions("text.txt");
  // Editing these bytes as a JS string turns 0xE9 into U+FFFD; Apply would then write the
  // replacement characters back. The whole-file (binary) flow avoids the text round trip.
  assert.equal(versions.binary, true, "legacy encodings must not be edited as text");
});

test("resolves relative common Git directories from the discovery working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-common-dir-"));
  const nested = join(root, "packages", "app", "src");
  mkdirSync(nested, { recursive: true });
  git(root, "init", "-q");

  // In a normal repository Git returns ../../../../.git from this cwd. That
  // value is relative to `nested`, not to the repository root.
  const repository = await discoverRepository(nested, new GitRunner());
  assert.ok(repository);
  assert.equal(sameDirectory(repository.info.gitDir, join(root, ".git")), true);
  assert.equal(sameDirectory(repository.info.commonGitDir, join(root, ".git")), true);
});

test("treats exact file names as literal pathspecs across repository operations", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-literal-paths-"));
  const magic = ":(glob)*";
  const innocent = "innocent.txt";
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, magic), "base magic\n");
  writeFileSync(join(root, innocent), "base innocent\n");
  git(root, "--literal-pathspecs", "add", "--", magic, innocent);
  git(root, "commit", "-qm", "initial literal paths");

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  assert.equal((await repository.blame(magic))[0]?.content, "base magic");
  const exactFormatPatch = await repository.formatPatch("HEAD", magic);
  assert.match(exactFormatPatch, /Subject: \[PATCH\] initial literal paths/);
  assert.doesNotMatch(exactFormatPatch, /innocent\.txt/);

  writeFileSync(join(root, magic), "changed magic\n");
  writeFileSync(join(root, innocent), "changed innocent\n");
  const exactDiff = await repository.diffAgainstWorkingTree("HEAD", magic);
  assert.match(exactDiff, /changed magic/);
  assert.doesNotMatch(exactDiff, /changed innocent/);
  assert.doesNotMatch((await repository.patch([magic])).toString("utf8"), /innocent\.txt/);

  await repository.stage([magic]);
  assert.deepEqual(git(root, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean), [magic]);
  await repository.unstage([magic]);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
  await repository.restoreFileFromRevision("HEAD", magic);
  assert.equal(readText(join(root, magic)), "base magic\n");
  assert.equal(readText(join(root, innocent)), "changed innocent\n");

  writeFileSync(join(root, magic), "discard me\n");
  await repository.discard([magic]);
  assert.equal(readText(join(root, magic)), "base magic\n");
  assert.equal(readText(join(root, innocent)), "changed innocent\n");

  writeFileSync(join(root, magic), "committed magic\n");
  await repository.commitPaths([magic], "literal selected commit");
  assert.equal((await repository.fileContent(magic, "HEAD")).toString("utf8"), "committed magic\n");
  assert.equal((await repository.fileContent(innocent, "HEAD")).toString("utf8"), "base innocent\n");

  const cleanTarget = ":(exclude)keep.txt";
  writeFileSync(join(root, cleanTarget), "remove only this\n");
  writeFileSync(join(root, "other-untracked.txt"), "keep this\n");
  writeFileSync(join(root, "keep.txt"), "keep this too\n");
  await repository.cleanUntracked([cleanTarget]);
  assert.equal(existsSync(join(root, cleanTarget)), false);
  assert.equal(existsSync(join(root, "other-untracked.txt")), true);
  assert.equal(existsSync(join(root, "keep.txt")), true);
});

test("frames Git log records by byte length even when bodies contain separator bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-log-framing-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "history.txt"), "one\n");
  git(root, "add", "history.txt");
  git(root, "commit", "-qm", "plain subject");
  writeFileSync(join(root, "history.txt"), "two\n");
  git(root, "commit", "-qam", "multiline subject\n\nline one\nline two");
  writeFileSync(join(root, "history.txt"), "three\n");
  git(root, "commit", "-qam", "control subject\n\nbody 前\x01body 后");

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const commits = await repository.logRef("HEAD", 10);
  assert.equal(commits.length, 3);
  assert.deepEqual(commits.map((commit) => commit.subject), ["control subject", "multiline subject", "plain subject"]);
  assert.match(commits[0].body, /body 前\x01body 后/);
  assert.match(commits[1].body, /line one\nline two/);
  assert.match(commits[2].body, /plain subject/);
});

test("never follows conflict symlinks and routes mode 120000 through whole-side resolution", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-symlink-conflict-"));
  const outside = mkdtempSync(join(tmpdir(), "jb-git-symlink-victim-"));
  const victim = join(outside, "valuable.txt");
  writeFileSync(victim, "valuable outside content\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  symlinkSync("base-target", join(root, "link"));
  writeFileSync(join(root, "text.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const main = git(root, "branch", "--show-current");

  git(root, "switch", "-qc", "feature");
  unlinkSync(join(root, "link"));
  symlinkSync("feature-target", join(root, "link"));
  writeFileSync(join(root, "text.txt"), "feature\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "feature");

  git(root, "switch", "-q", main);
  unlinkSync(join(root, "link"));
  symlinkSync(victim, join(root, "link"));
  writeFileSync(join(root, "text.txt"), "main\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "main");
  assert.throws(() => git(root, "merge", "feature"));

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const linkVersions = await repository.conflictVersions("link");
  assert.equal(linkVersions.binary, true);
  assert.equal(linkVersions.result, victim, "the link target is read, not the external file");
  assert.notEqual(linkVersions.result, readText(victim));
  await assert.rejects(repository.applyConflictResult("link", "malicious overwrite"), /symbolic-link|special-file/i);

  // Also protect a normal 100644 conflict if its worktree result is replaced
  // with a symlink between Git's merge and the editor read/write.
  unlinkSync(join(root, "text.txt"));
  symlinkSync(victim, join(root, "text.txt"));
  const textVersions = await repository.conflictVersions("text.txt");
  assert.equal(textVersions.binary, true);
  assert.equal(textVersions.result, victim);
  await assert.rejects(repository.applyConflictResult("text.txt", "malicious overwrite"), /symbolic link/i);
  assert.equal(readText(victim), "valuable outside content\n");

  await repository.resolveConflict("link", "theirs");
  await repository.markResolved(["link"]);
  assert.equal(readlinkSync(join(root, "link")), "feature-target");
  assert.equal((await repository.status()).changes.find((change) => change.path === "link")?.conflicted ?? false, false);
  assert.equal(readText(victim), "valuable outside content\n");
});
