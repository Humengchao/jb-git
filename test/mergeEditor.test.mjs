import assert from "node:assert/strict";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const source = readSource("../src/webviews/mergeEditor.ts", import.meta.url);
const scriptMatch = source.match(/const mergeScript = String\.raw`([\s\S]*?)`;\r?\n$/);

function conflictParser() {
  assert.ok(scriptMatch);
  const parserSource = scriptMatch[1].match(/(function marker\([\s\S]*?\n  })\r?\n\r?\n  function lineCount/);
  assert.ok(parserSource);
  return new Function(`${parserSource[1]}; return parseConflicts;`)();
}

test("keeps the embedded merge editor script syntactically valid", () => {
  assert.ok(scriptMatch, "embedded merge editor script should be present");
  assert.doesNotThrow(() => new Function(scriptMatch[1]));
});

test("provides editable three-pane conflict controls and a staged Apply flow", () => {
  assert.match(source, /class MergeConflictEditor/);
  assert.match(source, /conflictVersions/);
  assert.match(source, /applyConflictResult/);
  assert.match(scriptMatch[1], /Accept Left/);
  assert.match(scriptMatch[1], /Accept Right/);
  assert.match(scriptMatch[1], /take-both/);
  assert.match(scriptMatch[1], /vscode\.postMessage\(\{ type: 'apply', result: result\.value, deleted: resultDeleted }\)/);
  assert.match(scriptMatch[1], /querySelectorAll\('\.splitter'\)/);
  assert.match(source, /MERGE_DRAFTS_KEY/);
  assert.match(source, /conflictFingerprint/);
  assert.match(source, /changed outside this editor/);
  assert.match(scriptMatch[1], /type: 'dirty'/);
  assert.match(scriptMatch[1], /sourceLineHeight/);
  assert.match(scriptMatch[1], /updateHighlight/);
  assert.match(scriptMatch[1], /alignmentAnchors/);
  assert.match(scriptMatch[1], /setTimeout\(send, 300\)/);
  assert.match(source, /MAX_MERGE_DRAFT_BYTES/);
  assert.match(source, /MAX_MERGE_DRAFTS/);
  assert.match(source, /onDidReceiveMessage\(async \(message: unknown\)/);
  assert.match(source, /isMergeEditorMessage\(message\)/);
});

test("labels rebase conflict sides by replay semantics instead of generic ours and theirs", () => {
  assert.match(source, /operation === "rebase"/);
  assert.match(source, /Rebase Target/);
  assert.match(source, /Replayed Commit/);
  assert.match(source, /stopped-sha/);
  assert.match(source, /original-commit/);
});

test("parses ordinary and diff3 conflict markers without including marker lines", () => {
  const parseConflicts = conflictParser();
  const ordinary = "before\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> feature\nafter\n";
  assert.deepEqual(parseConflicts(ordinary).map(({ ours, theirs }) => ({ ours, theirs })), [
    { ours: "left\n", theirs: "right\n" },
  ]);

  const diff3 = "<<<<<<< ours\r\nleft\r\n||||||| base\r\nold\r\n=======\r\nright\r\n>>>>>>> theirs\r\n";
  assert.deepEqual(parseConflicts(diff3).map(({ ours, theirs }) => ({ ours, theirs })), [
    { ours: "left\r\n", theirs: "right\r\n" },
  ]);

  const wideMarkers = "<<<<<<<<<< ours\nleft\n==========\nright\n>>>>>>>>>> theirs\n";
  assert.equal(parseConflicts(wideMarkers).length, 1);
});

test("finds multiple conflicts for previous/next and per-block acceptance", () => {
  const parseConflicts = conflictParser();
  const text = [
    "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> topic\n",
    "middle\n",
    "<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> topic\n",
  ].join("");
  const conflicts = parseConflicts(text);
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts[0].end < conflicts[1].start);
  assert.equal(conflicts[1].ours, "c\n");
  assert.equal(conflicts[1].theirs, "d\n");
});
