import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const PANELS = [
  ["../src/webviews/mergeEditor.ts", "jbGit.mergeConflictEditor"],
  ["../src/webviews/rebaseEditor.ts", "jbGit.rebaseEditor"],
  ["../src/webviews/branchComparison.ts", "jbGit.branchComparison"],
];

test("JB Git's own editors do not open among the user's source tabs", () => {
  // They are IDEA's dialogs, not files. Opened in the active group they
  // interleave with code: a conflict editor landed between README.md and
  // app.js and stayed in that tab strip for the rest of the session.
  for (const [file, viewType] of PANELS) {
    const source = readSource(file, import.meta.url);
    // The column may be resolved into a local just above the call, so the
    // window covers both sides of it.
    const at = source.indexOf(`"${viewType}"`);
    const creation = source.slice(Math.max(0, at - 300), at + 400);
    assert.match(creation, /toolEditorColumn\(\)/, `${file} must ask where JB Git editors belong`);
    assert.doesNotMatch(creation, /vscode\.ViewColumn\.Active/, `${file} must not force the active group`);
    assert.match(source, /registerToolPanel\(panel\)/, `${file} must register its panel so the next editor joins it`);
  }
});

test("the column helper keeps every JB Git editor in one group", () => {
  const html = readSource("../src/webviews/html.ts", import.meta.url);
  // Beside is relative to the focused group, so opening a second editor while
  // the first has focus would keep pushing new columns onto the screen.
  assert.match(html, /for \(const panel of liveToolPanels\) \{\s*\n\s*if \(panel\.viewColumn !== undefined\) return panel\.viewColumn;/);
  assert.match(html, /return vscode\.ViewColumn\.Beside;/);
  // A closed editor must not keep a stale column alive.
  assert.match(html, /panel\.onDidDispose\(\(\) => liveToolPanels\.delete\(panel\)\);/);
  // The escape hatch for anyone who wants the old behaviour.
  assert.match(html, /get<string>\("toolEditorLocation", "beside"\) === "active"/);
});

test("the manifest offers the location setting in both languages", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const setting = manifest.contributes.configuration.properties["jbGit.toolEditorLocation"];
  assert.deepEqual(setting.enum, ["beside", "active"]);
  assert.equal(setting.default, "beside");
  for (const bundle of ["../package.nls.json", "../package.nls.zh-cn.json"]) {
    const strings = JSON.parse(readFileSync(new URL(bundle, import.meta.url), "utf8"));
    for (const key of ["configuration.toolEditorLocation", "configuration.toolEditorLocation.beside", "configuration.toolEditorLocation.active"]) {
      assert.ok(strings[key], `${bundle} is missing ${key}`);
    }
  }
});
