import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePorcelainBlame } from "../dist/git/blame.js";
import {
  abbreviateHash,
  authorLocalTime,
  formatRelativeDate,
  formatShortDate,
  layoutBlameAnnotations,
} from "../dist/blameAnnotations.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { readSource } from "./sourceText.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function createRepository(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  return root;
}

const HASH_A = "1111111111111111111111111111111111111111";
const HASH_B = "2222222222222222222222222222222222222222";

function group(hash, original, final, headers, content) {
  return [`${hash} ${original} ${final} 1`, ...headers, `\t${content}`].join("\n");
}

const FULL_HEADERS = [
  "author Alice A",
  "author-mail <alice@example.invalid>",
  "author-time 1700000000",
  "author-tz +0800",
  "committer Alice A",
  "committer-mail <alice@example.invalid>",
  "committer-time 1700000000",
  "committer-tz +0800",
  "summary first commit",
  "filename f.txt",
];

test("fills a repeated commit in from the cache instead of asking Git to resend it", () => {
  // `--porcelain` sends a commit's header block once. Reading it like
  // `--line-porcelain` leaves every later line of that commit with no author.
  const output = [
    group(HASH_A, 1, 1, FULL_HEADERS, "one"),
    group(HASH_A, 2, 2, [], "two"),
    group(HASH_A, 9, 3, [], "three"),
    "",
  ].join("\n");
  const entries = parsePorcelainBlame(output);
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.equal(entry.author, "Alice A");
    assert.equal(entry.authorMail, "alice@example.invalid");
    assert.equal(entry.summary, "first commit");
    assert.equal(entry.filename, "f.txt");
    assert.equal(entry.authorTimestamp, 1700000000);
  }
  assert.deepEqual(entries.map((entry) => entry.finalLine), [1, 2, 3]);
  assert.deepEqual(entries.map((entry) => entry.originalLine), [1, 2, 9]);
  assert.deepEqual(entries.map((entry) => entry.content), ["one", "two", "three"]);
});

test("a later block that repeats only one field does not blank out the rest", () => {
  const output = [
    group(HASH_A, 1, 1, FULL_HEADERS, "one"),
    group(HASH_A, 4, 2, ["filename moved.txt"], "two"),
    "",
  ].join("\n");
  const [, second] = parsePorcelainBlame(output);
  assert.equal(second.author, "Alice A", "the author from the first block must survive");
  assert.equal(second.filename, "moved.txt", "the field this block did send must win");
});

test("reads the previous revision and the path it had in it", () => {
  const output = [
    group(HASH_B, 2, 2, [
      "author Bob B",
      "author-time 1700000000",
      "author-tz +0000",
      "summary rename and edit",
      `previous ${HASH_A} old/name.txt`,
      "filename new/name.txt",
    ], "two"),
    "",
  ].join("\n");
  const [entry] = parsePorcelainBlame(output);
  assert.equal(entry.previousHash, HASH_A);
  // Following the rename backwards is the whole point: today's path does not
  // exist in yesterday's tree.
  assert.equal(entry.previousPath, "old/name.txt");
  assert.equal(entry.filename, "new/name.txt");
  assert.equal(entry.boundary, false);
});

test("marks a boundary commit and an uncommitted line", () => {
  const output = [
    group(HASH_A, 1, 1, [...FULL_HEADERS, "boundary"], "one"),
    group("0000000000000000000000000000000000000000", 2, 2, [
      "author External file (--contents)",
      "author-time 0",
      "author-tz +0000",
      "summary Version of f.txt from standard input",
      "filename f.txt",
    ], "typed just now"),
    "",
  ].join("\n");
  const [boundary, uncommitted] = parsePorcelainBlame(output);
  assert.equal(boundary.boundary, true);
  assert.equal(boundary.uncommitted, false);
  assert.equal(uncommitted.uncommitted, true);
});

test("keeps a carriage return that belongs to the file and drops the one that does not", () => {
  // Rewriting CRLF across the whole stream would strip a CR out of the blamed
  // content of a CRLF file.
  const output = [
    `${HASH_A} 1 1 1\r`,
    ...FULL_HEADERS.map((header) => `${header}\r`),
    "\tone\r",
    "",
  ].join("\n");
  const [entry] = parsePorcelainBlame(output);
  assert.equal(entry.author, "Alice A", "a protocol line's CR must not become part of its value");
  assert.equal(entry.summary, "first commit");
  assert.equal(entry.content, "one");
});

test("ignores a line of file content that looks like a group header", () => {
  const output = [
    group(HASH_A, 1, 1, FULL_HEADERS, `${HASH_B} 7 7 1`),
    group(HASH_A, 2, 2, [], "after"),
    "",
  ].join("\n");
  const entries = parsePorcelainBlame(output);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].content, `${HASH_B} 7 7 1`);
  assert.deepEqual(entries.map((entry) => entry.hash), [HASH_A, HASH_A]);
});

test("dates a line in the commit's own timezone, not the reader's", () => {
  const entry = {
    hash: HASH_A, originalLine: 1, finalLine: 1, author: "Alice A", authorMail: "",
    authorTime: "", authorTimestamp: 1700000000, authorTimezone: "+0800",
    summary: "", content: "", filename: "f.txt", boundary: false, uncommitted: false,
  };
  // 1700000000 is 2023-11-14T22:13:20Z, which is already the 15th in +0800.
  assert.equal(formatShortDate(entry), "2023-11-15");
  assert.equal(formatShortDate({ ...entry, authorTimezone: "+0000" }), "2023-11-14");
  assert.equal(formatShortDate({ ...entry, authorTimezone: "-1000" }), "2023-11-14");
  assert.equal(authorLocalTime({ ...entry, authorTimezone: "+0530" }).getUTCHours(), 3);
});

test("says how long ago a commit was without depending on the wall clock", () => {
  const base = {
    hash: HASH_A, originalLine: 1, finalLine: 1, author: "", authorMail: "", authorTime: "",
    authorTimestamp: 1700000000, authorTimezone: "+0000", summary: "", content: "",
    filename: "", boundary: false, uncommitted: false,
  };
  const at = (seconds) => formatRelativeDate(base, (1700000000 + seconds) * 1000);
  assert.equal(at(5), "just now");
  assert.equal(at(60), "1 minute ago");
  assert.equal(at(3 * 60), "3 minutes ago");
  assert.equal(at(2 * 3600), "2 hours ago");
  assert.equal(at(3 * 86400), "3 days ago");
  assert.equal(at(70 * 86400), "2 months ago");
  assert.equal(at(400 * 86400), "1 year ago");
  // Clock skew is not a prediction.
  assert.equal(at(-5000), "just now");
});

test("pads every annotation column so the fields line up down the gutter", () => {
  const entries = [
    { hash: HASH_A, finalLine: 1, author: "Al", authorTimestamp: 1700000000, authorTimezone: "+0000", uncommitted: false },
    { hash: HASH_B, finalLine: 2, author: "Bernadette", authorTimestamp: 1600000000, authorTimezone: "+0000", uncommitted: false },
  ];
  const lines = layoutBlameAnnotations(entries, {
    showAuthor: true, showDate: true, showRevision: true, dateFormat: "short", now: 0, maxAuthorWidth: 20,
  });
  assert.equal(lines[0].text.length, lines[1].text.length);
  assert.equal(lines[0].text, `${"Al".padEnd(10)} 2023-11-14 11111111`);
  assert.equal(lines[1].text, "Bernadette 2020-09-13 22222222");
  assert.deepEqual(lines.map((line) => line.line), [0, 1]);
  assert.deepEqual(lines.map((line) => line.startsRun), [true, true]);
});

test("truncates a name that would push the code off screen", () => {
  const [line] = layoutBlameAnnotations(
    [{ hash: HASH_A, finalLine: 1, author: "Bartholomew Featherstonehaugh", authorTimestamp: 1, authorTimezone: "+0000", uncommitted: false }],
    { showAuthor: true, showDate: false, showRevision: false, dateFormat: "short", now: 0, maxAuthorWidth: 10 },
  );
  assert.equal(line.text, "Bartholom…");
});

test("leaves an uncommitted line blank but treats it as the newest thing in the file", () => {
  const lines = layoutBlameAnnotations([
    { hash: HASH_A, finalLine: 1, author: "Alice", authorTimestamp: 1000, authorTimezone: "+0000", uncommitted: false },
    { hash: HASH_B, finalLine: 2, author: "Bob", authorTimestamp: 2000, authorTimezone: "+0000", uncommitted: false },
    { hash: "0".repeat(40), finalLine: 3, author: "External file (--contents)", authorTimestamp: 0, authorTimezone: "+0000", uncommitted: true },
  ], { showAuthor: true, showDate: false, showRevision: false, dateFormat: "short", now: 0, maxAuthorWidth: 20 });
  // IDEA does not invent an author for a line that is in no commit.
  assert.equal(lines[2].text.trim(), "");
  assert.equal(lines[2].heat, 1);
  assert.equal(lines[0].heat, 0, "the oldest commit in the file is the cool end");
  assert.equal(lines[1].heat, 1);
  // A blank annotation must not widen the column.
  assert.equal(lines[0].text.length, "Alice".length);
});

test("gives every line the same heat when the file has one commit", () => {
  const lines = layoutBlameAnnotations([
    { hash: HASH_A, finalLine: 1, author: "A", authorTimestamp: 5, authorTimezone: "+0000", uncommitted: false },
    { hash: HASH_A, finalLine: 2, author: "A", authorTimestamp: 5, authorTimezone: "+0000", uncommitted: false },
  ], { showAuthor: true, showDate: false, showRevision: false, dateFormat: "short", now: 0, maxAuthorWidth: 20 });
  assert.deepEqual(lines.map((line) => line.heat), [1, 1]);
  assert.deepEqual(lines.map((line) => line.startsRun), [true, false]);
});

test("abbreviates an object ID to the eight characters IDEA shows", () => {
  assert.equal(abbreviateHash(HASH_A), "11111111");
});

test("annotates a real repository and follows a rename to the previous revision", async () => {
  const root = createRepository("jb-git-blame-");
  // Big enough that renaming it stays well above Git's similarity threshold,
  // so the rename is detected and the untouched lines keep their own commit.
  const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  writeFileSync(join(root, "f.txt"), `${original}\n`);
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const first = git(root, "rev-parse", "HEAD");
  git(root, "mv", "f.txt", "g.txt");
  writeFileSync(join(root, "g.txt"), `${original.replace("line 2", "CHANGED")}\n`);
  git(root, "add", ".");
  git(root, "commit", "-qm", "rename and edit");
  const rename = git(root, "rev-parse", "HEAD");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  const entries = await repository.blame("g.txt");
  assert.equal(entries.length, 20);
  assert.equal(entries[0].hash, first);
  assert.equal(entries[0].author, "JB Git Test");
  assert.equal(entries[0].authorMail, "jb-git-test@example.invalid");
  assert.equal(entries[0].summary, "first");
  assert.ok(entries[0].authorTimestamp > 0);
  // Lines 3 onwards are untouched: their header block is sent once and the
  // rest are filled in from the cache.
  assert.equal(entries[19].hash, first);
  assert.equal(entries[19].author, "JB Git Test");
  assert.equal(entries[19].summary, "first");
  // The rewritten line belongs to the rename commit, and its previous revision
  // is the first commit under the file's old name.
  assert.equal(entries[1].hash, rename);
  assert.equal(entries[1].previousHash, first);
  assert.equal(entries[1].previousPath, "f.txt");
});

test("annotates an unsaved buffer against its own lines", async () => {
  const root = createRepository("jb-git-blame-dirty-");
  writeFileSync(join(root, "f.txt"), "one\ntwo\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  // What the editor holds, which is not what is on disk.
  const entries = await repository.blame("f.txt", undefined, "one\nINSERTED\ntwo\n");
  assert.deepEqual(entries.map((entry) => entry.content), ["one", "INSERTED", "two"]);
  assert.deepEqual(entries.map((entry) => entry.uncommitted), [false, true, false]);
  // Line 3 is still the committed "two": the annotation moved with the text
  // instead of staying on line 2.
  assert.equal(entries[2].summary, "first");
  assert.equal(entries[2].finalLine, 3);
});

test("refuses an option-like blame revision instead of running it as a flag", async () => {
  const root = createRepository("jb-git-blame-flags-");
  writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  // `git blame` re-parses its leftover arguments, so `--end-of-options` does
  // not protect this: `-L1,1` would run as a flag and return one line as if
  // that were the whole file.
  await assert.rejects(repository.blame("f.txt", "-L1,1"), /bad revision|needed a single revision/i);
  await assert.rejects(repository.blame("f.txt", "--reverse"), /bad revision|needed a single revision/i);
  assert.equal((await repository.blame("f.txt", "HEAD")).length, 3);
});

test("looks through a reindent when asked to ignore whitespace", async () => {
  const root = createRepository("jb-git-blame-w-");
  writeFileSync(join(root, "f.txt"), "alpha\nbeta\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const first = git(root, "rev-parse", "HEAD");
  // The only change is leading whitespace, which is exactly what -w exists for.
  writeFileSync(join(root, "f.txt"), "    alpha\n    beta\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "reindent");
  const reindent = git(root, "rev-parse", "HEAD");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  const plain = await repository.blame("f.txt");
  assert.deepEqual(plain.map((entry) => entry.hash), [reindent, reindent]);
  const ignoring = await repository.blame("f.txt", undefined, undefined, { ignoreWhitespace: true });
  assert.deepEqual(ignoring.map((entry) => entry.hash), [first, first], "a reindent is not the last real change to a line");
  // The content must stay the file's own, not the pre-reindent text.
  assert.deepEqual(ignoring.map((entry) => entry.content), ["    alpha", "    beta"]);
});

test("credits a block moved inside the file to where it came from", async () => {
  const root = createRepository("jb-git-blame-m-");
  const block = ["one", "two", "three", "four", "five", "six"].map((word) => `line ${word}`);
  writeFileSync(join(root, "f.txt"), `${block.join("\n")}\nTAIL\n`);
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const first = git(root, "rev-parse", "HEAD");
  // Move the whole block below TAIL without changing it.
  writeFileSync(join(root, "f.txt"), `TAIL\n${block.join("\n")}\n`);
  git(root, "add", ".");
  git(root, "commit", "-qm", "move the block");
  const moved = git(root, "rev-parse", "HEAD");
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  const detected = await repository.blame("f.txt", undefined, undefined, { detectMovementsWithinFile: true });
  const forBlock = detected.filter((entry) => entry.content.startsWith("line "));
  assert.equal(forBlock.length, block.length);
  assert.deepEqual([...new Set(forBlock.map((entry) => entry.hash))], [first], "the moved block keeps its original commit");
  assert.notEqual(first, moved);
});

test("asks Git for the porcelain form that sends each commit once", () => {
  const source = readSource("../src/git/repository.ts", import.meta.url);
  const blame = source.slice(source.indexOf("public async blame("));
  // `--line-porcelain` repeats the whole header block per line and costs about
  // four times the bytes on a large file.
  assert.doesNotMatch(blame.slice(0, 1200), /--line-porcelain/);
  assert.match(blame.slice(0, 1200), /"--porcelain"/);
  assert.match(blame.slice(0, 1200), /resolveCommit\(revision\)/);
});
