import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readSource } from "./sourceText.mjs";

const manifestText = readSource("../package.json", import.meta.url);
const manifest = JSON.parse(manifestText);

/** Every file that can hold a `registerCommand` call. */
const COMMAND_SOURCES = [
  "../src/extension.ts",
  "../src/webviews/logPanel.ts",
  "../src/webviews/mergeEditor.ts",
  "../src/webviews/rebaseEditor.ts",
  "../src/webviews/branchComparison.ts",
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

test("declares exactly the commands it registers", () => {
  // A command in the manifest with no handler shows up in the palette and does
  // nothing; a handler with no manifest entry cannot be reached from a menu.
  const source = COMMAND_SOURCES.map((file) => readSource(file, import.meta.url)).join("\n");
  const registered = new Set([...source.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((match) => match[1]));
  const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
  assert.deepEqual([...registered].filter((command) => !declared.has(command)), [], "registered but not declared");
  assert.deepEqual([...declared].filter((command) => !registered.has(command)), [], "declared but not registered");
});

test("puts only declared commands in menus", () => {
  const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
  const inMenus = new Set(Object.values(manifest.contributes.menus).flat().map((entry) => entry.command).filter(Boolean));
  assert.deepEqual([...inMenus].filter((command) => !declared.has(command)), []);
});

test("resolves every translated string in both bundles", () => {
  // A `%key%` with no entry renders as the literal `%key%` in the UI, and a key
  // that only one bundle has silently falls back to English for the other.
  const english = readJson("../package.nls.json");
  const chinese = readJson("../package.nls.zh-cn.json");
  const used = [...new Set([...manifestText.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]))];
  assert.ok(used.length > 0);
  assert.deepEqual(used.filter((key) => !(key in english)), [], "used in the manifest but missing from package.nls.json");
  assert.deepEqual(Object.keys(english).filter((key) => !used.includes(key)), [], "declared but never used");
  assert.deepEqual(Object.keys(english).filter((key) => !(key in chinese)), [], "missing from package.nls.zh-cn.json");
  assert.deepEqual(Object.keys(chinese).filter((key) => !(key in english)), [], "only in package.nls.zh-cn.json");
});

test("gives every configuration property a described default", () => {
  for (const [name, property] of Object.entries(manifest.contributes.configuration.properties)) {
    assert.ok("default" in property, `${name} needs a default`);
    assert.match(property.description, /^%.+%$/, `${name} should describe itself through the translation bundle`);
  }
});

test("contributes the annotation commands IDEA's Blame gutter offers", () => {
  const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const command of [
    "jbGit.toggleBlameAnnotations",
    "jbGit.annotatePreviousRevision",
    "jbGit.copyRevisionNumber",
    "jbGit.blameShowCommit",
  ]) {
    assert.ok(declared.has(command), `${command} should be contributed`);
  }
  const extension = readSource("../src/extension.ts", import.meta.url);
  // The hover links pass their own line; the palette falls back to the caret.
  assert.match(extension, /const blameLocation = \(argument\?: BlameLineArgument\)/);
  assert.match(extension, /editor\.selection\.active\.line/);
  // A commit older than the Log's window must not silently select another one.
  assert.match(extension, /if \(await gitToolWindow\.revealCommit\(found\.target\.repositoryRoot, found\.entry\.hash\)\) return;/);
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  assert.match(panel, /public async revealCommit\(root: string, hash: string\): Promise<boolean>/);
  assert.match(panel, /return this\.currentCommits\.some\(\(commit\) => commit\.hash === hash\);/);
});

test("annotates through decorations that survive a dirty buffer", () => {
  const controller = readSource("../src/views/blameDecorations.ts", import.meta.url);
  // Blaming what is on disk while the editor holds something else slides the
  // annotation out of step with the lines the user is reading.
  assert.match(controller, /target\.revision \|\| document\.isDirty \? document\.getText\(\) : undefined/);
  // Running Git per keystroke is what the debounce is for.
  assert.match(controller, /RECOMPUTE_DEBOUNCE_MS/);
  assert.match(controller, /clearTimeout/);
  // A reply that lands after the annotation was turned off must not repaint it.
  assert.match(controller, /if \(this\.disposed \|\| !this\.targets\.has\(key\)\) return;/);
  // Decorations, editor registrations and timers all have to be released.
  assert.match(controller, /public dispose\(\): void \{[\s\S]*?this\.decoration\.dispose\(\);/);
  // A decoration is painted through CSS `content`, which collapses a run of
  // ordinary spaces and gives an empty string no width, so the padding that
  // aligns the columns has to survive as no-break spaces.
  assert.match(controller, /contentText: nonBreaking\(line\.text\)/);
  assert.match(controller, /return text\.replace\(\/ \/g, "\\u00a0"\);/);
  const extension = readSource("../src/extension.ts", import.meta.url);
  assert.match(extension, /blameAnnotations,/, "the controller belongs to the extension's subscriptions");
  assert.match(extension, /blameAnnotations\.refresh\(\);/, "a commit or checkout changes who each line belongs to");
});
