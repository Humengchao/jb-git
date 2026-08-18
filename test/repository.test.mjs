import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
