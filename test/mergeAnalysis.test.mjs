import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyConflict,
  isResolvable,
  parseDiff3,
  resolutionFor,
  resolveSimpleConflicts,
  summarize,
} from "../dist/mergeAnalysis.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";

const LABELS = { ours: "HEAD", base: "base", theirs: "branch" };

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

/** Runs a Git command that is expected to fail, such as a conflicting merge. */
function gitExpectingFailure(cwd, ...args) {
  try {
    git(cwd, ...args);
    assert.fail(`git ${args.join(" ")} was expected to conflict`);
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") throw error;
  }
}

function diff3(ours, base, theirs) {
  return `<<<<<<< ours\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> theirs\n`;
}

test("splits diff3 output into text and base-carrying conflicts", () => {
  const { blocks, ambiguous } = parseDiff3(`before\n${diff3("X\n", "B\n", "Y\n")}after\n`);
  assert.equal(ambiguous, false);
  assert.deepEqual(blocks, [
    { kind: "text", text: "before" },
    { kind: "conflict", ours: "X\n", base: "B\n", theirs: "Y\n" },
    { kind: "text", text: "after\n" },
  ]);
});

test("keeps a conflict that carries no base section as literal text", () => {
  // Two-way markers say nothing about what either side started from, so
  // reinterpreting them as a resolvable conflict would be a guess.
  const text = "<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\n";
  assert.deepEqual(parseDiff3(text).blocks, [{ kind: "text", text }]);
  // Without a base section there is nothing to analyse, so the parse reports
  // itself unusable rather than letting a caller resolve it blind.
  assert.equal(parseDiff3(text).ambiguous, true);
});

test("keeps malformed and nested markers as literal text", () => {
  // A file whose own content holds markers cannot be framed reliably, so the
  // parse reports itself as ambiguous rather than auto-resolving a wrong block.
  const nested = `<<<<<<< a\n<<<<<<< b\nX\n||||||| base\nB\n=======\nY\n>>>>>>> theirs\n`;
  assert.equal(parseDiff3(nested).ambiguous, true);
  // An unterminated conflict must not swallow the rest of the file.
  const unterminated = "<<<<<<< ours\nX\n||||||| base\nB\n=======\nY\n";
  assert.deepEqual(parseDiff3(unterminated).blocks, [{ kind: "text", text: unterminated }]);
  assert.equal(parseDiff3(unterminated).ambiguous, true);
});

test("classifies a conflict by what each side did to the base", () => {
  assert.equal(classifyConflict("same\n", "base\n", "same\n"), "identical");
  assert.equal(classifyConflict("base\n", "base\n", "changed\n"), "theirs-only");
  assert.equal(classifyConflict("changed\n", "base\n", "base\n"), "ours-only");
  assert.equal(classifyConflict("a  b\n", "a\n", "a b\n"), "whitespace");
  assert.equal(classifyConflict("mine\n", "base\n", "yours\n"), "conflict");
  // Both sides deleting the same text is agreement, not one side's deletion.
  assert.equal(classifyConflict("", "base\n", ""), "identical");

  assert.equal(isResolvable("whitespace"), true);
  assert.equal(isResolvable("conflict"), false);
});

test("refuses to invent a resolution for a real conflict", () => {
  assert.equal(resolutionFor({ ours: "mine\n", base: "base\n", theirs: "yours\n" }), undefined);
  assert.equal(resolutionFor({ ours: "base\n", base: "base\n", theirs: "theirs\n" }), "theirs\n");
  assert.equal(resolutionFor({ ours: "ours\n", base: "base\n", theirs: "base\n" }), "ours\n");
});

test("resolves the mechanical conflicts and leaves the rest for a human", () => {
  const { blocks } = parseDiff3([
    "head\n",
    diff3("base\n", "base\n", "incoming\n"),
    "middle\n",
    diff3("mine\n", "base\n", "yours\n"),
    "tail\n",
  ].join(""));

  const result = resolveSimpleConflicts(blocks, LABELS);
  assert.equal(result.resolved, 1);
  assert.equal(result.remaining, 1);
  assert.equal(
    result.text,
    "head\nincoming\nmiddle\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> branch\ntail\n",
  );
});

test("leaves a file with no resolvable conflict byte-identical apart from marker labels", () => {
  const { blocks } = parseDiff3(`a\n${diff3("mine\n", "base\n", "yours\n")}b\n`);
  const result = resolveSimpleConflicts(blocks, LABELS);
  assert.equal(result.resolved, 0);
  assert.equal(result.text, "a\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> branch\nb\n");
});

test("counts every conflict kind for a summary", () => {
  const { blocks } = parseDiff3([
    diff3("same\n", "base\n", "same\n"),
    diff3("base\n", "base\n", "new\n"),
    diff3("mine\n", "base\n", "yours\n"),
  ].join(""));
  assert.deepEqual(summarize(blocks), {
    identical: 1, "ours-only": 0, "theirs-only": 1, whitespace: 0, conflict: 1,
  });
});

test("reads the base of a real Git conflict and classifies it", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-analysis-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  // Two independent regions: one both sides change differently, one only the
  // branch changes but which Git still reports because it sits beside the other.
  writeFileSync(join(root, "file.txt"), "one\ntwo\nthree\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "base");

  git(root, "checkout", "-q", "-b", "branch");
  writeFileSync(join(root, "file.txt"), "one\nbranch-two\nthree\n");
  git(root, "commit", "-qam", "branch edit");

  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "file.txt"), "one\nmain-two\nthree\n");
  git(root, "commit", "-qam", "main edit");

  gitExpectingFailure(root, "merge", "branch");

  const repository = await discoverRepository(root, new GitRunner());
  const blocks = await repository.conflictAnalysis("file.txt");
  const conflicts = blocks.filter((block) => block.kind === "conflict");
  assert.equal(conflicts.length, 1);
  // The base line is exactly what neither side kept, which is the whole point.
  assert.equal(conflicts[0].base, "two\n");
  assert.equal(conflicts[0].ours, "main-two\n");
  assert.equal(conflicts[0].theirs, "branch-two\n");
  assert.equal(classifyConflict(conflicts[0].ours, conflicts[0].base, conflicts[0].theirs), "conflict");
});

test("recognises a whitespace-only collision in a real repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-ws-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "start\nvalue = 1\nend\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "base");

  git(root, "checkout", "-q", "-b", "branch");
  writeFileSync(join(root, "file.txt"), "start\nvalue=1\nend\n");
  git(root, "commit", "-qam", "branch reformat");

  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "file.txt"), "start\nvalue  =  1\nend\n");
  git(root, "commit", "-qam", "main reformat");

  gitExpectingFailure(root, "merge", "branch");

  const repository = await discoverRepository(root, new GitRunner());
  const blocks = await repository.conflictAnalysis("file.txt");
  const conflicts = blocks.filter((block) => block.kind === "conflict");
  assert.equal(conflicts.length, 1);
  assert.equal(classifyConflict(conflicts[0].ours, conflicts[0].base, conflicts[0].theirs), "whitespace");

  const resolved = resolveSimpleConflicts(blocks, LABELS);
  assert.equal(resolved.resolved, 1);
  assert.equal(resolved.remaining, 0);
  // Our formatting wins, and nothing else in the file moves.
  assert.equal(resolved.text, "start\nvalue  =  1\nend\n");
});

test("refuses to analyse a binary conflict line by line", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-binary-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  git(root, "add", "blob.bin");
  git(root, "commit", "-qm", "base");

  git(root, "checkout", "-q", "-b", "branch");
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 9, 9, 3]));
  git(root, "commit", "-qam", "branch binary");

  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 7, 7, 3]));
  git(root, "commit", "-qam", "main binary");

  gitExpectingFailure(root, "merge", "branch");

  const repository = await discoverRepository(root, new GitRunner());
  await assert.rejects(repository.conflictAnalysis("blob.bin"), /not a text file/);
});

/** Builds a conflict with one whitespace-only region and one genuine disagreement. */
function repositoryWithMixedConflict() {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-mixed-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  const spacer = ["sep1", "sep2", "sep3", "sep4", "sep5"].join("\n");
  writeFileSync(join(root, "file.txt"), `a1\na2\na3\n${spacer}\nb1\nb2\nb3\n`);
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "base");

  git(root, "checkout", "-q", "-b", "branch");
  writeFileSync(join(root, "file.txt"), `a1\na2 x\na3\n${spacer}\nb1\nyours\nb3\n`);
  git(root, "commit", "-qam", "branch edit");

  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "file.txt"), `a1\na2  x\na3\n${spacer}\nb1\nmine\nb3\n`);
  git(root, "commit", "-qam", "main edit");

  gitExpectingFailure(root, "merge", "branch");
  return root;
}

function isUnmerged(root, pathSpec) {
  return git(root, "ls-files", "--unmerged", "--", pathSpec).length > 0;
}

test("does not stage a file that still has a conflict left to decide", async () => {
  const root = repositoryWithMixedConflict();
  const repository = await discoverRepository(root, new GitRunner());
  const sides = { ours: "HEAD", base: "base", theirs: "branch" };

  const outcome = await repository.resolveSimpleConflicts("file.txt", sides);
  assert.equal(outcome.resolved, 1);
  assert.equal(outcome.remaining, 1);

  // Staging here would tell Git the whole conflict was settled.
  assert.equal(isUnmerged(root, "file.txt"), true);
  const content = readFileSync(join(root, "file.txt"), "utf8");
  assert.ok(content.includes("a2  x"), "the whitespace region should be settled in place");
  assert.ok(!content.includes("a2 x\n<"), "the resolved region must not keep markers");
  assert.ok(content.includes("<<<<<<< HEAD"), "the real conflict must survive for the user");
  assert.ok(content.includes("mine") && content.includes("yours"));
});

test("stages the file once nothing is left to decide", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-full-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "start\nvalue = 1\nend\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "base");

  git(root, "checkout", "-q", "-b", "branch");
  writeFileSync(join(root, "file.txt"), "start\nvalue=1\nend\n");
  git(root, "commit", "-qam", "branch reformat");

  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "file.txt"), "start\nvalue  =  1\nend\n");
  git(root, "commit", "-qam", "main reformat");
  gitExpectingFailure(root, "merge", "branch");

  const repository = await discoverRepository(root, new GitRunner());
  const outcome = await repository.resolveSimpleConflicts("file.txt", { ours: "HEAD", base: "base", theirs: "branch" });
  assert.equal(outcome.remaining, 0);
  assert.equal(isUnmerged(root, "file.txt"), false, "a fully resolved file should be staged");
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "start\nvalue  =  1\nend\n");
});

test("leaves the file untouched when nothing can be resolved mechanically", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-none-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "file.txt"), "one\ntwo\nthree\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-q", "-b", "branch");
  writeFileSync(join(root, "file.txt"), "one\nbranch\nthree\n");
  git(root, "commit", "-qam", "branch edit");
  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "file.txt"), "one\nmain\nthree\n");
  git(root, "commit", "-qam", "main edit");
  gitExpectingFailure(root, "merge", "branch");

  const before = readFileSync(join(root, "file.txt"), "utf8");
  const repository = await discoverRepository(root, new GitRunner());
  const outcome = await repository.resolveSimpleConflicts("file.txt", { ours: "HEAD", base: "base", theirs: "branch" });
  assert.equal(outcome.resolved, 0);
  // Rewriting the file to relabel markers would be a pointless, confusing diff.
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), before);
});

test("guards the resolve command and reports what it could not analyse", () => {
  const extension = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const command = extension.slice(extension.indexOf('registerCommand("jbGit.resolveSimpleConflicts"'));
  assert.ok(command.length > 0);
  assert.match(command.slice(0, 400), /requireTrustedWorkspace\(\)/);
  // A file that cannot be analysed must be reported, not dropped from the totals.
  assert.match(command.slice(0, 2_000), /skipped\.push/);
  assert.match(command.slice(0, 2_000), /conflictSideLabels\(first\)/);
});
