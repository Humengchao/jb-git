import assert from "node:assert/strict";
import test from "node:test";
import { isLogMessage, isToolTab } from "../dist/webviews/logPanelProtocol.js";

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
