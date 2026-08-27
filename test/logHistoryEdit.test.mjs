import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dropPlan, squashPlan } from "../dist/logHistoryEdit.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { originalMessage } from "../dist/webviews/rebaseEditorProtocol.js";
import { readSource } from "./sourceText.mjs";

const A = { hash: "a".repeat(40), subject: "one", message: "one" };
const B = { hash: "b".repeat(40), subject: "two", message: "two" };
const C = { hash: "c".repeat(40), subject: "three", message: "three\n\nwith a body" };

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

function repositoryWithCommits(subjects) {
  const root = mkdtempSync(join(tmpdir(), "jb-git-histedit-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-qm", "base");
  for (const subject of subjects) {
    const name = `${subject.replace(/[^a-z0-9]+/gi, "-")}.txt`;
    writeFileSync(join(root, name), `${subject}\n`);
    git(root, "add", name);
    git(root, "commit", "-qm", subject);
  }
  return root;
}

function subjects(root) {
  return git(root, "log", "--format=%s", "HEAD").split("\n");
}

test("a drop plan turns exactly the selection into drop rows", () => {
  const steps = dropPlan([A, B, C], new Set([B.hash]));
  assert.deepEqual(steps.map((step) => [step.oid, step.action]), [
    [A.hash, "pick"],
    [B.hash, "drop"],
    [C.hash, "pick"],
  ]);
});

test("a squash plan gathers the selection at the oldest commit and keeps every message", () => {
  // Non-adjacent: `two` sits between the selected `one` and `three`, so it is
  // reordered to replay after the squashed result — exactly like IDEA.
  const steps = squashPlan([A, B, C], new Set([A.hash, C.hash]));
  assert.deepEqual(steps.map((step) => [step.oid, step.action]), [
    [A.hash, "pick"],
    [C.hash, "squash"],
    [B.hash, "pick"],
  ]);
  // The combined message rides on the last squash row, which is the step whose
  // amend the todo generator emits.
  assert.equal(steps[1].message, "one\n\nthree\n\nwith a body");
  assert.equal(steps[0].message, undefined);
  assert.throws(() => squashPlan([A, B, C], new Set([A.hash])), /at least two/);
});

test("drops a commit from the log through a real rebase", async () => {
  const root = repositoryWithCommits(["one", "two", "three"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~3");
  const history = candidates.map((commit) => ({ hash: commit.hash, subject: commit.subject, message: originalMessage(commit) }));

  await repository.interactiveRebase("HEAD~3", dropPlan(history, new Set([history[1].hash])));

  assert.deepEqual(subjects(root), ["three", "one", "base"]);
  assert.equal(existsSync(join(root, "two.txt")), false, "the dropped commit's file is gone");
  assert.equal(existsSync(join(root, "three.txt")), true, "the commits after the drop replayed");
  assert.equal((await repository.operationState()).kind, "none");
});

test("squashes a non-adjacent selection through a real rebase, reordering the middle", async () => {
  const root = repositoryWithCommits(["one", "two", "three"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~3");
  const history = candidates.map((commit) => ({ hash: commit.hash, subject: commit.subject, message: originalMessage(commit) }));

  await repository.interactiveRebase("HEAD~3", squashPlan(history, new Set([history[0].hash, history[2].hash])));

  // `one`+`three` became one commit; `two` replays after it.
  assert.deepEqual(subjects(root), ["two", "one", "base"]);
  const combined = git(root, "log", "-1", "--format=%B", "HEAD~1");
  assert.ok(combined.includes("one") && combined.includes("three"), `both messages survive: ${combined}`);
  for (const name of ["one.txt", "two.txt", "three.txt"]) assert.equal(existsSync(join(root, name)), true, name);
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "3");
  assert.equal((await repository.operationState()).kind, "none");
});

test("the Log offers the rewrite actions and runs them with the stash choreography", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panel.slice(panel.indexOf("const logScript = String.raw`"));
  assert.match(script, /label: 'Drop Commit…', run: \(\) => post\('commitsAction', \{ action: 'dropCommits', hashes: \[commit\.hash\] \}\)/);
  assert.match(script, /label: 'Squash Selected…', run: \(\) => post\('commitsAction', \{ action: 'squashCommits', hashes \}\)/);
  assert.match(script, /label: 'Drop Selected…', run: \(\) => post\('commitsAction', \{ action: 'dropCommits', hashes \}\)/);

  const host = panel.slice(0, panel.indexOf("const logScript = String.raw`"));
  // The same loader and refusals as the sequence editor, and a selection off
  // the linear history is refused before any history is touched.
  assert.match(host, /const candidates = await this\.manager\.interactiveRebaseCandidates\(root, base\);/);
  assert.match(host, /Only commits on the current branch's linear history can be rewritten from the Log\./);
  // Parked changes are kept, not restored, when the rewrite stops on a conflict.
  const rewrite = host.slice(host.indexOf("private async runHistoryRewrite"));
  const keptAt = rewrite.indexOf("Your local changes are kept in {0}");
  const restoredAt = rewrite.indexOf("restoreTemporaryStash(this.manager, root, parked)");
  assert.ok(keptAt >= 0 && restoredAt >= 0 && keptAt < restoredAt, "conflict path keeps the stash before the success path restores it");
  // A non-adjacent squash names the reorder in the confirmation.
  assert.match(host, /squash && !adjacent/);
});
