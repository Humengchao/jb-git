import assert from "node:assert/strict";
import test from "node:test";
import { isLogMessage, oldestFirst } from "../dist/webviews/logPanelProtocol.js";
import { panelHost, panelScript, readSource } from "./sourceText.mjs";

const HASH = (letter) => letter.repeat(40);

test("a multi-commit action is validated at the boundary", () => {
  assert.equal(isLogMessage({ type: "commitsAction", action: "cherryPickCommits", hashes: [HASH("a"), HASH("b")] }), true);
  assert.equal(isLogMessage({ type: "commitsAction", action: "compareCommits", hashes: [HASH("a"), HASH("b")] }), true);

  assert.equal(isLogMessage({ type: "commitsAction", action: "cherryPickCommits", hashes: [] }), false, "an empty selection is not an action");
  assert.equal(isLogMessage({ type: "commitsAction", action: "cherryPickCommits", hashes: "abc" }), false);
  assert.equal(isLogMessage({ type: "commitsAction", action: "cherryPickCommits", hashes: [42] }), false);
  assert.equal(isLogMessage({ type: "commitsAction", action: "cherryPickCommits", hashes: ["x".repeat(65)] }), false, "longer than a SHA-256 id");
  assert.equal(isLogMessage({ type: "commitsAction", action: "cherryPickCommits", hashes: Array.from({ length: 1001 }, () => HASH("a")) }), false);
  assert.equal(isLogMessage({ type: "commitsAction", action: "rebaseCommits", hashes: [HASH("a")] }), false, "unknown action");
});

test("the selection applies in the log's order, not the click order", () => {
  // Display order is newest first; applying oldest first means walking it backwards.
  const display = [HASH("d"), HASH("c"), HASH("b"), HASH("a")];
  assert.deepEqual(oldestFirst([HASH("c"), HASH("a"), HASH("d")], display), [HASH("a"), HASH("c"), HASH("d")]);
  // Click order is irrelevant; duplicates collapse; unknown hashes are dropped, not guessed about.
  assert.deepEqual(oldestFirst([HASH("a"), HASH("c"), HASH("a"), HASH("f")], display), [HASH("a"), HASH("c")]);
  assert.deepEqual(oldestFirst([HASH("f")], display), []);
});

test("the Webview gathers the selection with the modifiers IDEA uses", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panelScript(import.meta.url);
  // Ctrl/Cmd toggles, Shift ranges from the anchor, and a plain click resets.
  assert.match(script, /if \(event\.ctrlKey \|\| event\.metaKey\) return toggleCommitInSelection\(commit\.hash\);/);
  assert.match(script, /if \(event\.shiftKey\) return extendCommitSelection\(commit\.hash\);/);
  assert.match(script, /multiSelectedHashes = new Set\(\); commitSelectionAnchor = commit\.hash;/);
  // Keyboard parity: Shift+arrows grow the range the way Shift+click does.
  assert.match(script, /if \(event\.shiftKey && \(event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'\)\)/);
  // The toggle seeds the set from the current single selection, so the first
  // Ctrl+click selects two commits, not one.
  assert.match(script, /if \(primary && virtualCommits\.some\(commit => commit\.hash === primary\)\) multiSelectedHashes\.add\(primary\);/);
  // A multi-selection row offers the multi menu; batch actions post the set.
  assert.match(script, /multiSelectedHashes\.size > 1 && multiSelectedHashes\.has\(commit\.hash\)/);
  assert.match(script, /post\('commitsAction', \{ action: 'cherryPickCommits', hashes \}\)/);
  assert.match(script, /disabled: hashes\.length !== 2, run: \(\) => post\('commitsAction', \{ action: 'compareCommits', hashes \}\)/);
  // The details pane summarises the selection without a host round trip, and a
  // reload prunes selected commits that fell out of the loaded window.
  assert.match(script, /commits selected'/);
  assert.match(script, /multiSelectedHashes = new Set\(\[\.\.\.multiSelectedHashes\]\.filter\(hash => live\.has\(hash\)\)\);/);
});

test("the host reorders, confirms, and reports how far a stopped batch got", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const host = panelHost(import.meta.url);
  // The order the Webview sent is never trusted; the host's own log decides.
  assert.match(host, /const requestedHashes = \[\.\.\.new Set\(message\.hashes\)\];/);
  assert.match(host, /oldestFirst\(requestedHashes, this\.currentCommits\.map\(\(commit\) => commit\.hash\)\)/);
  assert.match(host, /if \(hashes\.length !== requestedHashes\.length\) return;/);
  // Comparing reads oldest → newest, and the host uses one cancellable,
  // serialized batch operation so a conflict stops without N refreshes.
  assert.match(host, /if \(hashes\.length !== 2\) return;\s*\n\s*\/\/[^\n]*\n\s*const diff = await snapshot\.repository\.diffRefs\(hashes\[0\], hashes\[1\]\);/);
  assert.match(host, /await this\.manager\.cherryPickMany\(root, hashes, controller\.signal, /);
  assert.match(host, /batch\?\.currentHash\.slice\(0, 8\)/);
});
