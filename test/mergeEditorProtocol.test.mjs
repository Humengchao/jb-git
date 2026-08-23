import assert from "node:assert/strict";
import test from "node:test";
import { isMergeEditorMessage } from "../dist/webviews/mergeEditorProtocol.js";

test("validates merge-editor messages at the extension-host boundary", () => {
  assert.equal(isMergeEditorMessage({ type: "ready" }), true);
  assert.equal(isMergeEditorMessage({ type: "dirty", result: "content", deleted: false }), true);
  assert.equal(isMergeEditorMessage({ type: "apply", result: "content", deleted: true }), true);
  assert.equal(isMergeEditorMessage({ type: "confirm", action: "acceptLeft" }), true);

  assert.equal(isMergeEditorMessage({ type: "apply", result: 42 }), false);
  assert.equal(isMergeEditorMessage({ type: "dirty", result: "content", deleted: "yes" }), false);
  assert.equal(isMergeEditorMessage({ type: "confirm", action: "overwriteAnything" }), false);
  assert.equal(isMergeEditorMessage({ type: "unknown" }), false);
});
