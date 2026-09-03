import assert from "node:assert/strict";
import test from "node:test";
import { isLogMessage, isToolTab } from "../dist/webviews/logPanelProtocol.js";
import { panelHost, readSource } from "./sourceText.mjs";

test("validates Webview messages at the extension-host boundary", () => {
  assert.equal(isLogMessage({ type: "commit", message: "subject", mode: "staged", push: true }), true);
  assert.equal(isLogMessage({ type: "applyHunk", path: "file.txt", source: "unstaged", index: 0 }), true);
  assert.equal(isLogMessage({ type: "contextAction", action: "showFileDiff", hash: "a".repeat(40), path: "file.txt" }), true);
  assert.equal(isLogMessage({ type: "contextAction", action: "compareBranches", branches: [{ name: "main", kind: "local" }] }), true);
  assert.equal(isLogMessage({ type: "selectCommit", hash: "a".repeat(40), root: "/repo", requestId: 1 }), true);

  assert.equal(isLogMessage({ type: "commit", mode: "staged" }), false);
  assert.equal(isLogMessage({ type: "commit", message: "subject", mode: "staged", push: "yes" }), false);
  assert.equal(isLogMessage({ type: "applyHunk", path: "file.txt", source: "all", index: 0 }), false);
  assert.equal(isLogMessage({ type: "checkout", name: "main", kind: "unknown" }), false);
  assert.equal(isLogMessage({ type: "contextAction", action: "compareBranches", branches: [{ name: "main", kind: "unknown" }] }), false);
  assert.equal(isLogMessage({ type: "contextAction", action: "madeUpAction", hash: "a".repeat(40) }), false);
  assert.equal(isLogMessage({ type: "madeUpAction" }), false);
  assert.equal(isLogMessage({ type: "selectCommit", hash: "a".repeat(40), root: 42 }), false);
  assert.equal(isLogMessage({ type: "selectCommit", hash: "a".repeat(40), requestId: 0 }), false);
  assert.equal(isLogMessage(null), false);
});

test("recognizes only real Git tool-window tabs", () => {
  for (const tab of ["log", "console", "changes", "shelf"]) assert.equal(isToolTab(tab), true);
  assert.equal(isToolTab("settings"), false);
});

test("allows repository/request identity metadata but rejects malformed values", () => {
  assert.equal(isLogMessage({ type: "requestHeadMessage", root: "/repo", requestId: 7 }), true);
  assert.equal(isLogMessage({ type: "requestHunks", path: "a.txt", root: "/repo", requestId: 7 }), true);
  assert.equal(isLogMessage({ type: "requestHunks", path: "a.txt", requestId: -1 }), false);
  assert.equal(isLogMessage({ type: "requestHunks", path: "a.txt", requestId: "7" }), false);
});

test("admits IDEA's history-editing, conflict and ignore messages with their bounds", () => {
  const hash = "a".repeat(40);
  assert.equal(isLogMessage({ type: "undoCommit", hash }), true);
  assert.equal(isLogMessage({ type: "rewordCommit", hash, message: "new subject\n\nbody" }), true);
  // The same ceiling as a commit message: the text lands in Git's message file.
  assert.equal(isLogMessage({ type: "rewordCommit", hash, message: "x".repeat(1_000_001) }), false);
  assert.equal(isLogMessage({ type: "rewordCommit", hash }), false);
  assert.equal(isLogMessage({ type: "rewordCommit", message: "m" }), false);
  assert.equal(isLogMessage({ type: "resolveWith", path: "a.txt", side: "ours" }), true);
  assert.equal(isLogMessage({ type: "resolveWith", path: "a.txt", side: "theirs" }), true);
  assert.equal(isLogMessage({ type: "resolveWith", path: "a.txt", side: "base" }), false);
  assert.equal(isLogMessage({ type: "resolveWith", side: "ours" }), false);
  assert.equal(isLogMessage({ type: "ignorePath", path: "build/out.log" }), true);
  assert.equal(isLogMessage({ type: "ignorePath" }), false);
  assert.equal(isLogMessage({ type: "clearLineRange" }), true);
  assert.equal(isLogMessage({ type: "contextAction", action: "checkoutAndRebase", ref: "feature", kind: "local" }), true);
  assert.equal(isLogMessage({ type: "contextAction", action: "checkoutAndRebase", ref: "feature", kind: "stash" }), false);
});

test("admits Fixup and the commit's Author field within their bounds", () => {
  const hash = "a".repeat(40);
  assert.equal(isLogMessage({ type: "fixupCommit", hash }), true);
  assert.equal(isLogMessage({ type: "fixupCommit" }), false);
  assert.equal(isLogMessage({ type: "commit", message: "m", mode: "staged", author: "Ada Lovelace <ada@example.invalid>" }), true);
  assert.equal(isLogMessage({ type: "commit", message: "m", mode: "staged", author: "Ada" }), true, "a bare name is a pattern Git resolves");
  // The value becomes `--author=`, so it is one bounded line.
  assert.equal(isLogMessage({ type: "commit", message: "m", mode: "staged", author: "a\nb" }), false);
  assert.equal(isLogMessage({ type: "commit", message: "m", mode: "staged", author: "x".repeat(513) }), false);
  assert.equal(isLogMessage({ type: "commit", message: "m", mode: "staged", author: 7 }), false);
});

test("admits the Local Changes and Branches-pane messages with their bounds", () => {
  assert.equal(isLogMessage({ type: "rollbackHunk", path: "a.txt", index: 0 }), true);
  assert.equal(isLogMessage({ type: "rollbackHunk", path: "a.txt", index: -1 }), false);
  assert.equal(isLogMessage({ type: "rollbackHunk", path: "a.txt" }), false);
  assert.equal(isLogMessage({ type: "rollbackHunk", index: 2 }), false);
  assert.equal(isLogMessage({ type: "createLocalPatch" }), true);
  assert.equal(isLogMessage({ type: "toggleFavoriteBranch", name: "main", kind: "local" }), true);
  assert.equal(isLogMessage({ type: "toggleFavoriteBranch", name: "origin/main", kind: "remote" }), true);
  assert.equal(isLogMessage({ type: "toggleFavoriteBranch", name: "main", kind: "stash" }), false);
  assert.equal(isLogMessage({ type: "toggleFavoriteBranch", kind: "local" }), false);
  assert.equal(isLogMessage({ type: "contextAction", action: "updateRef", ref: "main", kind: "local" }), true);
  assert.equal(isLogMessage({ type: "contextAction", action: "updateRef", ref: "main", kind: "banana" }), false);
});

test("every message the protocol admits reaches exactly one handler group", () => {
  // The tool window's message handling is split by subject, and the groups are
  // called one after another because their type sets are disjoint. That only
  // stays true if it is checked: a type handled twice would run twice, and one
  // handled nowhere would be silently dropped after passing validation.
  const protocol = readSource("../src/webviews/logPanelProtocol.ts", import.meta.url);
  const host = panelHost(import.meta.url);

  const declared = new Set();
  for (const [, union] of protocol.matchAll(/\| \{ type: ((?:"[a-zA-Z]+"(?: \| )?)+)/g)) {
    for (const [, name] of union.matchAll(/"([a-zA-Z]+)"/g)) declared.add(name);
  }
  // The sets the validator keeps for the repetitive families.
  for (const [, list] of protocol.matchAll(/(?:SIMPLE_TYPES|HASH_TYPES|PATH_TYPES|ID_TYPES) = new Set\(\[([^\]]*)\]\)/g)) {
    for (const [, name] of list.matchAll(/"([a-zA-Z]+)"/g)) declared.add(name);
  }
  assert.ok(declared.size > 40, `expected the protocol's message types, found ${declared.size}`);

  const groups = [...host.matchAll(/private async (handle\w+Message)\(/g)].map((match) => match[1]);
  assert.ok(groups.length >= 6, `expected the subject handlers, found ${groups.join(", ")}`);
  // handleMessage must actually call each of them, or a whole subject is dead.
  const dispatcher = host.slice(host.indexOf("private async handleMessage("), host.indexOf("private async handleContextActionMessage("));
  for (const group of groups) assert.match(dispatcher, new RegExp(`await this\\.${group}\\(message`), `${group} must be dispatched`);

  // Where each type is handled: the dispatcher's own branches count too.
  const bodies = new Map();
  for (const [index, group] of groups.entries()) {
    const start = host.indexOf(`private async ${group}(`);
    const end = index + 1 < groups.length ? host.indexOf(`private async ${groups[index + 1]}(`) : host.length;
    bodies.set(group, host.slice(start, end));
  }
  bodies.set("handleMessage", dispatcher);

  const missing = [];
  const duplicated = [];
  for (const type of [...declared].sort()) {
    const owners = [...bodies].filter(([, body]) => new RegExp(`message\\.type === "${type}"`).test(body)).map(([name]) => name);
    if (owners.length === 0) missing.push(type);
    if (owners.length > 1) duplicated.push(`${type} in ${owners.join(" + ")}`);
  }
  assert.deepEqual(missing, [], "every admitted message type needs a handler");
  assert.deepEqual(duplicated, [], "a type handled by two groups would run twice");
});
