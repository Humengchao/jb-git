import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hunkKeys } from "../dist/changelists/hunkOwnership.js";
import { patchForHunks } from "../dist/git/patch.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

/** A file with three well-separated paragraphs, so an edit to each is its own hunk. */
const BASE = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "jb-git-partial-"));
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "app.txt"), `${BASE}\n`);
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}

/** Edits three separated lines, which Git reports as three separate hunks. */
function editThreeSpots(root) {
  const lines = BASE.split("\n");
  lines[2] = "FEATURE change";
  lines[14] = "BUGFIX change";
  lines[26] = "ANOTHER feature change";
  writeFileSync(join(root, "app.txt"), `${lines.join("\n")}\n`);
}

test("commits only the hunks one Changelist claimed, and leaves the rest in the working tree", async () => {
  const root = createRepository();
  editThreeSpots(root);
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  const { hunks } = await repository.diffAgainstHead("app.txt");
  assert.equal(hunks.length, 3, "three separated edits are three hunks");
  const keys = hunkKeys(hunks);

  // The bugfix list claimed the middle hunk only.
  await repository.commitPaths(["app.txt"], "bugfix only", {}, new Map([["app.txt", { mode: "only", keys: [keys[1]] }]]));

  const committed = git(root, "show", "HEAD:app.txt");
  assert.match(committed, /^BUGFIX change$/m, "the claimed hunk is in the commit");
  assert.doesNotMatch(committed, /FEATURE change/, "an unclaimed hunk must not ride along");
  assert.doesNotMatch(committed, /ANOTHER feature change/);

  // The other two edits are still on disk, still uncommitted.
  const onDisk = readFileSync(join(root, "app.txt"), "utf8");
  assert.match(onDisk, /^FEATURE change$/m);
  assert.match(onDisk, /^BUGFIX change$/m);
  assert.match(onDisk, /^ANOTHER feature change$/m);
  const remaining = await repository.diffAgainstHead("app.txt");
  assert.equal(remaining.hunks.length, 2, "exactly the two unclaimed edits are left to commit");
});

test("commits everything the other lists did not claim, including an edit made since", async () => {
  const root = createRepository();
  editThreeSpots(root);
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const keys = hunkKeys((await repository.diffAgainstHead("app.txt")).hunks);

  await repository.commitPaths(["app.txt"], "everything but the bugfix", {}, new Map([
    ["app.txt", { mode: "except", keys: [keys[1]] }],
  ]));

  const committed = git(root, "show", "HEAD:app.txt");
  assert.match(committed, /^FEATURE change$/m);
  assert.match(committed, /^ANOTHER feature change$/m);
  assert.doesNotMatch(committed, /BUGFIX change/, "the claimed hunk stays behind");
  const remaining = await repository.diffAgainstHead("app.txt");
  assert.equal(remaining.hunks.length, 1);
  assert.match(remaining.hunks[0].lines.join("\n"), /BUGFIX change/);
});

test("leaves the real index alone when a partial commit fails", async () => {
  const root = createRepository();
  editThreeSpots(root);
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  // A name that is not on disk any more: the file moved on since the refresh.
  await assert.rejects(
    repository.commitPaths(["app.txt"], "stale", {}, new Map([["app.txt", { mode: "only", keys: ["deadbeefdeadbeef:0"] }]])),
    /no longer the ones on disk/,
  );
  assert.equal(git(root, "log", "--oneline").trim().split("\n").length, 1, "no commit may have been made");
  assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "", "the real index must be untouched");
});

test("refuses to split a file that has no diff against HEAD to split", async () => {
  // An untracked file is a real change but has no hunks, so per-hunk ownership
  // cannot describe any part of it. Committing it as if it had none selected
  // would silently commit nothing.
  const root = createRepository();
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  writeFileSync(join(root, "brand-new.txt"), "something\n");
  await assert.rejects(
    repository.commitPaths(["brand-new.txt"], "nothing there", {}, new Map([["brand-new.txt", { mode: "only", keys: ["x:0"] }]])),
    /no longer differs from HEAD/,
  );
  assert.equal(git(root, "log", "--oneline").trim().split("\n").length, 1);
});

test("keeps the CRLF and the missing final newline a file actually has", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-partial-crlf-"));
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  // Long enough that the two edits stay separate hunks with three lines of context.
  const original = Array.from({ length: 24 }, (_, index) => `word ${index + 1}`)
    .map((word, index) => (index === 1 ? "beta" : index === 21 ? "theta" : word))
    .join("\r\n");
  // No trailing newline: the patch has to carry the "\ No newline" marker.
  writeFileSync(join(root, "crlf.txt"), original);
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const edited = original.replace("beta", "BETA").replace("theta", "THETA");
  writeFileSync(join(root, "crlf.txt"), edited);

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const { hunks } = await repository.diffAgainstHead("crlf.txt");
  assert.equal(hunks.length, 2);
  const keys = hunkKeys(hunks);
  await repository.commitPaths(["crlf.txt"], "first hunk only", {}, new Map([["crlf.txt", { mode: "only", keys: [keys[0]] }]]));

  const committed = execFileSync("git", ["show", "HEAD:crlf.txt"], { cwd: root });
  assert.equal(committed.toString("utf8"), original.replace("beta", "BETA"), "line endings and the missing final newline survive");
  assert.equal(readFileSync(join(root, "crlf.txt"), "utf8"), edited, "the working tree is untouched");
});

test("builds a patch from several hunks in file order", () => {
  const diff = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+B",
    " c",
    "@@ -20,3 +20,3 @@",
    " x",
    "-y",
    "+Y",
    " z",
    "",
  ].join("\n");
  const [first, second] = [
    { header: "@@ -1,3 +1,3 @@", oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] },
    { header: "@@ -20,3 +20,3 @@", oldStart: 20, oldLines: 3, newStart: 20, newLines: 3, lines: [" x", "-y", "+Y", " z"] },
  ];
  // Given out of order, because git apply walks a patch forwards.
  const patch = patchForHunks(diff, [second, first]);
  assert.ok(patch.indexOf("@@ -1,3 +1,3 @@") < patch.indexOf("@@ -20,3 +20,3 @@"));
  assert.match(patch, /^diff --git a\/f b\/f\n--- a\/f\n\+\+\+ b\/f\n/);
  // The file header must appear once, not once per hunk.
  assert.equal(patch.match(/^--- a\/f$/gm).length, 1);
});
