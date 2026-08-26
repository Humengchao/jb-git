import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const source = readSource("../src/webviews/mergeEditor.ts", import.meta.url);
const scriptMatch = source.match(/const mergeScript = String\.raw`([\s\S]*?)`;\r?\n$/);

test("keeps the embedded merge editor script syntactically valid", () => {
  assert.ok(scriptMatch, "embedded merge editor script should be present");
  assert.doesNotThrow(() => new Function(scriptMatch[1]));
});

test("the injected module wrapper evaluates to a working MergeRegions global", () => {
  // Mirrors the wrapper mergeRegionsScript() builds around the compiled module.
  const compiled = readFileSync(new URL("../dist/mergeRegions.js", import.meta.url), "utf8");
  const wrapped = `const MergeRegions = (() => { const exports = {}; ${compiled}\n;return exports; })();\n`;
  const regions = new Function(`${wrapped}return MergeRegions;`)();
  const model = regions.buildModel("a\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> branch\nb\n");
  assert.equal(model.text, "a\nmine\nb\n");
  assert.equal(regions.unresolved(model.regions), 1);
});

test("shares the tested region model with the sandboxed script instead of a copy", () => {
  // The Webview cannot import modules, so the compiled mergeRegions build is
  // injected as a global and every result mutation must go through it; a
  // hand-written second implementation is exactly what could drift and lose work.
  assert.match(source, /require\.resolve\("\.\.\/mergeRegions"\)/);
  assert.match(source, /const MergeRegions = \(\(\) => \{ const exports = \{\};/);
  assert.match(scriptMatch[1], /MergeRegions\.buildModel/);
  assert.match(scriptMatch[1], /MergeRegions\.applyEdit\(model\.regions, MergeRegions\.textDelta/);
  assert.match(scriptMatch[1], /MergeRegions\.resolveRegion/);
  assert.match(scriptMatch[1], /MergeRegions\.ignoreRegion/);
  assert.match(scriptMatch[1], /MergeRegions\.resetRegion/);
  assert.match(scriptMatch[1], /MergeRegions\.unresolved/);
  // Drafts round-trip through the marker form so recovery keeps working.
  assert.match(scriptMatch[1], /MergeRegions\.toMarkerText\(model, markerLabels\)/);
  assert.match(scriptMatch[1], /result: serializeResult\(\), deleted: resultDeleted/);
});

test("provides editable three-pane conflict controls and a staged Apply flow", () => {
  assert.match(source, /class MergeConflictEditor/);
  assert.match(source, /conflictVersions/);
  assert.match(source, /applyConflictResult/);
  assert.match(scriptMatch[1], /Accept Left/);
  assert.match(scriptMatch[1], /Accept Right/);
  assert.match(scriptMatch[1], /take-both/);
  // Apply hands over the clean text: the displayed result never carries markers.
  assert.match(scriptMatch[1], /vscode\.postMessage\(\{ type: 'apply', result: model\.text, deleted: resultDeleted }\)/);
  assert.match(scriptMatch[1], /querySelectorAll\('\.splitter'\)/);
  assert.match(source, /MERGE_DRAFTS_KEY/);
  assert.match(source, /conflictFingerprint/);
  assert.match(source, /changed outside this editor/);
  assert.match(scriptMatch[1], /type: 'dirty'/);
  assert.match(scriptMatch[1], /sourceLineHeight/);
  assert.match(scriptMatch[1], /updateHighlight/);
  assert.match(scriptMatch[1], /alignmentAnchors/);
  assert.match(scriptMatch[1], /setTimeout\(send, 300\)/);
  assert.match(source, /MAX_MERGE_DRAFT_BYTES/);
  assert.match(source, /MAX_MERGE_DRAFTS/);
  assert.match(source, /onDidReceiveMessage\(async \(message: unknown\)/);
  assert.match(source, /isMergeEditorMessage\(message\)/);
});

test("offers IDEA-style per-change gutter actions and pane connectors", () => {
  // Each change gets an arrow that applies its side and a × that ignores it,
  // anchored on coloured shapes joining the side chunk to the result region.
  assert.match(scriptMatch[1], /rebuildStripButtons/);
  assert.match(scriptMatch[1], /chunk-action/);
  assert.match(scriptMatch[1], /'<polygon class="connector state-' \+ geom\.state/);
  assert.match(scriptMatch[1], /fromLeft \? 'apply-right' : 'apply-left'/);
  assert.match(scriptMatch[1], /Ignore this change and keep the result text/);
  // Stroked icons, not text glyphs, so the gutter keeps one weight in every theme.
  assert.match(scriptMatch[1], /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'path'\)/);
  // Applying one side must not strand the other: the outer slot always holds an
  // action, × while the change is open and revert once it is settled.
  assert.match(scriptMatch[1], /region\.resolution === undefined\r?\n\s*\? chunkAction\(index, 'ignore'/);
  assert.match(scriptMatch[1], /chunkAction\(index, 'revert', 'revert', far/);
  assert.match(source, /\.chunk-action\.revert/);
  // A descendant selector here would stretch the icon inside every button.
  assert.match(source, /\.splitter > svg \{/);
  // Applying the second side of a conflict keeps both, the way IDEA resolves it.
  assert.match(scriptMatch[1], /both \? 'both' : \(fromLeft \? 'ours' : 'theirs'\)/);
  assert.match(source, /\.state-conflict \{ --state: var\(--merge-conflict\); }/);
  assert.match(source, /\.state-applied \{ --state: var\(--merge-applied\); }/);
});

test("marks the change you are on in whatever state it is already in", () => {
  // Resolving a change must not make it stop being the current one: IDEA keeps
  // the current change emphasised after it turns green, grey or blue.
  assert.match(scriptMatch[1], /function regionState\(region\) \{/);
  assert.match(scriptMatch[1], /position === currentConflict \? ' is-current' : ''/);
  assert.match(scriptMatch[1], /index === currentConflict \? ' is-current' : ''/);
  assert.match(source, /\.band\.is-current \{ --alpha: 27%; }/);
  assert.match(source, /\.connector\.is-current \{/);
});

test("paints only the visible slice of each pane", () => {
  // Highlighting the whole file cost ~115ms of every keystroke on a 3,000-line
  // merge; the layer renders a window and is translated into place instead.
  assert.match(scriptMatch[1], /function highlightWindow\(index\)/);
  assert.match(scriptMatch[1], /HIGHLIGHT_MARGIN/);
  assert.match(scriptMatch[1], /function positionHighlight\(index\)/);
  assert.match(scriptMatch[1], /function highlightStale\(index\)/);
  // Scrolling repaints only once the window is nearly used up.
  assert.match(scriptMatch[1], /scheduleHighlights\(\);/);
  assert.match(scriptMatch[1], /view\.first \* lineHeightOf\(index\)/);
});

test("keeps the change an action moved to on screen, and closes on Escape", () => {
  // Applying a side used to leave the next change off screen with no feedback:
  // the counter dropped but nothing moved.
  assert.match(scriptMatch[1], /function showCurrent\(mode\)/);
  assert.match(scriptMatch[1], /if \(mode === 'reveal' && line >= top \+ 1 && line <= bottom - 2\) return;/);
  assert.match(scriptMatch[1], /updateControls\('reveal'\)/);
  assert.match(scriptMatch[1], /updateControls\('jump'\)/);
  assert.match(scriptMatch[1], /event\.key === 'Escape'/);
  // 1/2/3 resolve the current change, but never while typing in the result.
  assert.match(scriptMatch[1], /\['1', '2', '3'\]\.includes\(event\.key\)/);
  assert.match(scriptMatch[1], /document\.activeElement !== result && model\.regions\.length/);
  // Every user-visible string goes through the translator.
  assert.match(scriptMatch[1], /mt\(' · draft restored'\)/);
  assert.match(scriptMatch[1], /mt\('Could not apply the merge result'\)/);
});

test("undoes any decision or typing burst as one step", () => {
  // Assigning textarea.value discards the control's native history, so after a
  // gutter or toolbar action Ctrl+Z silently did nothing at all. The model
  // keeps its own stacks; every mutation source pushes exactly one step.
  assert.match(scriptMatch[1], /function undoStep\(\)/);
  assert.match(scriptMatch[1], /function redoStep\(\)/);
  // resolveAs, ignoreAt, resetAt, Reset, Accept Left, Accept Right.
  assert.equal(scriptMatch[1].match(/pushUndo\(captureState\(\)\);/g)?.length, 6);
  // The first keystroke of a burst pushes the pre-burst state once…
  assert.match(scriptMatch[1], /if \(!typingRun\) \{ pushUndo\(\{ text: previous, regions: model\.regions, deleted: resultDeleted \}\); typingRun = true; \}/);
  // …and a draft send closes the burst so the next pause starts a new step.
  assert.match(scriptMatch[1], /typingRun = false; vscode\.postMessage\(\{ type: 'dirty'/);
  // Native undo gestures are intercepted wherever they come from.
  assert.match(scriptMatch[1], /event\.inputType === 'historyUndo'/);
  assert.match(scriptMatch[1], /event\.key === 'z' \|\| event\.key === 'Z'/);
  assert.match(scriptMatch[1], /event\.shiftKey\) redoStep\(\); else undoStep\(\);/);
});

test("draws a conflict that took nothing from our side as a deletion mark", () => {
  // A zero-length region has no text to shade, so it was invisible in the
  // result even while it was the current change.
  assert.match(scriptMatch[1], /if \(band\.start === band\.end\) \{/);
  assert.match(scriptMatch[1], /band\.className \+ ' band-empty'/);
  assert.match(source, /\.band-empty::after \{[^}]*border-top: 2px solid/);
  assert.match(source, /\.band-empty\.is-current::after \{/);
  // The result keeps its zero-length bands instead of filtering them away.
  assert.doesNotMatch(scriptMatch[1], /filter\(\(band\) => band\.end > band\.start\)/);
});

test("keeps the wheel scrolling over the strips between the panes", () => {
  assert.match(scriptMatch[1], /splitter\.addEventListener\('wheel'/);
  assert.match(scriptMatch[1], /event\.deltaMode === 1 \? event\.deltaY \* lineHeightOf\(1\) : event\.deltaY/);
});

test("shows every change on a marker strip that jumps to it", () => {
  // IDEA's strip: a long merge shows where the work is left without scrolling.
  assert.match(scriptMatch[1], /function renderRuler\(\)/);
  assert.match(scriptMatch[1], /'ruler-mark state-' \+ geom\.state/);
  assert.match(scriptMatch[1], /ruler\.addEventListener\('click'/);
  assert.match(source, /\.pane\.result \.code-shell \{ grid-template-columns: 48px minmax\(0, 1fr\) 12px; }/);
});

test("every webview declares the colour scheme it is painted in", () => {
  // Without this Chromium paints light scrollbars and form controls over a dark
  // theme; the merge and rebase editors were the two that had not said so.
  for (const name of ["mergeEditor", "rebaseEditor", "logPanel", "branchComparison"]) {
    assert.match(
      readSource(`../src/webviews/${name}.ts`, import.meta.url),
      /color-scheme: light dark;/,
      `${name} should declare its colour scheme`,
    );
  }
});

test("labels rebase conflict sides by replay semantics instead of generic ours and theirs", () => {
  assert.match(source, /operation === "rebase"/);
  assert.match(source, /Rebase Target/);
  assert.match(source, /Replayed Commit/);
  assert.match(source, /stopped-sha/);
  assert.match(source, /original-commit/);
});
