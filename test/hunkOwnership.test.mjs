import assert from "node:assert/strict";
import test from "node:test";
import { commitSelectionFor, hunkKeys, partitionHunks, reconcileClaims } from "../dist/changelists/hunkOwnership.js";
import { isLogMessage } from "../dist/webviews/logPanelProtocol.js";
import { parseUnifiedDiff } from "../dist/git/patch.js";
import { readSource } from "./sourceText.mjs";

function hunk(header, ...lines) {
  return { header, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines };
}

test("names a hunk by what it changes, not by where it is", () => {
  // The same edit, moved down the file and with different neighbours around it.
  const before = hunk("@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three");
  const after = hunk("@@ -40,3 +40,3 @@", " forty", "-two", "+TWO", " forty-two");
  assert.deepEqual(hunkKeys([before]), hunkKeys([after]));
});

test("tells two identical edits in one file apart by their order", () => {
  const same = () => hunk("@@ -1,1 +1,1 @@", "-a", "+b");
  const keys = hunkKeys([same(), same(), same()]);
  assert.equal(new Set(keys).size, 3, "three identical edits need three names");
  assert.deepEqual(keys.map((key) => key.split(":")[1]), ["0", "1", "2"]);
  assert.equal(new Set(keys.map((key) => key.split(":")[0])).size, 1, "the content half is the same");
});

test("counts the no-newline marker as part of the change", () => {
  const withMarker = hunk("@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file");
  const without = hunk("@@ -1 +1 @@", "-a", "+b");
  assert.notDeepEqual(hunkKeys([withMarker]), hunkKeys([without]));
});

test("gives different edits different names", () => {
  const [first, second] = hunkKeys([
    hunk("@@ -1,1 +1,1 @@", "-a", "+b"),
    hunk("@@ -9,1 +9,1 @@", "-c", "+d"),
  ]);
  assert.notEqual(first, second);
});

test("keeps a claim while its hunk is present and drops it once it is gone", () => {
  const keys = hunkKeys([
    hunk("@@ -1,1 +1,1 @@", "-a", "+b"),
    hunk("@@ -9,1 +9,1 @@", "-c", "+d"),
  ]);
  assert.deepEqual(reconcileClaims(keys, keys), keys);
  // The second edit was reverted; only its claim goes.
  assert.deepEqual(reconcileClaims(keys, [keys[0]]), [keys[0]]);
  assert.deepEqual(reconcileClaims(keys, []), []);
});

test("puts every unclaimed hunk in the file's own list", () => {
  const keys = ["a:0", "b:0", "c:0"];
  const { byList, split } = partitionHunks(keys, new Map(), "home");
  assert.equal(split, false);
  assert.deepEqual([...byList.keys()], ["home"]);
  assert.deepEqual(byList.get("home"), [0, 1, 2]);
});

test("moves only the claimed hunks out of the file's own list", () => {
  const keys = ["a:0", "b:0", "c:0", "d:0"];
  const { byList, split } = partitionHunks(keys, new Map([["bugfix", ["b:0", "d:0"]]]), "home");
  assert.equal(split, true);
  assert.deepEqual(byList.get("home"), [0, 2]);
  assert.deepEqual(byList.get("bugfix"), [1, 3]);
});

test("covers every hunk exactly once, whatever the claims say", () => {
  const keys = ["a:0", "b:0", "c:0"];
  // A claim on a hunk that is not in the file, and one hunk claimed twice:
  // neither may make a hunk disappear from the commit.
  const claims = new Map([
    ["bugfix", ["b:0", "gone:0"]],
    ["other", ["b:0", "c:0"]],
  ]);
  const { byList } = partitionHunks(keys, claims, "home");
  const covered = [...byList.values()].flat().sort((left, right) => left - right);
  assert.deepEqual(covered, [0, 1, 2]);
  assert.equal([...byList.values()].flat().length, 3, "no hunk may be committed twice either");
  assert.deepEqual(byList.get("bugfix"), [1], "the first claimant wins");
  assert.deepEqual(byList.get("other"), [2]);
});

test("ignores a claim the home list makes on its own file", () => {
  const keys = ["a:0", "b:0"];
  const { byList, split } = partitionHunks(keys, new Map([["home", ["a:0"]]]), "home");
  assert.equal(split, false);
  assert.deepEqual(byList.get("home"), [0, 1]);
});

test("commits a file nobody split exactly as before, in one piece", () => {
  assert.equal(commitSelectionFor("home", "home", new Map()), "whole");
  assert.equal(commitSelectionFor("other", "home", new Map()), "none");
});

test("the file's own list commits everything the others did not claim", () => {
  const selection = commitSelectionFor("home", "home", new Map([["bugfix", ["b:0"]], ["docs", ["c:0"]]]));
  assert.deepEqual(selection, { mode: "except", keys: ["b:0", "c:0"] });
});

test("a list that claimed hunks commits only those", () => {
  const claims = new Map([["bugfix", ["b:0", "d:0"]], ["docs", ["c:0"]]]);
  assert.deepEqual(commitSelectionFor("bugfix", "home", claims), { mode: "only", keys: ["b:0", "d:0"] });
  assert.deepEqual(commitSelectionFor("docs", "home", claims), { mode: "only", keys: ["c:0"] });
  assert.equal(commitSelectionFor("unrelated", "home", claims), "none");
});

test("the two modes are not interchangeable", () => {
  // The home list has to keep a hunk that appears after the split was made,
  // and a claiming list must not: that is why one is an include list and the
  // other an exclude list rather than one set used both ways.
  const claims = new Map([["bugfix", ["b:0"]]]);
  const home = commitSelectionFor("home", "home", claims);
  const bugfix = commitSelectionFor("bugfix", "home", claims);
  const keys = ["a:0", "b:0", "brand-new:0"];
  const included = (selection) => (selection.mode === "only"
    ? keys.filter((key) => selection.keys.includes(key))
    : keys.filter((key) => !selection.keys.includes(key)));
  assert.deepEqual(included(home), ["a:0", "brand-new:0"]);
  assert.deepEqual(included(bugfix), ["b:0"]);
});

test("does not list the same claimed hunk twice when two lists name it", () => {
  const selection = commitSelectionFor("home", "home", new Map([["a", ["x:0"]], ["b", ["x:0"]]]));
  assert.deepEqual(selection, { mode: "except", keys: ["x:0"] });
});

test("names the hunks of a real unified diff", () => {
  const diff = [
    "diff --git a/app.js b/app.js",
    "index 1111111..2222222 100644",
    "--- a/app.js",
    "+++ b/app.js",
    "@@ -1,3 +1,3 @@",
    " function greet(name) {",
    "-  return `Hi, ${name}`;",
    "+  return `Hello, ${name}`;",
    " }",
    "@@ -10,2 +10,3 @@",
    " module.exports = {",
    "+  greet,",
    " };",
    "",
  ].join("\n");
  const hunks = parseUnifiedDiff(diff);
  assert.equal(hunks.length, 2);
  const keys = hunkKeys(hunks);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  for (const key of keys) assert.match(key, /^[0-9a-f]{16}:\d+$/);
  // Re-reading the same diff has to produce the same names, or every claim is
  // lost on the next refresh.
  assert.deepEqual(hunkKeys(parseUnifiedDiff(diff)), keys);
});

test("names the hunk being moved by content, not by where it sits", () => {
  // An index would move whichever change happens to be in that position when
  // the message arrives, which is not the one the user pointed at.
  assert.equal(isLogMessage({ type: "moveHunk", path: "a.txt", key: "abc:0" }), true);
  assert.equal(isLogMessage({ type: "moveHunk", path: "a.txt" }), false);
  assert.equal(isLogMessage({ type: "moveHunk", path: "a.txt", key: 3 }), false);
});

test("reads ownership against HEAD, which is not the staged/unstaged split", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const method = panel.slice(panel.indexOf("private async readOwnedHunks("));
  // Staging is a different question: a hunk can be staged and still belong to
  // another Changelist, so this cannot be a re-slice of the Index diff.
  assert.match(method.slice(0, 1400), /this\.manager\.diffAgainstHead\(root, filePath\)/);
  assert.match(method.slice(0, 1400), /reconcileHunks\(root, filePath, keys\)/);
  assert.match(method.slice(0, 1400), /partitionHunks\(keys, this\.changelists\.claims\(root, filePath\), home\)/);
  // A file appears under every list that owns part of it, or the claiming list
  // looks empty while its commit would take those hunks.
  assert.match(panel, /homeByPath\.get\(change\.path\)/);
  // "Complete contents" must say when it is about to take another list's work.
  assert.match(panel, /const split = this\.changelists\.splitPaths\(root, paths\);/);
  assert.match(panel, /"Commit Everything"/);
});

test("commits a Changelist through its plan rather than by file ownership alone", () => {
  const extension = readSource("../src/extension.ts", import.meta.url);
  assert.match(extension, /changelistStore\.commitPlan\(/);
  assert.match(extension, /plan\.hunkSelections\)/);
  const repository = readSource("../src/git/repository.ts", import.meta.url);
  // The patch is measured against HEAD and applied to an index seeded from
  // HEAD; --cached is what leaves the other lists' hunks in the working tree.
  assert.match(repository, /"apply", "--cached", "--whitespace=nowarn", "-"/);
  assert.match(repository, /patchForHunks\(output, chosen\)/);
});
