import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_COMMENT_CHAR, effectiveCommitMessage, stripCommentLines } from "../dist/commitMessage.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { panelHost, panelScript, readSource } from "./sourceText.mjs";

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "jb-git-msg-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  return root;
}

test("strips exactly the lines Git's --cleanup=strip drops", () => {
  assert.equal(DEFAULT_COMMENT_CHAR, "#");
  assert.equal(stripCommentLines("# comment\nsubject\n"), "subject");
  assert.equal(stripCommentLines("  # indented comment\nsubject"), "subject");
  // Blank lines around the message go; ones inside it stay.
  assert.equal(stripCommentLines("\n\nsubject\n\nbody\n\n"), "subject\n\nbody");
  assert.equal(stripCommentLines("subject   \nbody\t\n"), "subject\nbody", "trailing whitespace goes");
  // A message that is nothing but comments becomes empty, which is what makes
  // Git abort the commit.
  assert.equal(stripCommentLines("# one\n#\n#   two\n"), "");
  // A different core.commentChar moves which lines are comments.
  assert.equal(stripCommentLines("; comment\n#123 is a subject", ";"), "#123 is a subject");
  assert.equal(stripCommentLines("#123 stays", ";"), "#123 stays");
});

test("the effective message is only stripped when the commit will strip it", () => {
  assert.equal(effectiveCommitMessage("# only comments\n", true), "");
  assert.equal(effectiveCommitMessage("# only comments\n", false), "# only comments", "without a template a leading # is content");
  assert.equal(effectiveCommitMessage("  subject  ", false), "subject");
});

test("reads core.commentChar and the commit template Git would use", async () => {
  const root = repository();
  const repo = await discoverRepository(root, new GitRunner());
  assert.equal(await repo.commentChar(), "#", "the default when nothing is configured");
  assert.equal(await repo.commitTemplate(), undefined);

  writeFileSync(join(root, ".gitmessage"), "# Describe the change\n#\n");
  git(root, "config", "commit.template", ".gitmessage");
  git(root, "config", "core.commentChar", ";");
  assert.equal(await repo.commitTemplate(), "# Describe the change\n#\n", "a relative template path is resolved against the work tree");
  assert.equal(await repo.commentChar(), ";");

  // A configured template that is gone is no template, not a failure.
  git(root, "config", "commit.template", "missing-file");
  assert.equal(await repo.commitTemplate(), undefined);
});

test("a commit that Git would strip to nothing is refused with a sentence, not Git's abort", async () => {
  // Proof that Git aborts, which is what the host-side check now prevents.
  const root = repository();
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  assert.throws(
    () => execFileSync("git", ["commit", "--cleanup=strip", "--file=-"], { cwd: root, input: "# nothing but a comment\n", encoding: "utf8" }),
    /empty commit message/i,
  );

  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const host = panelHost(import.meta.url);
  const commit = host.slice(host.indexOf('message.type === "commit"'), host.indexOf('message.type === "createChangelist"'));
  assert.match(commit, /const \{ commitTemplate, commentChar \} = await this\.commitFormExtras\(root, snapshot\);/, "the cached read is reused instead of a second git config call");
  assert.match(commit, /const commitMessage = effectiveCommitMessage\(message\.message, stripComments, commentChar\);/);
  assert.match(commit, /only the commit template's comments/);
  // What Git records is what the message history remembers.
  assert.match(commit, /await this\.recordCommitMessage\(root, commitMessage\);/);

  // The Webview's button uses the same rule and the same comment character, so
  // the two cannot disagree about whether the box is empty.
  const script = panelScript(import.meta.url);
  assert.match(script, /const commentChar = typeof state\.commentChar === 'string' && state\.commentChar \? state\.commentChar : '#';/);
  assert.match(script, /line\.trimStart\(\)\.startsWith\(commentChar\)/);
});
