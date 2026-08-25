import assert from "node:assert/strict";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const source = readSource("../src/webviews/branchComparison.ts", import.meta.url);
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

test("speaks the user's language and draws its dropdown from the theme", () => {
  // This was the last webview whose strings never passed through a translator
  // and whose select was the browser default.
  assert.match(source, /'Filter changed files': '筛选更改的文件'/);
  assert.match(source, /const t = value => typeof value === 'string' \? \(zh\[value\] \|\| value\) : value;/);
  assert.match(source, /textContent = t\(text\)/);
  assert.match(source, /\.select-shell select \{[^}]*appearance: none/);
  assert.match(source, /statusShell\.append\(status\)/);
  // Counted nouns go through one helper instead of English concatenation.
  assert.match(source, /const fileCount = count =>/);
  assert.doesNotMatch(source, /\+ ' files'/);
  // File names carry their status colour, like the tool window and IDEA.
  assert.match(source, /'file-name status-' \+ status/);
});
