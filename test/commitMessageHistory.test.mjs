import assert from "node:assert/strict";
import test from "node:test";
import { isLogMessage } from "../dist/webviews/logPanelProtocol.js";
import { readSource } from "./sourceText.mjs";

const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
const script = panel.slice(panel.indexOf("const logScript = String.raw`"));

test("accepts the amend and history requests at the extension-host boundary", () => {
  assert.equal(isLogMessage({ type: "requestHeadMessage" }), true);
  assert.equal(isLogMessage({ type: "messageHistory" }), true);
});

test("checking Amend fills the box with the commit being amended, like IDEA", () => {
  // The host reads HEAD's complete message; an unborn branch replies empty and
  // the box is left alone.
  assert.match(panel, /const \[head\] = await snapshot\.repository\.logRef\("HEAD", 1\);/);
  assert.match(panel, /if \(head\) full = originalMessage\(head\);/);
  assert.match(panel, /postMessage\(\{ type: "headMessage", message: full \}\)/);
  // The sandbox remembers what was typed and restores it on uncheck.
  assert.match(script, /preAmendDrafts\[root\] = message\.value;\s*\n\s*post\('requestHeadMessage'\);/);
  assert.match(script, /message\.value = preAmendDrafts\[root\];/);
  assert.match(script, /delete preAmendDrafts\[root\];/);
  // The reply may arrive after the user unchecked again, and must not fill then.
  assert.match(script, /const amendBox = document\.getElementById\('amend-toggle'\);/);
  assert.match(script, /if \(amendBox && amendBox\.checked\) fillCommitMessage\(event\.data\.message\);/);
  // Filling goes through the box's own input listener so the draft is saved
  // and the Commit buttons re-enable; a bare .value assignment does neither.
  assert.match(script, /box\.dispatchEvent\(new Event\('input'\)\)/);
});

test("offers the recorded messages back through a native picker", () => {
  assert.match(panel, /if \(message\.type === "messageHistory"\)/);
  assert.match(panel, /const history = this\.commitMessageHistory\(root\);/);
  assert.match(panel, /vscode\.l10n\.t\("Commit Message History"\)/);
  assert.match(panel, /postMessage\(\{ type: "applyCommitMessage", message: picked\.message \}\)/);
  // Every surface that creates a commit records its message, or the history
  // misses exactly the messages typed outside the tool window.
  assert.match(panel, /await this\.recordCommitMessage\(root, commitMessage\);/);
  const extension = readSource("../src/extension.ts", import.meta.url);
  assert.equal(
    [...extension.matchAll(/gitToolWindow\.recordCommitMessage\(/g)].length,
    2,
    "both the palette commit and the Changelist commit record their message",
  );
});

test("does not pre-check unversioned files, like IDEA's commit view", () => {
  // Auto-checking untracked paths meant one stray build directory made Commit
  // stage thousands of junk files; 2,475 of them, in the capture that found it.
  const method = panel.slice(panel.indexOf("private syncSelection("));
  assert.match(
    method.slice(0, 900),
    /change\.kind !== "untracked" && change\.kind !== "ignored"/,
    "only tracked changes may be checked automatically",
  );
  assert.match(method.slice(0, 900), /for \(const filePath of autoCheck\) selected\.add\(filePath\);/);
  assert.match(method.slice(0, 900), /if \(!known\.has\(filePath\)\) selected\.add\(filePath\);/);
});
