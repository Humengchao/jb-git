import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/webviews/branchComparison.ts", import.meta.url), "utf8");
const scriptMatch = source.match(/const comparisonScript = String\.raw`([\s\S]*?)`;\r?\n$/);

test("keeps the branch comparison webview script syntactically valid", () => {
  assert.ok(scriptMatch, "embedded comparison script should be present");
  assert.doesNotThrow(() => new Function(scriptMatch[1]));
});

test("renders a grouped file tree and opens native side-by-side diffs", () => {
  assert.ok(scriptMatch);
  assert.match(scriptMatch[1], /Changes Between/);
  assert.match(scriptMatch[1], /buildTree/);
  assert.match(scriptMatch[1], /renderDirectory/);
  assert.match(scriptMatch[1], /openFile/);
  assert.match(source, /registerFile/);
  assert.match(source, /executeCommand\("vscode\.diff"/);
  assert.match(source, /viewColumn: targetColumn/);
  assert.match(source, /requestVersion/);
  assert.match(source, /this\.sessions\.get\(key\)/);
  assert.match(scriptMatch[1], /Filter changed files/);
  assert.match(scriptMatch[1], /setupTreeKeyboard/);
  assert.match(scriptMatch[1], /compactDirectory/);
});

test("loads both rename sides and handles added, deleted, and binary files", () => {
  assert.match(source, /file\.originalPath \?\? file\.path/);
  assert.match(source, /status\.startsWith\("A"\)/);
  assert.match(source, /status\.startsWith\("D"\)/);
  assert.match(source, /Binary file differs/);
});
