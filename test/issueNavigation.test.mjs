import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileIssueRules, linkifyIssues, safeIssueUrl } from "../dist/issueNavigation.js";
import { panelScript, readSource } from "./sourceText.mjs";

const JIRA = { pattern: "[A-Z][A-Z0-9]+-\\d+", url: "https://tracker.example.com/browse/$0" };

test("links the configured issue ids and leaves the rest of the text alone", () => {
  const rules = compileIssueRules([JIRA]);
  assert.deepEqual(linkifyIssues("Fix ABC-123 and DEF-9 in the parser", rules), [
    { text: "Fix " },
    { text: "ABC-123", url: "https://tracker.example.com/browse/ABC-123" },
    { text: " and " },
    { text: "DEF-9", url: "https://tracker.example.com/browse/DEF-9" },
    { text: " in the parser" },
  ]);
  assert.deepEqual(linkifyIssues("no ids here", rules), [{ text: "no ids here" }]);
  assert.deepEqual(linkifyIssues("", rules), []);
});

test("substitutes capture groups into the target", () => {
  const rules = compileIssueRules([{ pattern: "#(\\d+)", url: "https://github.com/o/r/issues/$1" }]);
  assert.deepEqual(linkifyIssues("see #42", rules), [
    { text: "see " },
    { text: "#42", url: "https://github.com/o/r/issues/42" },
  ]);
});

test("a broken rule costs that rule, not the feature", () => {
  const rules = compileIssueRules([
    { pattern: "[unclosed", url: "https://x/$0" },
    JIRA,
    { pattern: "", url: "https://x/$0" },
    { pattern: "a*", url: "https://x/$0" },
    "not an object",
    { pattern: 42, url: "https://x/$0" },
  ]);
  // The malformed pattern, the empty one, the one matching the empty string
  // (which would loop forever) and the non-objects are all dropped.
  assert.equal(rules.length, 1);
  assert.equal(linkifyIssues("ABC-1", rules)[0].url, "https://tracker.example.com/browse/ABC-1");
});

test("an earlier rule wins overlapping text, so ordering is predictable", () => {
  const rules = compileIssueRules([
    { pattern: "SPECIAL-\\d+", url: "https://special/$0" },
    { pattern: "[A-Z]+-\\d+", url: "https://generic/$0" },
  ]);
  assert.deepEqual(linkifyIssues("SPECIAL-7 OTHER-8", rules), [
    { text: "SPECIAL-7", url: "https://special/SPECIAL-7" },
    { text: " " },
    { text: "OTHER-8", url: "https://generic/OTHER-8" },
  ]);
});

test("zero-width patterns never hang or manufacture empty links", () => {
  const rules = compileIssueRules([
    { pattern: "(?=ABC)", url: "https://lookahead/$0" },
    { pattern: "(?<=ABC)", url: "https://lookbehind/$0" },
    { pattern: "\\b", url: "https://boundary/$0" },
  ]);
  const started = Date.now();
  assert.deepEqual(linkifyIssues("ABC", rules), [{ text: "ABC" }]);
  assert.ok(Date.now() - started < 250, "zero-width matching must be bounded");
});

test("issue targets are restricted to external HTTP(S) URLs", () => {
  assert.equal(safeIssueUrl("command:jbGit.refresh"), undefined);
  assert.equal(safeIssueUrl("javascript:alert(1)"), undefined);
  assert.equal(safeIssueUrl("data:text/plain,hello"), undefined);
  assert.equal(safeIssueUrl("https://user:secret@example.com/issues/1"), undefined);
  assert.equal(compileIssueRules([{ pattern: "ABC-\\d+", url: "command:jbGit.refresh" }]).length, 0);
  const rules = compileIssueRules([{ pattern: "ABC-\\d+", url: "https://tracker.example/issue/$0)" }]);
  assert.equal(linkifyIssues("ABC-1", rules)[0].url, "https://tracker.example/issue/ABC-1)");
});

test("rejects the common nested-quantifier ReDoS shape", () => {
  assert.equal(compileIssueRules([{ pattern: "(a+)+$", url: "https://x/$0" }]).length, 0);
});

test("caps the text scanned by user-configured rules", () => {
  const rules = compileIssueRules([{ pattern: "A+", url: "https://x/$0" }]);
  const text = "A".repeat(100_005);
  const segments = linkifyIssues(text, rules);
  assert.equal(segments.map((segment) => segment.text).join(""), text);
});

test("the Webview runs the same compiled module, not a copy", () => {
  const panel = panelScript(import.meta.url);
  assert.match(panel, /require\.resolve\("\.\.\/issueNavigation"\)/);
  assert.match(panel, /const IssueNavigation = \(\(\) => \{ const exports = \{\};/);
  // The injected wrapper has to evaluate to a working global.
  const compiled = readFileSync(new URL("../dist/issueNavigation.js", import.meta.url), "utf8");
  const wrapped = `const IssueNavigation = (() => { const exports = {}; ${compiled}\n;return exports; })();\n`;
  const globalModule = new Function(`${wrapped}return IssueNavigation;`)();
  const segments = globalModule.linkifyIssues("ABC-1", globalModule.compileIssueRules([JIRA]));
  assert.equal(segments[0].url, "https://tracker.example.com/browse/ABC-1");
  // Rendering builds anchors from segments; rules recompile only when the
  // configuration value changes.
  const script = panelScript(import.meta.url);
  assert.match(script, /function appendIssueLinked\(parent, text\)/);
  assert.match(script, /IssueNavigation\.compileIssueRules\(raw\)/);
  assert.match(script, /issueRuleCache\.key !== key/);
  assert.match(script, /anchor\.href = segment\.url;/);
});

test("the Blame hover links the summary through the same rules", () => {
  const controller = readSource("../src/views/blameDecorations.ts", import.meta.url);
  assert.match(controller, /issueLinkedMarkdown\(entry\.summary \|\| "\(no commit message\)"\)/);
  assert.match(controller, /const raw = vscode\.workspace\.getConfiguration\("jbGit"\)\.get<unknown\[\]>\("issueNavigation", \[\]\)/);
  // Unmatched text still goes through the Markdown escaper; a link label does too.
  assert.match(controller, /markdownUrl\(segment\.url\)/);
  assert.match(controller, /enabledCommands: \["jbGit\.blameShowCommit", "jbGit\.copyRevisionNumber", "jbGit\.annotatePreviousRevision", "jbGit\.blameHideRevision", "jbGit\.blameShowHiddenRevisions"\]/);
});
