import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseUnifiedDiff, patchForHunk, patchForTransformedHunks, selectHunkLines } from "../dist/git/patch.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function createRepository(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  return root;
}

test("patchForHunk keeps only the selected hunk", () => {
  const diff = [
    "diff --git a/f.txt b/f.txt",
    "index 0000000..1111111 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+B",
    " c",
    "@@ -10,3 +10,3 @@",
    " x",
    "-y",
    "+Y",
    " z",
    "",
  ].join("\n");
  const hunks = parseUnifiedDiff(diff);
  assert.equal(hunks.length, 2);
  const patch = patchForHunk(diff, hunks[1]);
  assert.ok(patch.startsWith("diff --git"));
  assert.ok(patch.includes("+Y"));
  assert.ok(!patch.includes("+B"), "the first hunk must not leak into a patch for the second hunk");
});

test("staging a later hunk does not stage earlier hunks", async () => {
  const root = createRepository("jb-git-hunk-select-");
  writeFileSync(join(root, "f.txt"), Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join(""));
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  writeFileSync(join(root, "f.txt"), Array.from({ length: 20 }, (_, index) => {
    if (index === 1) return "FIRST\n";
    if (index === 17) return "SECOND\n";
    return `line ${index + 1}\n`;
  }).join(""));
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const hunks = await repository.diffHunks("f.txt");
  assert.equal(hunks.length, 2);
  await repository.stageHunk("f.txt", hunks[1]);
  const staged = git(root, "diff", "--cached");
  assert.ok(staged.includes("+SECOND"));
  assert.ok(!staged.includes("+FIRST"), "only the selected hunk may be staged");
  assert.ok(git(root, "diff").includes("+FIRST"), "the unselected hunk must stay in the working tree");
});

test("stages hunks in CRLF files and preserves line endings", async () => {
  const root = createRepository("jb-git-crlf-hunk-");
  writeFileSync(join(root, "f.txt"), "line1\r\nline2\r\nline3\r\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  writeFileSync(join(root, "f.txt"), "line1\r\nCHANGED\r\nline3\r\n");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const hunks = await repository.diffHunks("f.txt");
  assert.equal(hunks.length, 1);
  await repository.stageHunk("f.txt", hunks[0]);
  assert.equal(git(root, "diff"), "", "index and working tree must agree after staging the whole change");
  const stagedBytes = execFileSync("git", ["-C", root, "show", ":f.txt"]);
  assert.equal(stagedBytes.toString("latin1"), "line1\r\nCHANGED\r\nline3\r\n");
});

test("produces byte-faithful patches for non-UTF-8 files", async () => {
  const root = createRepository("jb-git-encoding-");
  const original = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]);
  const changed = Buffer.from([0xd4, 0xd9, 0xbc, 0xfb, 0x0a]);
  writeFileSync(join(root, "gbk.txt"), original);
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  writeFileSync(join(root, "gbk.txt"), changed);
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const patch = await repository.patch(["gbk.txt"]);
  assert.ok(Buffer.isBuffer(patch));
  git(root, "checkout", "--", "gbk.txt");
  const patchFile = join(tmpdir(), `jb-git-restore-${Date.now()}.patch`);
  writeFileSync(patchFile, patch);
  await repository.applyPatchFile(patchFile);
  assert.deepEqual(readFileSync(join(root, "gbk.txt")), changed, "the shelved bytes must survive the round trip");
});

test("parses remotes whose URLs contain spaces", async () => {
  const root = createRepository("jb-git-remotes-");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  git(root, "remote", "add", "origin", "/tmp/my repos/upstream.git");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const remotes = await repository.remotes();
  assert.equal(remotes.length, 1);
  assert.equal(remotes[0].name, "origin");
  assert.equal(remotes[0].fetchUrl, "/tmp/my repos/upstream.git");
});

test("lists first-parent changed files for merge commits", async () => {
  const root = createRepository("jb-git-merge-files-");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const main = git(root, "branch", "--show-current");
  git(root, "checkout", "-qb", "side");
  writeFileSync(join(root, "side.txt"), "side\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "side");
  git(root, "checkout", "-q", main);
  writeFileSync(join(root, "main.txt"), "main\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "main");
  git(root, "merge", "-q", "--no-ff", "-m", "merge", "side");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const mergeFiles = await repository.commitFiles("HEAD");
  assert.deepEqual(mergeFiles.map((file) => file.path), ["side.txt"]);
  const rootHash = git(root, "rev-list", "--max-parents=0", "HEAD");
  const rootFiles = await repository.commitFiles(rootHash);
  assert.deepEqual(rootFiles.map((file) => file.path), ["base.txt"]);
});

test("treats option-like revision input as a revision, not a flag", async () => {
  const root = createRepository("jb-git-refuse-flags-");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const head = git(root, "rev-parse", "HEAD");
  await assert.rejects(repository.revert("--no-commit"), /bad revision|needed a single revision/i);
  await assert.rejects(repository.cherryPick("--abort"), /bad revision|needed a single revision/i);
  await assert.rejects(repository.bisectStart("--term-new=x", "HEAD"), /bad revision|needed a single revision/i);
  await assert.rejects(repository.createTag("v1", "--delete"), /bad revision|needed a single revision/i);
  assert.equal(git(root, "tag", "-l", "v1"), "", "the tag must not be created from a flag-like revision");
  // Rejecting the input is only half of it: `revert`/`cherry-pick` hand their
  // leftovers to a second option parser, so a flag that slipped through would
  // have run as a flag. Nothing may have moved.
  assert.equal(git(root, "rev-parse", "HEAD"), head, "no flag-like revision may move HEAD");
  assert.equal(git(root, "status", "--porcelain"), "", "no flag-like revision may touch the working tree");
  for (const stateFile of ["REVERT_HEAD", "CHERRY_PICK_HEAD", "sequencer"]) {
    assert.equal(existsSync(join(root, ".git", stateFile)), false, `${stateFile} must not exist`);
  }
});

function hunkOf(header, oldStart, oldLines, newStart, newLines, lines) {
  return { header, oldStart, oldLines, newStart, newLines, lines };
}

test("keeps selected lines, converts unselected removals to context and drops unselected additions", () => {
  // One hunk with an adjacent removal and two additions; each fate differs.
  const hunks = [hunkOf("@@ -10,3 +10,4 @@", 10, 3, 10, 4, [" ctx1", "-a", "+b", "+c", " ctx2"])];
  const [removalOnly] = selectHunkLines(hunks, [new Set([0])]);
  assert.deepEqual(removalOnly.lines, [" ctx1", "-a", " ctx2"]);
  assert.equal(removalOnly.header, "@@ -10,3 +10,2 @@");
  const [additionOnly] = selectHunkLines(hunks, [new Set([2])]);
  assert.deepEqual(additionOnly.lines, [" ctx1", " a", "+c", " ctx2"]);
  assert.equal(additionOnly.header, "@@ -10,3 +10,4 @@");
  const everything = selectHunkLines(hunks, [new Set([0, 1, 2])]);
  assert.deepEqual(everything[0].lines, hunks[0].lines, "selecting every line reproduces the hunk");
});

test("renumbers the new side past dropped additions and earlier hunks", () => {
  // The kept line leads no dropped additions in the original, so its position
  // in this patch's new file is earlier than in the full diff's.
  const hunks = [hunkOf("@@ -5,1 +5,3 @@", 5, 1, 5, 3, ["+a", "+b", " ctx"])];
  const [only] = selectHunkLines(hunks, [new Set([1])]);
  assert.deepEqual(only.lines, ["+b", " ctx"]);
  assert.equal(only.header, "@@ -5,1 +5,2 @@");

  // A second hunk's new start shifts by the first hunk's imbalance.
  const pair = [
    hunkOf("@@ -5,2 +5,1 @@", 5, 2, 5, 1, ["-a", " ctx"]),
    hunkOf("@@ -20,2 +20,2 @@", 20, 2, 20, 2, [" x", "-y", "+z"]),
  ];
  const [first, second] = selectHunkLines(pair, [new Set([0]), new Set([0, 1])]);
  assert.equal(first.header, "@@ -5,2 +5,1 @@");
  assert.equal(second.header, "@@ -20,2 +19,2 @@", "one line removed above moves the new side up one");
  assert.equal(second.oldStart, 20, "the old side never moves");
});

test("names the line after which a pure deletion happens", () => {
  const hunks = [hunkOf("@@ -5,1 +5,1 @@", 5, 1, 5, 1, ["-a", "+b"])];
  const [only] = selectHunkLines(hunks, [new Set([0])]);
  assert.deepEqual(only.lines, ["-a"]);
  assert.equal(only.header, "@@ -5,1 +4,0 @@", "Git's zero-count convention: the line the deletion follows");
});

test("keeps the no-newline marker with its line, and drops it with the line", () => {
  const marked = [hunkOf("@@ -5,1 +5,1 @@", 5, 1, 5, 1, ["-a", "+b", "\\ No newline at end of file"])];
  const [withoutAddition] = selectHunkLines(marked, [new Set([0])]);
  assert.deepEqual(withoutAddition.lines, ["-a"], "the marker described the dropped addition");
  const [withAddition] = selectHunkLines(marked, [new Set([1])]);
  assert.deepEqual(withAddition.lines, [" a", "+b", "\\ No newline at end of file"]);

  const markedRemoval = [hunkOf("@@ -5,1 +5,1 @@", 5, 1, 5, 1, ["-a", "\\ No newline at end of file", "+b"])];
  const [removal] = selectHunkLines(markedRemoval, [new Set([0])]);
  assert.deepEqual(removal.lines, ["-a", "\\ No newline at end of file"], "the old side still lacks the newline");
  assert.equal(removal.header, "@@ -5,1 +4,0 @@");
  const [keptContext] = selectHunkLines(markedRemoval, [new Set([1])]);
  assert.deepEqual(keptContext.lines, [" a", "\\ No newline at end of file", "+b"],
    "an unselected removal at end of file becomes context that still lacks the newline");
});

test("omits a hunk whose changed lines were all left out, and keeps its section heading", () => {
  const hunks = [
    hunkOf("@@ -5,2 +5,2 @@ function one", 5, 2, 5, 2, ["-a", "+b", " ctx"]),
    hunkOf("@@ -20,1 +20,2 @@ function two", 20, 1, 20, 2, [" x", "+y"]),
  ];
  const result = selectHunkLines(hunks, [new Set(), new Set([0])]);
  assert.equal(result.length, 1);
  assert.equal(result[0].header, "@@ -20,1 +20,2 @@ function two", "the section heading survives rebuilding");
});

test("a line-level patch applies to the side it was measured from, byte for byte", async () => {
  const root = createRepository("jb-git-line-patch-");
  const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
  writeFileSync(join(root, "f.txt"), base);
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  // Two adjacent edits, so Git reports them as one hunk.
  writeFileSync(join(root, "f.txt"), "one\ntwo\nTHREE\n3.5\nfour\nfive\nsix\nseven\n");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const { output, hunks } = await repository.diffAgainstHead("f.txt");
  assert.equal(hunks.length, 1, "adjacent edits form one hunk");
  // Changed lines: -three (0), +THREE (1), +3.5 (2). Take only the insertion.
  const patch = patchForTransformedHunks(output, selectHunkLines(hunks, [new Set([2])]));
  const target = mkdtempSync(join(tmpdir(), "jb-git-line-base-"));
  writeFileSync(join(target, "f.txt"), base);
  execFileSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], { cwd: target, input: patch });
  assert.equal(readFileSync(join(target, "f.txt"), "utf8"), "one\ntwo\nthree\n3.5\nfour\nfive\nsix\nseven\n");
});
