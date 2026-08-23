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
  assert.match(scriptMatch[1], /connector-' \+ geom\.state/);
  assert.match(scriptMatch[1], /fromLeft \? '»' : '«'/);
  assert.match(scriptMatch[1], /Ignore this change and keep the result text/);
  // Applying the second side of a conflict keeps both, the way IDEA resolves it.
  assert.match(scriptMatch[1], /both \? 'both' : \(fromLeft \? 'ours' : 'theirs'\)/);
  assert.match(source, /\.connector-conflict/);
  assert.match(source, /\.band-applied/);
});

test("labels rebase conflict sides by replay semantics instead of generic ours and theirs", () => {
  assert.match(source, /operation === "rebase"/);
  assert.match(source, /Rebase Target/);
  assert.match(source, /Replayed Commit/);
  assert.match(source, /stopped-sha/);
  assert.match(source, /original-commit/);
});
