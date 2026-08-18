import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/webviews/logPanel.ts", import.meta.url), "utf8");
const scriptMatch = source.match(/const logScript = String\.raw`([\s\S]*?)`;\n$/);

test("keeps the embedded Git tool-window script syntactically valid", () => {
  assert.ok(scriptMatch, "embedded webview script should be present");
  assert.doesNotThrow(() => new Function(scriptMatch[1]));
});

test("wires context menus for branches, commits, and changed files", () => {
  assert.ok(scriptMatch);
  assert.equal(scriptMatch[1].match(/attachContextMenu\(row,/g)?.length, 3);
  assert.match(scriptMatch[1], /event\.key === 'F10'/);
  assert.match(scriptMatch[1], /event\.key !== 'ContextMenu'/);
});

test("uses one commit scroll area and a mouse-and-keyboard resizable details pane", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /scroll\.append\(head, list\)/);
  assert.match(scriptMatch[1], /splitter\.addEventListener\('mousedown'/);
  assert.match(scriptMatch[1], /event\.key !== 'ArrowUp'/);
  assert.match(scriptMatch[1], /aria-valuenow/);
});

test("supports persistent horizontal resizing for all three Git log columns", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /columnSplitter\('branch'\)/);
  assert.match(scriptMatch[1], /columnSplitter\('details'\)/);
  assert.match(scriptMatch[1], /branchPaneWidth/);
  assert.match(scriptMatch[1], /detailsPaneWidth/);
  assert.match(scriptMatch[1], /event\.key !== 'ArrowLeft'/);
  assert.match(scriptMatch[1], /aria-valuemax/);
});

test("supports modifier-click branch selection and multi-branch actions", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(scriptMatch[1], /selectedBranchKeys/);
  assert.match(scriptMatch[1], /Compare Branches/);
  assert.match(scriptMatch[1], /Show Files Diff/);
  assert.match(scriptMatch[1], /deleteBranches/);
});

test("provides real branch, user, date, path, and ordering filters", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /Text or hash/);
  assert.match(scriptMatch[1], /branchFilterItems/);
  assert.match(scriptMatch[1], /userFilterItems/);
  assert.match(scriptMatch[1], /dateFilterItems/);
  assert.match(scriptMatch[1], /setPathFilter/);
  assert.match(scriptMatch[1], /sortAscending/);
});
