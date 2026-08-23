import assert from "node:assert/strict";
import test from "node:test";
import { isLogMessage, isToolTab } from "../dist/webviews/logPanelProtocol.js";

test("validates Webview messages at the extension-host boundary", () => {
  assert.equal(isLogMessage({ type: "commit", message: "subject", mode: "staged", push: true }), true);
  assert.equal(isLogMessage({ type: "applyHunk", path: "file.txt", source: "unstaged", index: 0 }), true);
  assert.equal(isLogMessage({ type: "contextAction", action: "showFileDiff", hash: "a".repeat(40), path: "file.txt" }), true);
  assert.equal(isLogMessage({ type: "contextAction", action: "compareBranches", branches: [{ name: "main", kind: "local" }] }), true);

  assert.equal(isLogMessage({ type: "commit", mode: "staged" }), false);
  assert.equal(isLogMessage({ type: "commit", message: "subject", mode: "staged", push: "yes" }), false);
  assert.equal(isLogMessage({ type: "applyHunk", path: "file.txt", source: "all", index: 0 }), false);
  assert.equal(isLogMessage({ type: "checkout", name: "main", kind: "unknown" }), false);
  assert.equal(isLogMessage({ type: "contextAction", action: "compareBranches", branches: [{ name: "main", kind: "unknown" }] }), false);
  assert.equal(isLogMessage({ type: "contextAction", action: "madeUpAction", hash: "a".repeat(40) }), false);
  assert.equal(isLogMessage({ type: "madeUpAction" }), false);
  assert.equal(isLogMessage(null), false);
});

test("recognizes only real Git tool-window tabs", () => {
  for (const tab of ["log", "console", "changes", "shelf"]) assert.equal(isToolTab(tab), true);
  assert.equal(isToolTab("settings"), false);
});
