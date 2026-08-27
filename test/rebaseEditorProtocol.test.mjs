import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRebaseEditorMessage, originalMessage, planCoversSameCommits } from "../dist/webviews/rebaseEditorProtocol.js";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function source(file) {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

test("validates rebase-editor messages at the extension-host boundary", () => {
  assert.equal(isRebaseEditorMessage({ type: "ready" }), true);
  assert.equal(isRebaseEditorMessage({ type: "cancel" }), true);
  assert.equal(isRebaseEditorMessage({ type: "start", steps: [] }), true);
  assert.equal(isRebaseEditorMessage({ type: "start", steps: [{ oid: OID_A, action: "pick" }] }), true);
  assert.equal(isRebaseEditorMessage({ type: "start", steps: [{ oid: OID_A, action: "reword", message: "m" }] }), true);

  assert.equal(isRebaseEditorMessage({ type: "start", steps: [{ oid: OID_A, action: "exec" }] }), false);
  assert.equal(isRebaseEditorMessage({ type: "start", steps: [{ oid: 42, action: "pick" }] }), false);
  assert.equal(isRebaseEditorMessage({ type: "start", steps: [{ oid: OID_A, action: "pick", message: 7 }] }), false);
  assert.equal(isRebaseEditorMessage({ type: "start", steps: "all" }), false);
  assert.equal(isRebaseEditorMessage({ type: "unknown" }), false);
  assert.equal(isRebaseEditorMessage(null), false);
});

test("accepts only a plan that covers exactly the commits that were offered", () => {
  assert.equal(planCoversSameCommits([{ oid: OID_A, action: "pick" }], [OID_A]), true);
  // Reordering is the whole point of the editor, so order must not matter here.
  assert.equal(planCoversSameCommits(
    [{ oid: OID_B, action: "pick" }, { oid: OID_A, action: "pick" }],
    [OID_A, OID_B],
  ), true);

  assert.equal(planCoversSameCommits([{ oid: OID_A, action: "pick" }], [OID_A, OID_B]), false, "a dropped row must not silently shrink the plan");
  assert.equal(planCoversSameCommits(
    [{ oid: OID_A, action: "pick" }, { oid: "c".repeat(40), action: "pick" }],
    [OID_A, OID_B],
  ), false, "a substituted commit must be rejected");
  assert.equal(planCoversSameCommits(
    [{ oid: OID_A, action: "pick" }, { oid: OID_A, action: "pick" }],
    [OID_A, OID_B],
  ), false, "a duplicated commit must be rejected");
});

test("prefills a reword from the complete message without repeating the subject", () => {
  // Git's %B already starts with the subject line.
  assert.equal(
    originalMessage({ subject: "subj line", body: "subj line\n\nbody para" }),
    "subj line\n\nbody para",
  );
  // A single-line commit has %B equal to its subject.
  assert.equal(originalMessage({ subject: "only subject", body: "only subject" }), "only subject");
  // An empty %B must still leave something to edit.
  assert.equal(originalMessage({ subject: "fallback", body: "   " }), "fallback");
});

test("takes the prefilled message from the extension rather than rebuilding it in the sandbox", () => {
  const editor = source("src/webviews/rebaseEditor.ts");
  assert.match(editor, /message: originalMessage\(commit\)/);
  assert.match(editor, /original: commit\.message/);
  // Reconstructing subject + body in the Webview is the bug this guards against.
  assert.ok(!/commit\.subject \+ .\\n\\n. \+ commit\.body/.test(editor));
  // A squash offers both messages, the way Git's own squash editor does.
  assert.match(editor, /function prefill\(row, index\)/);
  assert.match(editor, /leader\.message \|\| leader\.original/);
});

test("re-checks the sandbox plan on the extension side before running it", () => {
  const editor = source("src/webviews/rebaseEditor.ts");
  // The Webview must not be able to widen the rewrite: the commit set, the
  // subjects and the plan's validity are all resolved from the repository.
  assert.match(editor, /planCoversSameCommits\(message\.steps, offered\)/);
  assert.match(editor, /subject: subjects\.get\(step\.oid\)/);
  assert.match(editor, /validateRebasePlan\(steps\)/);
  assert.match(editor, /isNoOpPlan\(steps, offered\)/);
});

test("keeps the embedded rebase editor script syntactically valid", () => {
  // This script reached the sandbox unparseable and the sequence editor opened
  // as an empty panel: a plain template literal turned its own `\n` into a real
  // newline, and a real newline inside a single-quoted string does not parse.
  // It was the one Webview here with no syntax check of its own.
  const rebaseEditor = source("src/webviews/rebaseEditor.ts");
  const match = rebaseEditor.match(/function script\(\): string \{[\s\S]*?\n  return String\.raw`([\s\S]*?)`;\n\}/);
  assert.ok(match, "the embedded script has to be present and tagged String.raw");
  assert.doesNotThrow(() => new Function(match[1]));
});

test("embeds every Webview's script and styles as raw templates", () => {
  // The tag is what keeps the text the sandbox runs identical to the text in
  // this repository. A new Webview belongs on this list.
  const required = [
    ["branchComparison.ts", /const comparisonStyles = String\.raw`/],
    ["branchComparison.ts", /const comparisonScript = String\.raw`/],
    ["logPanel.ts", /const logStyles = String\.raw`/],
    ["logPanel.ts", /const logScript = String\.raw`/],
    ["mergeEditor.ts", /const mergeStyles = String\.raw`/],
    ["mergeEditor.ts", /const mergeScript = String\.raw`/],
    ["rebaseEditor.ts", /function styles\(\): string \{[\s\S]*?return String\.raw`/],
    ["rebaseEditor.ts", /function script\(\): string \{[\s\S]*?return String\.raw`/],
  ];
  for (const [file, pattern] of required) {
    assert.match(source(`src/webviews/${file}`), pattern, `${file} must embed that template raw`);
  }
});

test("guards the interactive rebase command and keeps a paused rebase recoverable", () => {
  const extension = source("src/extension.ts");
  const start = extension.indexOf('registerCommand("jbGit.interactiveRebase"');
  assert.ok(start >= 0, "the command has to be registered");
  // Bounded by the next command rather than by a character count, so adding to
  // this one cannot push an assertion out of the window it is checked in.
  const next = extension.indexOf("vscode.commands.registerCommand(", start + 1);
  const command = extension.slice(start, next > start ? next : undefined);
  assert.match(command.slice(0, 400), /requireTrustedWorkspace\(\)/);
  // A rebase that stopped mid-plan must be explained as recoverable rather than
  // reported as a plain command failure.
  assert.match(command, /operation\.kind === "rebase"/);
  assert.match(command, /Continue, or Abort/);
  // Root commits have no parent, so "from here" cannot offer them.
  assert.match(command, /commit\.parents\.length > 0/);
  // IDEA offers to park local changes; Git's own autostash is deliberately not
  // used, because it would restore into a rebase that stopped on a conflict.
  assert.match(command, /"Stash and Rebase"/);
  assert.match(command, /modal: true/);
  assert.match(command, /stashLocalChanges\(manager, root, .*\{ includeUntracked: false \}\)/);
  // Nothing may be stashed until the user actually starts the rebase.
  assert.ok(
    command.indexOf("openRebaseEditor(") < command.indexOf("stashLocalChanges("),
    "the stash has to happen inside the run callback, not before the sequence editor opens",
  );
  // A rebase that stopped mid-plan owns the working tree, so the parked changes
  // stay in the stash rather than being restored on top of a live conflict.
  assert.match(command, /Apply it from Manage Stashes once the rebase is finished or aborted\./);
  assert.match(command, /restoreTemporaryStash\(manager, root, parked\)/);
  // An edit row parks the sequencer with exit code 0, so the success path has
  // to read the operation state: "finished" would be a lie, and restoring the
  // parked stash would drop it onto the commit being amended.
  assert.match(command, /operation\.kind === "rebase"\) \{\s*\n\s*stoppedForEdit = true;/);
  assert.ok(
    command.indexOf('stoppedForEdit = true') < command.indexOf("restoreTemporaryStash("),
    "the edit stop must be detected before the stash restore",
  );
  assert.match(command, /Stopped at the commit marked 'edit'/);

  const manifest = JSON.parse(source("package.json"));
  const declared = manifest.contributes.commands.filter((entry) => entry.command === "jbGit.interactiveRebase");
  assert.equal(declared.length, 1, "the command must appear once in the manifest");
});

test("reorders by drag handle and Alt+arrows, and speaks the user's language", () => {
  const editor = source("src/webviews/rebaseEditor.ts");
  // Only the handle starts a drag: a draggable row would swallow text
  // selection in the subject and the message editor.
  assert.match(editor, /grip\.draggable = true;/);
  assert.match(editor, /grip\.addEventListener\('dragstart'/);
  assert.doesNotMatch(editor, /item\.draggable = true/);
  // Dropping computes the insertion point from the row's midpoint and adjusts
  // for the removal shifting later indices.
  assert.match(editor, /let insertAt = index \+ \(before \? 0 : 1\);/);
  assert.match(editor, /if \(dragIndex < insertAt\) insertAt -= 1;/);
  // Alt+ArrowUp/Down moves from anywhere inside the row, and preventDefault
  // keeps Alt+ArrowDown from opening the action dropdown.
  assert.match(editor, /event\.altKey/);
  assert.match(editor, /move\(index, event\.key === 'ArrowUp' \? -1 : 1\);/);
  // The editor was the one webview with no Chinese at all.
  assert.match(editor, /'Interactive Rebase': '交互式变基'/);
  assert.match(editor, /'Start Rebase': '开始变基'/);
  // Every action explains itself; git's own verbs stay untranslated.
  assert.match(editor, /select\.title = t\(ACTION_HELP\[row\.action\] \|\| ''\)/);
  // A fresh dialog has nothing to do yet; that is a state, not a failure.
  assert.match(editor, /quiet: true/);
  assert.match(editor, /\.problem\.quiet \{ color: var\(--vscode-descriptionForeground\); \}/);
  // Folded rows tuck under the commit they join, and the select is themed.
  assert.match(editor, /li\.folded \{ margin-left: 26px;/);
  assert.match(editor, /\.select-shell select \{[^}]*appearance: none/);
});
