import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { basesForConflicts, parseDiff3 } from "../dist/mergeAnalysis.js";
import { buildModel, resetRegion, resolveRegion, toMarkerText } from "../dist/mergeRegions.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { readSource } from "./sourceText.mjs";

function twoWay(ours, theirs) {
  return `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> branch\n`;
}

function diff3(ours, base, theirs) {
  return `<<<<<<< HEAD\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> branch\n`;
}

test("keeps the base of a diff3 conflict instead of throwing it away", () => {
  const model = buildModel(`head\n${diff3("mine\n", "was\n", "yours\n")}tail\n`);
  // The base section must not leak into the text the user edits.
  assert.equal(model.text, "head\nmine\ntail\n");
  assert.equal(model.regions.length, 1);
  assert.equal(model.regions[0].ours, "mine\n");
  assert.equal(model.regions[0].theirs, "yours\n");
  assert.equal(model.regions[0].base, "was\n");
});

test("leaves the base undefined for a two-way conflict that never carried one", () => {
  const [region] = buildModel(twoWay("mine\n", "yours\n")).regions;
  assert.equal(region.base, undefined);
  assert.equal("base" in region, false, "an absent base must not appear as an explicit undefined");
});

test("reads an empty base section as an empty base, not a missing one", () => {
  // Both sides added something where the base had nothing; that is a real base
  // and the editor should say so rather than offering nothing.
  const [region] = buildModel(diff3("mine\n", "", "yours\n")).regions;
  assert.equal(region.base, "");
});

test("a decision does not lose the base, and reverting brings it back unchanged", () => {
  const model = buildModel(diff3("mine\n", "was\n", "yours\n"));
  const applied = resolveRegion(model, 0, "theirs");
  assert.equal(applied.regions[0].base, "was\n", "the base survives applying a side");
  const reverted = resetRegion(applied, 0);
  assert.equal(reverted.regions[0].base, "was\n", "the base is not a decision, so revert keeps it");
  assert.equal(reverted.regions[0].resolution, undefined);
});

test("writes two-way markers back even when the region knows its base", () => {
  // The working-tree file has to stay in the form every other Git tool parses.
  const model = buildModel(diff3("mine\n", "was\n", "yours\n"));
  const text = toMarkerText(model, { ours: "HEAD", theirs: "branch" });
  assert.equal(text, twoWay("mine\n", "yours\n"));
  assert.doesNotMatch(text, /\|{7}/);
});

test("pairs each replayed base with the conflict it belongs to", () => {
  const regions = buildModel(`a\n${twoWay("mine\n", "yours\n")}b\n${twoWay("x\n", "y\n")}c\n`).regions;
  const blocks = parseDiff3(`a\n${diff3("mine\n", "was\n", "yours\n")}b\n${diff3("x\n", "z\n", "y\n")}c\n`).blocks;
  assert.deepEqual(basesForConflicts(regions, blocks), ["was\n", "z\n"]);
});

test("refuses the pairing when the replay framed the conflicts differently", () => {
  // Git's merge strategy can match lines the plain three-way replay does not,
  // so the two can disagree about where a conflict starts. Labelling a block
  // with another block's history would be worse than showing no base at all.
  const regions = buildModel(`a\n${twoWay("mine\n", "yours\n")}b\n${twoWay("x\n", "y\n")}c\n`).regions;
  const fewer = parseDiff3(`a\n${diff3("mine\n", "was\n", "yours\n")}c\n`).blocks;
  assert.equal(basesForConflicts(regions, fewer), undefined, "a different conflict count must not be paired");
  const different = parseDiff3(`a\n${diff3("mine\n", "was\n", "yours\n")}b\n${diff3("x\n", "z\n", "DIFFERENT\n")}c\n`).blocks;
  assert.equal(basesForConflicts(regions, different), undefined, "a side that does not match must not be paired");
  // A file with no conflicts left pairs trivially rather than being refused.
  assert.deepEqual(basesForConflicts([], []), []);
});

test("ignores the text blocks between conflicts when pairing", () => {
  const regions = buildModel(twoWay("mine\n", "yours\n")).regions;
  const blocks = parseDiff3(`lots\nof\nplain\ntext\n${diff3("mine\n", "was\n", "yours\n")}more\ntext\n`).blocks;
  assert.ok(blocks.filter((block) => block.kind === "text").length > 0);
  assert.deepEqual(basesForConflicts(regions, blocks), ["was\n"]);
});

test("shows the base only for the change you are on, and only when there is one", () => {
  const source = readSource("../src/webviews/mergeEditor.ts", import.meta.url);
  const script = source.slice(source.indexOf("const mergeScript = String.raw"));
  // The toolbar toggle is offered only where a base actually exists.
  assert.match(script, /showBaseButton\.disabled = currentBase\(\) === undefined \|\| applying;/);
  assert.match(script, /function renderBaseFrame\(lineHeight, changeTop\)/);
  // A frame parked at the edge after its change scrolled away would look like
  // it belonged to whatever line is there instead.
  assert.match(script, /if \(changeTop < -lineHeight \|\| changeTop > available\) \{ baseFrame\.hidden = true; return; \}/);
  // Above the change when it fits, below it when it does not.
  assert.match(script, /const above = changeTop - height - 3;/);
  assert.match(script, /baseFrame\.style\.top = String\(Math\.round\(above >= 0 \? above : below\)\)/);
  // Every user-visible string goes through the translator.
  assert.match(script, /mt\('\(this block is not in the base\)'\)/);
  assert.match(script, /'Base': '基线'/);
  // A protocol that ever drifts must leave the editor with no base, not a shifted one.
  assert.match(script, /if \(!Array\.isArray\(bases\) \|\| bases\.length !== built\.regions\.length\) return built;/);
});

test("hands the editor a base only when the replay can be trusted", () => {
  const source = readSource("../src/webviews/mergeEditor.ts", import.meta.url);
  const method = source.slice(source.indexOf("private async conflictBases("));
  assert.match(method.slice(0, 900), /basesForConflicts\(regions, await this\.manager\.conflictAnalysis\(rootPath, pathSpec\)\)/);
  // A binary conflict cannot be analysed line by line; that must not stop the
  // editor from opening.
  assert.match(method.slice(0, 900), /catch \{/);
  assert.match(method.slice(0, 900), /return undefined;/);
  // The bases have to line up with what is displayed, which is the draft when
  // one was restored — not the file Git left behind.
  assert.match(source, /const bases = await this\.conflictBases\(rootPath, pathSpec, displayedVersions\.result\);/);
});

test("compares any two of the four versions through a native read-only diff", () => {
  const source = readSource("../src/webviews/mergeEditor.ts", import.meta.url);
  const method = source.slice(source.indexOf("private async compareVersions("));
  // All six pairings of Left/Base/Result/Right.
  assert.match(method.slice(0, 2600), /\["base", "result"\], \["left", "result"\], \["result", "right"\],/);
  assert.match(method.slice(0, 2600), /\["left", "right"\], \["base", "left"\], \["base", "right"\],/);
  // An add/add conflict has no common ancestor, and diffing against nothing
  // says nothing.
  assert.match(method.slice(0, 2600), /\(left !== "base" && right !== "base"\) \|\| versions\.baseExists/);
  // An untitled document opens dirty, which is what diffSide exists to avoid.
  assert.match(method.slice(0, 2600), /diffSide\(this\.diffProvider,/);
  assert.doesNotMatch(method.slice(0, 2600), /openTextDocument\(\{\s*content/);
  // The result is the one version the host does not have.
  const script = source.slice(source.indexOf("const mergeScript = String.raw"));
  assert.match(script, /vscode\.postMessage\(\{ type: 'compare', result: model\.text \}\)/);
  assert.match(script, /'Compare…': '比较…'/);
});

test("validates a compare message at the extension-host boundary", async () => {
  const { isMergeEditorMessage } = await import("../dist/webviews/mergeEditorProtocol.js");
  assert.equal(isMergeEditorMessage({ type: "compare", result: "text" }), true);
  assert.equal(isMergeEditorMessage({ type: "compare" }), false);
  assert.equal(isMergeEditorMessage({ type: "compare", result: 5 }), false);
});

test("reads the base of a real Git conflict through the editor's own path", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-merge-base-"));
  const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("config", "user.name", "JB Git Test");
  git("config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "f.txt"), "top\nBASE LINE\nbottom\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const main = git("branch", "--show-current").trim();
  git("checkout", "-qb", "side");
  writeFileSync(join(root, "f.txt"), "top\nTHEIR LINE\nbottom\n");
  git("add", ".");
  git("commit", "-qm", "theirs");
  git("checkout", "-q", main);
  writeFileSync(join(root, "f.txt"), "top\nOUR LINE\nbottom\n");
  git("add", ".");
  git("commit", "-qm", "ours");
  try {
    git("merge", "side");
  } catch {
    // A conflict is the point of the fixture.
  }

  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);
  const versions = await repository.conflictVersions("f.txt");
  const { regions } = buildModel(versions.result);
  assert.equal(regions.length, 1);
  const bases = basesForConflicts(regions, await repository.conflictAnalysis("f.txt"));
  assert.deepEqual(bases, ["BASE LINE\n"], "the block's base is what both sides started from");
});
