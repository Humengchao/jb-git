import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendIgnoreLine, escapeIgnorePath, ignorePatternsFor } from "../dist/ignoreRules.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { readSource } from "./sourceText.mjs";

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

/**
 * File identity rather than path text: the repository root is canonical while
 * the temp dir is not — macOS reaches it through /var → /private/var, Windows
 * hands out an 8.3 short name (RUNNER~1) that realpathSync does not expand.
 */
function sameFile(left, right) {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "jb-git-ignore-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

test("offers IDEA's three rules for a file: itself, its directory, its extension", () => {
  assert.deepEqual(ignorePatternsFor("build/output/app.log"), [
    { kind: "file", pattern: "/build/output/app.log" },
    { kind: "directory", pattern: "/build/output/" },
    { kind: "extension", pattern: "*.log" },
  ]);
  // A root-level file has no directory to offer; a dotfile has no extension.
  assert.deepEqual(ignorePatternsFor(".env"), [{ kind: "file", pattern: "/.env" }]);
  assert.deepEqual(ignorePatternsFor("notes"), [{ kind: "file", pattern: "/notes" }]);
  // Windows separators are Git's forward slashes by the time they are a rule.
  assert.equal(ignorePatternsFor("a\\b\\c.tmp")[1].pattern, "/a/b/");
  assert.deepEqual(ignorePatternsFor("dist/", true), [{ kind: "directory", pattern: "/dist/" }]);
  assert.deepEqual(ignorePatternsFor(""), []);
});

test("escapes the characters gitignore would otherwise interpret", () => {
  assert.equal(escapeIgnorePath("a*b?c[d].txt"), "a\\*b\\?c\\[d\\].txt");
  assert.equal(escapeIgnorePath("#comment-looking"), "\\#comment-looking");
  assert.equal(escapeIgnorePath("!negated"), "\\!negated");
  assert.equal(escapeIgnorePath("trailing space "), "trailing space\\ ");
  assert.equal(escapeIgnorePath("back\\slash"), "back/slash", "a backslash is a separator on Windows, so it becomes a slash");
});

test("appends a rule once, on its own line, keeping the file's line endings", () => {
  assert.equal(appendIgnoreLine("", "/out/"), "/out/\n");
  assert.equal(appendIgnoreLine("node_modules\n", "/out/"), "node_modules\n/out/\n");
  // A file without a final newline must not glue the rule to the last line.
  assert.equal(appendIgnoreLine("node_modules", "/out/"), "node_modules\n/out/\n");
  assert.equal(appendIgnoreLine("node_modules\r\n", "/out/"), "node_modules\r\n/out/\r\n");
  // Repeating the action does not grow the file.
  assert.equal(appendIgnoreLine("node_modules\n/out/\n", "/out/"), "node_modules\n/out/\n");
  assert.equal(appendIgnoreLine("  /out/  \n", "/out/"), "  /out/  \n");
  assert.throws(() => appendIgnoreLine("", "a\nb"), /single non-empty line/);
  assert.throws(() => appendIgnoreLine("", "   "), /single non-empty line/);
});

test("writes the rule where it was asked to, and Git then ignores the file", async () => {
  const root = repository();
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "build", "app.log"), "log\n");
  writeFileSync(join(root, "scratch.tmp"), "tmp\n");
  const repo = await discoverRepository(root, new GitRunner());

  const gitignore = await repo.addIgnoreRule("gitignore", "/build/");
  assert.equal(sameFile(gitignore, join(root, ".gitignore")), true, `${gitignore} is the repository's .gitignore`);
  assert.equal(readFileSync(gitignore, "utf8"), "/build/\n");
  const exclude = await repo.addIgnoreRule("exclude", "*.tmp");
  assert.equal(sameFile(exclude, join(root, ".git", "info", "exclude")), true, `${exclude} is the clone's info/exclude`);
  assert.ok(readFileSync(exclude, "utf8").endsWith("*.tmp\n"), "the exclude file already shipped with comments; the rule goes after them");

  const untracked = (await repo.status()).changes.filter((change) => change.kind === "untracked").map((change) => change.path);
  assert.deepEqual(untracked, [".gitignore"], "only the new .gitignore itself is left unversioned");
  assert.equal(git(root, "check-ignore", "build/app.log"), "build/app.log");
  assert.equal(git(root, "check-ignore", "scratch.tmp"), "scratch.tmp");

  // Adding the same rule again leaves the file alone.
  await repo.addIgnoreRule("gitignore", "/build/");
  assert.equal(readFileSync(gitignore, "utf8"), "/build/\n");
});

test("the Local Changes menu offers Ignore for unversioned files only, with both destinations", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panel.slice(panel.indexOf("const logScript = String.raw`"));
  assert.match(script, /if \(change\.kind === 'untracked'\) contextItems\.push\(\{ icon: '⊘', label: 'Ignore…', run: \(\) => post\('ignorePath', \{ path: change\.path \}\) \}\)/);
  const host = panel.slice(0, panel.indexOf("const logScript = String.raw`"));
  const ignore = host.slice(host.indexOf('message.type === "ignorePath"'), host.indexOf('message.type === "discard"'));
  assert.match(ignore, /change\.kind !== "untracked"\) return;/);
  assert.match(ignore, /ignorePatternsFor\(change\.path\)/);
  assert.match(ignore, /target: "gitignore" as const/);
  assert.match(ignore, /target: "exclude" as const/);
});
