import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLogMessage } from "../dist/webviews/logPanelProtocol.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { readSource } from "./sourceText.mjs";

const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
const script = panel.slice(panel.indexOf("const logScript = String.raw`"));

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
}

test("bounds the whole-history search text at the extension-host boundary", () => {
  assert.equal(isLogMessage({ type: "deepSearch", text: "fix the parser" }), true);
  assert.equal(isLogMessage({ type: "deepSearch", text: "" }), true, "empty text is how the search is cleared");
  assert.equal(isLogMessage({ type: "deepSearch", text: "a".repeat(513) }), false);
  assert.equal(isLogMessage({ type: "deepSearch", text: "line\nbreak" }), false, "the text lands in a command argument");
  assert.equal(isLogMessage({ type: "deepSearch" }), false);
});

test("searches commit messages over the whole walk, not the loaded window", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-grep-"));
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "f.txt"), "0\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "the needle [ABC-1] lives here");
  for (let index = 1; index <= 8; index += 1) {
    writeFileSync(join(root, "f.txt"), `${index}\n`);
    git(root, "add", ".");
    git(root, "commit", "-qm", `routine change ${index}`);
  }
  const repository = await discoverRepository(root, new GitRunner());
  assert.ok(repository);

  // A window of 3 does not reach the needle; the grep still finds it because
  // Git applies the filter over the walk before the count.
  const windowed = await repository.log(3);
  assert.equal(windowed.some((commit) => commit.subject.includes("needle")), false);
  const found = await repository.log(3, undefined, { grep: "needle [ABC-1]" });
  assert.equal(found.length, 1);
  assert.match(found[0].subject, /needle \[ABC-1\]/);
  // Fixed strings: the brackets were searched as text, not as a character class.
  const caseInsensitive = await repository.log(3, undefined, { grep: "NEEDLE [abc-1]" });
  assert.equal(caseInsensitive.length, 1, "the search is case-insensitive, like IDEA's");
  assert.equal((await repository.log(3, undefined, { grep: "no such message" })).length, 0);
});

test("routes Enter to Git and keeps hash input as a jump", () => {
  // Enter searches the whole history; the loaded-window filter is cleared
  // because it would only hide rows the search already matched.
  assert.match(script, /if \(event\.key !== 'Enter'\) return;/);
  assert.match(script, /post\('deepSearch', \{ text \}\)/);
  assert.match(script, /search = ''; saveUiState\(\{ search \}\);/);
  // Emptying the box (including the native clear) ends an active search.
  assert.match(script, /if \(!input\.value && state\.logSearch\) \{ post\('deepSearch', \{ text: '' \}\); return; \}/);
  // The active state is visible, not ambient.
  assert.match(script, /deep-active/);
  assert.match(script, /'Searching all history': '正在搜索全部历史'/);
  // The host treats a hex-looking entry as IDEA's go-to-hash: re-root the log
  // at that commit so one outside the loaded window is still reachable.
  assert.match(panel, /if \(\/\^\[0-9a-f\]\{4,64\}\$\/i\.test\(text\)\)/);
  assert.match(panel, /this\.selectedRef = commit\.hash;\s*\n\s*this\.lineRange = undefined;\s*\n\s*this\.selectedHash = commit\.hash;/);
  // Search text feeds the same read path the log always uses, so the graph,
  // selection and virtualization stay one implementation.
  const readOptions = panel.slice(panel.indexOf("const readOptions: Partial<GitLogOptions> = {"), panel.indexOf("const fingerprint = JSON.stringify(["));
  assert.match(readOptions, /\.\.\.this\.logOptions,/);
  assert.match(readOptions, /includeBody: false,/);
  assert.match(readOptions, /\.\.\.\(this\.logSearch \? \{ grep: this\.logSearch \} : \{\}\),/);
  // Revealing a commit clears the search that could exclude it.
  const reveal = panel.slice(panel.indexOf("public async revealCommit("));
  assert.match(reveal.slice(0, 700), /this\.logSearch = undefined;/);
});

test("grows the log with an incremental page and cancels stale walks", () => {
  assert.match(panel, /logRefPage\(root, this\.selectedRef, additional, cache\.limit/);
  assert.match(panel, /logPage\(root, additional, cache\.limit/);
  assert.match(panel, /this\.logRequestController\?\.abort\(\)/);
  assert.match(panel, /stateVersion: version/);
  assert.match(panel, /includeBody: false/);
  assert.match(panel, /readCommitMessage\(root, commit\.hash/);
});
