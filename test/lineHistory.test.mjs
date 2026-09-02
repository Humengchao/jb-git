import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mapLineRangeToHead, selectedLineRange } from "../dist/lineHistory.js";
import { parseUnifiedDiff } from "../dist/git/patch.js";
import { discoverRepository, lineRangeArgument } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { readSource } from "./sourceText.mjs";

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "jb-git-linehist-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  return root;
}

const lines = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

test("a selection below every hunk shifts by the net lines added and removed above it", () => {
  // Two lines inserted after line 2, one line removed at old line 10.
  const hunks = parseUnifiedDiff([
    "@@ -2,1 +2,3 @@", " line 2", "+new a", "+new b",
    "@@ -10,1 +12,0 @@", "-line 10",
  ].join("\n"));
  assert.deepEqual(mapLineRangeToHead(hunks, { start: 6, end: 7 }), { start: 4, end: 5 });
  assert.deepEqual(mapLineRangeToHead(hunks, { start: 13, end: 14 }), { start: 12, end: 13 });
  assert.deepEqual(mapLineRangeToHead([], { start: 3, end: 9 }), { start: 3, end: 9 });
});

test("a context line inside a hunk keeps its own counterpart", () => {
  const hunks = parseUnifiedDiff(["@@ -4,4 +4,5 @@", " line 4", "+inserted", " line 5", " line 6", " line 7"].join("\n"));
  assert.deepEqual(mapLineRangeToHead(hunks, { start: 4, end: 4 }), { start: 4, end: 4 });
  assert.deepEqual(mapLineRangeToHead(hunks, { start: 6, end: 8 }), { start: 5, end: 7 });
});

test("a line typed in place of removed lines inherits the lines it replaced", () => {
  // Old lines 5-6 became new lines 5-7.
  const hunks = parseUnifiedDiff(["@@ -4,4 +4,5 @@", " line 4", "-line 5", "-line 6", "+five", "+six", "+seven", " line 7"].join("\n"));
  assert.deepEqual(mapLineRangeToHead(hunks, { start: 6, end: 6 }), { start: 5, end: 6 });
  assert.deepEqual(mapLineRangeToHead(hunks, { start: 5, end: 8 }), { start: 5, end: 7 });
});

test("a selection made only of inserted text has no committed counterpart", () => {
  const hunks = parseUnifiedDiff(["@@ -4,2 +4,4 @@", " line 4", "+brand", "+new", " line 5"].join("\n"));
  assert.equal(mapLineRangeToHead(hunks, { start: 5, end: 6 }), undefined);
  // …but widening the selection to a shared line gives that line's history.
  assert.deepEqual(mapLineRangeToHead(hunks, { start: 5, end: 7 }), { start: 5, end: 5 });
  assert.throws(() => mapLineRangeToHead([], { start: 0, end: 3 }), /Invalid line range/);
  assert.throws(() => mapLineRangeToHead([], { start: 5, end: 3 }), /Invalid line range/);
});

test("an editor selection ending at column 0 does not include that line", () => {
  assert.deepEqual(selectedLineRange(4, 6, 0), { start: 5, end: 6 });
  assert.deepEqual(selectedLineRange(4, 6, 3), { start: 5, end: 7 });
  assert.deepEqual(selectedLineRange(4, 4, 0), { start: 5, end: 5 });
});

test("builds Git's -L argument and refuses a range Git could not honour", () => {
  assert.equal(lineRangeArgument({ path: "src/a.ts", start: 3, end: 9 }), "-L3,9:src/a.ts");
  assert.equal(lineRangeArgument({ path: "dir\\file.ts", start: 1, end: 1 }), "-L1,1:dir/file.ts");
  assert.throws(() => lineRangeArgument({ path: "a", start: 0, end: 1 }), /Invalid line range/);
  assert.throws(() => lineRangeArgument({ path: "a", start: 5, end: 4 }), /Invalid line range/);
  assert.throws(() => lineRangeArgument({ path: "", start: 1, end: 1 }), /Invalid file path/);
});

test("the log narrowed to a line range lists only the commits that touched it, through a rename", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), `${lines(6).join("\n")}\n`);
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "create");
  writeFileSync(join(root, "a.txt"), `${lines(6).map((line, index) => (index === 4 ? "line 5 changed" : line)).join("\n")}\n`);
  git(root, "commit", "-qam", "touch line 5");
  writeFileSync(join(root, "a.txt"), `${lines(6).map((line, index) => (index === 0 ? "line 1 changed" : index === 4 ? "line 5 changed" : line)).join("\n")}\n`);
  git(root, "commit", "-qam", "touch line 1");
  git(root, "mv", "a.txt", "b.txt");
  git(root, "commit", "-qm", "rename");
  writeFileSync(join(root, "unrelated.txt"), "x\n");
  git(root, "add", "unrelated.txt");
  git(root, "commit", "-qm", "unrelated");

  const repo = await discoverRepository(root, new GitRunner());
  const ranged = await repo.log(50, "b.txt", { lineRange: { path: "b.txt", start: 5, end: 5 }, exactPath: true });
  // The rename did not change the line, and `unrelated` never touched the file.
  assert.deepEqual(ranged.map((commit) => commit.subject), ["touch line 5", "create"]);
  const paged = await repo.logPage(1, 1, "b.txt", { lineRange: { path: "b.txt", start: 5, end: 5 }, exactPath: true });
  assert.deepEqual(paged.map((commit) => commit.subject), ["create"]);

  // Exact-file history follows the rename; the typed suffix filter does not
  // (Git refuses --follow for glob pathspecs, so the option is dropped there).
  const followed = await repo.log(50, "b.txt", { exactPath: true, follow: true });
  assert.deepEqual(followed.map((commit) => commit.subject), ["rename", "touch line 1", "touch line 5", "create"]);
  const suffix = await repo.log(50, "b.txt", { follow: true });
  assert.deepEqual(suffix.map((commit) => commit.subject), ["rename"]);

  assert.equal(await repo.isTrackedAtHead("b.txt"), true);
  assert.equal(await repo.isTrackedAtHead("a.txt"), false);
  assert.equal(await repo.isTrackedAtHead("unrelated.txt"), true);
});

test("Show History for Selection maps the editor lines to HEAD before asking Git", () => {
  const extension = readSource("../src/extension.ts", import.meta.url);
  const command = extension.slice(extension.indexOf('"jbGit.historyForSelection"'), extension.indexOf('"jbGit.blame"'));
  // An unsaved buffer cannot be matched through the on-disk diff.
  assert.match(command, /if \(editor\.document\.isDirty\)/);
  assert.match(command, /await manager\.isTrackedAtHead\(root, relativePath\)/);
  assert.match(command, /mapLineRangeToHead\(hunks, selection\)/);
  assert.match(command, /gitToolWindow\.open\(root, relativePath, "log", \{ path: relativePath, \.\.\.committed \}\)/);

  const manifest = JSON.parse(readSource("../package.json", import.meta.url));
  assert.ok(manifest.contributes.commands.some((item) => item.command === "jbGit.historyForSelection"));
  const menu = manifest.contributes.menus["editor/context"].find((item) => item.command === "jbGit.historyForSelection");
  assert.match(menu.when, /editorHasSelection/);

  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const host = panel.slice(0, panel.indexOf("const logScript = String.raw`"));
  // A typed path filter is a new question, so the old range is dropped, while
  // clearing the range alone keeps the whole file's history on screen.
  const setPath = host.slice(host.indexOf('message.type === "setPathFilter"'), host.indexOf('message.type === "clearLineRange"'));
  assert.match(setPath, /this\.filePathExact = false;\s*\n\s*this\.lineRange = undefined;/);
  const script = panel.slice(panel.indexOf("const logScript = String.raw`"));
  assert.match(script, /post\('clearLineRange'\)/);
  assert.match(script, /'Lines': '行'/);
});
