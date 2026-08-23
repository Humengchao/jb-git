import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEdit,
  buildModel,
  ignoreRegion,
  resolveRegion,
  textDelta,
  toMarkerText,
  unresolved,
} from "../dist/mergeRegions.js";

const LABELS = { ours: "HEAD", theirs: "branch" };

function conflicted(ours, theirs) {
  return `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> branch\n`;
}

test("strips markers and keeps each conflict as a range", () => {
  const model = buildModel(`head\n${conflicted("mine\n", "yours\n")}tail\n`);
  assert.equal(model.text, "head\nmine\ntail\n");
  assert.equal(model.regions.length, 1);
  const [region] = model.regions;
  // The range covers exactly the text shown for the conflict.
  assert.equal(model.text.slice(region.start, region.end), "mine\n");
  assert.equal(region.ours, "mine\n");
  assert.equal(region.theirs, "yours\n");
  assert.equal(region.resolution, undefined);
  assert.equal(unresolved(model.regions), 1);
});

test("keeps two conflicts independent", () => {
  const model = buildModel(`a\n${conflicted("m1\n", "t1\n")}b\n${conflicted("m2\n", "t2\n")}c\n`);
  assert.equal(model.text, "a\nm1\nb\nm2\nc\n");
  assert.equal(model.regions.length, 2);
  assert.equal(model.text.slice(model.regions[1].start, model.regions[1].end), "m2\n");
});

test("reads the ours side of a diff3 conflict without swallowing the base", () => {
  const model = buildModel("x\n<<<<<<< HEAD\nmine\n||||||| base\norig\n=======\nyours\n>>>>>>> branch\ny\n");
  assert.equal(model.text, "x\nmine\ny\n");
  assert.equal(model.regions[0].ours, "mine\n");
  assert.equal(model.regions[0].theirs, "yours\n");
});

test("leaves a malformed conflict as literal text", () => {
  const broken = "<<<<<<< HEAD\nmine\n";
  assert.deepEqual(buildModel(broken), { text: broken, regions: [] });
});

test("reduces any edit to one replaced range", () => {
  assert.deepEqual(textDelta("abcd", "abXd"), { start: 2, oldEnd: 3, newEnd: 3 });
  assert.deepEqual(textDelta("abcd", "abcd"), { start: 4, oldEnd: 4, newEnd: 4 });
  // Insertion and deletion are the same shape with an empty side.
  assert.deepEqual(textDelta("ad", "abcd"), { start: 1, oldEnd: 1, newEnd: 3 });
  assert.deepEqual(textDelta("abcd", "ad"), { start: 1, oldEnd: 3, newEnd: 1 });
});

test("moves a region when text before it changes", () => {
  const model = buildModel(`head\n${conflicted("mine\n", "yours\n")}`);
  const after = `header!\n${"mine\n"}`;
  const moved = applyEdit(model.regions, textDelta(model.text, after));
  assert.equal(after.slice(moved[0].start, moved[0].end), "mine\n");
  assert.equal(moved[0].resolution, undefined, "an edit elsewhere must not resolve it");
});

test("leaves a region alone when text after it changes", () => {
  const model = buildModel(`${conflicted("mine\n", "yours\n")}tail\n`);
  const after = "mine\ntail changed\n";
  const moved = applyEdit(model.regions, textDelta(model.text, after));
  assert.deepEqual(
    { start: moved[0].start, end: moved[0].end },
    { start: model.regions[0].start, end: model.regions[0].end },
  );
});

test("treats an edit inside a conflict as the user taking it over", () => {
  const model = buildModel(`head\n${conflicted("mine\n", "yours\n")}tail\n`);
  const after = "head\nmy own answer\ntail\n";
  const moved = applyEdit(model.regions, textDelta(model.text, after));
  // The tool must stop calling it unresolved, and must never later overwrite it.
  assert.equal(moved[0].resolution, "manual");
  assert.equal(unresolved(moved), 0);
  assert.equal(after.slice(moved[0].start, moved[0].end), "my own answer\n");
});

test("applies a side and moves the conflicts that follow", () => {
  const model = buildModel(`a\n${conflicted("m1\n", "t1\n")}b\n${conflicted("m2\n", "t2\n")}c\n`);
  const resolved = resolveRegion(model, 0, "theirs");
  assert.equal(resolved.text, "a\nt1\nb\nm2\nc\n");
  assert.equal(resolved.regions[0].resolution, "theirs");
  // The second conflict still points at its own text after the first one changed length.
  assert.equal(resolved.text.slice(resolved.regions[1].start, resolved.regions[1].end), "m2\n");
  assert.equal(unresolved(resolved.regions), 1);
});

test("keeps both sides in order when asked", () => {
  const model = buildModel(conflicted("mine\n", "yours\n"));
  assert.equal(resolveRegion(model, 0, "both").text, "mine\nyours\n");
  // Git always puts a divider on its own line, so a section that does not end
  // in a newline is not a conflict at all and must stay literal text.
  const ragged = "<<<<<<< HEAD\nmine=======\nyours\n>>>>>>> branch\n";
  assert.deepEqual(buildModel(ragged), { text: ragged, regions: [] });
});

test("applying a side twice ends on the last choice", () => {
  const model = buildModel(conflicted("mine\n", "yours\n"));
  const once = resolveRegion(model, 0, "theirs");
  const twice = resolveRegion(once, 0, "ours");
  assert.equal(twice.text, "mine\n");
  assert.equal(twice.regions[0].resolution, "ours");
});

test("ignoring a change keeps the text and stops counting it", () => {
  const model = buildModel(`head\n${conflicted("mine\n", "yours\n")}tail\n`);
  const ignored = ignoreRegion(model, 0);
  assert.equal(ignored.text, model.text);
  assert.equal(ignored.regions[0].resolution, "ignored");
  assert.equal(unresolved(ignored.regions), 0);
  // The ignored region is settled, so a draft no longer carries markers for it.
  assert.equal(toMarkerText(ignored, LABELS), "head\nmine\ntail\n");
  // Ignore answers an open question only; a handled region keeps its resolution.
  const applied = resolveRegion(model, 0, "theirs");
  assert.equal(ignoreRegion(applied, 0), applied);
});

test("rebuilds marker text for a result that still has conflicts", () => {
  const original = `head\n${conflicted("mine\n", "yours\n")}tail\n`;
  const model = buildModel(original);
  // An untouched conflict round-trips, so a draft can be stored the way Git wrote it.
  assert.equal(toMarkerText(model, LABELS), original);
  const resolved = resolveRegion(model, 0, "theirs");
  assert.equal(toMarkerText(resolved, LABELS), "head\nyours\ntail\n");
});
