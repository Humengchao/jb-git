import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEdit,
  buildModel,
  ignoreRegion,
  resetRegion,
  resolveRegion,
  textDelta,
  toMarkerText,
  unresolved,
} from "../dist/mergeRegions.js";

const LABELS = { ours: "HEAD", theirs: "branch" };

function conflicted(ours, theirs) {
  return `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> branch\n`;
}

function edit(model, next) {
  return { text: next, regions: applyEdit(model.regions, textDelta(model.text, next)) };
}

/**
 * The one property the rest of the editor is built on: regions are in order,
 * do not overlap, and stay inside the text. `toMarkerText` walks them in order
 * and would duplicate or drop text if any of that stopped holding.
 */
function violations(model) {
  const problems = [];
  let previousEnd = 0;
  model.regions.forEach((region, index) => {
    if (region.start > region.end) problems.push(`region ${index} is inverted`);
    if (region.start < previousEnd) problems.push(`region ${index} overlaps the one before it`);
    if (region.end > model.text.length) problems.push(`region ${index} ends past the text`);
    previousEnd = region.end;
  });
  return problems;
}

test("an edit across two conflicts leaves one region, not two that overlap", () => {
  // Selecting from inside one conflict to inside the next and typing is enough.
  // Growing both separately produced overlapping ranges, and toMarkerText walks
  // the ranges in order, so the saved draft came back with text duplicated.
  const model = buildModel(`${conflicted("AAA\n", "aaa\n")}${conflicted("BBB\n", "bbb\n")}`);
  assert.equal(model.text, "AAA\nBBB\n");
  const typed = edit(model, `${model.text.slice(0, 1)}X${model.text.slice(6)}`);
  assert.deepEqual(violations(typed), []);
  assert.equal(typed.regions.length, 1);
  assert.equal(typed.regions[0].resolution, "manual");
  // Reverting the span has to give back both sides, in order.
  assert.equal(typed.regions[0].ours, "AAA\nBBB\n");
  assert.equal(typed.regions[0].theirs, "aaa\nbbb\n");
  assert.equal(buildModel(toMarkerText(typed, LABELS)).text, typed.text, "the user's text must survive a draft round trip");
});

test("an edit that reaches only one conflict still keeps them apart", () => {
  const model = buildModel(`${conflicted("AAA\n", "aaa\n")}${conflicted("BBB\n", "bbb\n")}`);
  const typed = edit(model, "AZA\nBBB\n");
  assert.equal(typed.regions.length, 2);
  assert.equal(typed.regions[0].resolution, "manual");
  assert.equal(typed.regions[1].resolution, undefined);
  assert.deepEqual(violations(typed), []);
});

test("a merged span only claims a base when every part had one", () => {
  const withBase = `<<<<<<< HEAD\nAAA\n||||||| base\nwas\n=======\naaa\n>>>>>>> branch\n`;
  const both = buildModel(`${withBase}${withBase.replace(/AAA/, "BBB").replace(/was/, "too")}`);
  const merged = edit(both, `${both.text.slice(0, 1)}X${both.text.slice(6)}`);
  assert.equal(merged.regions[0].base, "was\ntoo\n");
  const mixed = buildModel(`${withBase}${conflicted("BBB\n", "bbb\n")}`);
  const partial = edit(mixed, `${mixed.text.slice(0, 1)}X${mixed.text.slice(6)}`);
  assert.equal(partial.regions[0].base, undefined, "half a base is not a base");
});

test("a decision moves the regions after it, not one that shares its start", () => {
  // A conflict that took nothing from our side is a zero-length region. Deciding
  // the next conflict used to shift that one past it, because the two share an
  // offset and the shift was chosen by comparing offsets rather than order.
  const model = buildModel(`${conflicted("", "aaa\n")}${conflicted("BBB\n", "")}`);
  assert.deepEqual(model.regions.map((region) => [region.start, region.end]), [[0, 0], [0, 4]]);
  const applied = resolveRegion(model, 1, "theirs");
  assert.deepEqual(applied.regions.map((region) => [region.start, region.end]), [[0, 0], [0, 0]]);
  const reverted = resetRegion(applied, 1);
  assert.deepEqual(violations(reverted), []);
  assert.deepEqual(reverted.regions.map((region) => [region.start, region.end]), [[0, 0], [0, 4]]);
  assert.equal(reverted.text, "BBB\n");
});

test("a conflict left mid-line still comes back out of the draft", () => {
  // Deleting the line break above a conflict does not touch the conflict, so it
  // stays unresolved — but a `<<<<<<<` that does not start a line is not found
  // again, and the conflict used to vanish from the restored draft.
  const model = buildModel(`head\n${conflicted("mine\n", "yours\n")}`);
  assert.equal(model.text, "head\nmine\n");
  const joined = edit(model, "headmine\n");
  assert.equal(unresolved(joined.regions), 1, "the edit did not reach the conflict, so it is still unresolved");
  const markers = toMarkerText(joined, LABELS);
  assert.match(markers, /^<{7} HEAD$/m, "the marker has to start its own line");
  assert.equal(unresolved(buildModel(markers).regions), 1, "the conflict must survive the round trip");
  assert.equal(buildModel(markers).text, "head\nmine\n");
});

test("writes whole lines even if a side somehow lost its final newline", () => {
  const model = { text: "x", regions: [{ start: 0, end: 1, ours: "x", theirs: "y" }] };
  const markers = toMarkerText(model, LABELS);
  assert.equal(markers, "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> branch\n");
  assert.equal(buildModel(markers).regions.length, 1);
});

test("keeps its invariants across long random sequences of edits and decisions", () => {
  // A merge editor that reorders or overlaps its own ranges loses the user's
  // work quietly, so the property is checked directly rather than only through
  // the handful of sequences someone thought to write down.
  let seed = 1;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const upto = (bound) => Math.floor(random() * bound);
  const pick = (list) => list[upto(list.length)];

  for (let round = 0; round < 1500; round += 1) {
    const parts = [];
    for (let index = 0; index < 1 + upto(3); index += 1) {
      if (random() < 0.6) parts.push(`plain${index}\n`);
      parts.push(conflicted(
        random() < 0.25 ? "" : `ours${index}\n${random() < 0.4 ? `ours${index}b\n` : ""}`,
        random() < 0.25 ? "" : `theirs${index}\n`,
      ));
    }
    if (random() < 0.7) parts.push("tail\n");

    let model = buildModel(parts.join(""));
    assert.deepEqual(violations(model), [], `round ${round}: buildModel`);
    const history = [];
    for (let step = 0; step < 8; step += 1) {
      const action = pick(["edit", "resolve", "ignore", "reset", "edit", "resolve"]);
      if (action === "edit") {
        const at = upto(model.text.length + 1);
        const next = random() < 0.5
          ? model.text.slice(0, at) + pick(["Z", "zz\n", "\n", "  "]) + model.text.slice(at)
          : model.text.slice(0, at) + model.text.slice(Math.min(model.text.length, at + 1 + upto(6)));
        history.push(`edit ${JSON.stringify(next)}`);
        model = edit(model, next);
      } else if (model.regions.length) {
        const index = upto(model.regions.length);
        history.push(`${action} ${index}`);
        if (action === "resolve") model = resolveRegion(model, index, pick(["ours", "theirs", "both"]));
        else if (action === "ignore") model = ignoreRegion(model, index);
        else model = resetRegion(model, index);
      }
      const where = `round ${round} after ${history.join(" | ")}`;
      assert.deepEqual(violations(model), [], where);
      const markers = toMarkerText(model, LABELS);
      const reread = buildModel(markers);
      assert.equal(unresolved(model.regions), reread.regions.length, `${where}: a draft lost or invented a conflict`);
      if (unresolved(model.regions) === 0) {
        assert.equal(reread.text, model.text, `${where}: a settled result did not round trip`);
      }
    }
  }
});
