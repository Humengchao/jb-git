import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dropPlan, fixupPlan, rewordPlan, squashPlan } from "../dist/logHistoryEdit.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { originalMessage } from "../dist/webviews/rebaseEditorProtocol.js";
import { panelHost, panelScript, readSource } from "./sourceText.mjs";

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
  assert.equal(existsSync(join(root, ".git", "jb-git-rebase")), false, "completed rebases must remove scratch message files");
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
  assert.equal(existsSync(join(root, ".git", "jb-git-rebase")), false, "completed rebases must remove scratch message files");
  assert.equal((await repository.operationState()).kind, "none");
});

test("the Log offers the rewrite actions and runs them with the stash choreography", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panelScript(import.meta.url);
  assert.match(script, /label: 'Drop Commit…', run: \(\) => post\('commitsAction', \{ action: 'dropCommits', hashes: \[commit\.hash\] \}\)/);
  assert.match(script, /label: 'Squash Selected…', run: \(\) => post\('commitsAction', \{ action: 'squashCommits', hashes \}\)/);
  assert.match(script, /label: 'Drop Selected…', run: \(\) => post\('commitsAction', \{ action: 'dropCommits', hashes \}\)/);

  const host = panelHost(import.meta.url);
  // The same loader and refusals as the sequence editor, and a selection off
  // the linear history is refused before any history is touched.
  assert.match(host, /const candidates = await this\.manager\.interactiveRebaseCandidates\(root, base\);/);
  assert.match(host, /Only commits on the current branch's linear history can be rewritten from the Log\./);
  // Parked changes are kept, not restored, when the rewrite stops on a conflict.
  const rewrite = host.slice(host.indexOf("private async runHistoryRewrite"));
  const keptAt = rewrite.indexOf("Your local changes are kept in {0}");
  const restoredAt = rewrite.indexOf("restoreTemporaryStash(this.manager, root, parked, lease)");
  assert.ok(keptAt >= 0 && restoredAt >= 0 && keptAt < restoredAt, "conflict path keeps the stash before the success path restores it");
  // A non-adjacent squash names the reorder in the confirmation.
  assert.match(host, /squash && !adjacent/);
});

test("a reword plan changes one commit's message and replays the rest untouched", () => {
  const steps = rewordPlan([A, B, C], B.hash, "two, explained\n\nwith a body");
  assert.deepEqual(steps.map((step) => [step.oid, step.action, step.message]), [
    [A.hash, "pick", undefined],
    [B.hash, "reword", "two, explained\n\nwith a body"],
    [C.hash, "pick", undefined],
  ]);
  assert.throws(() => rewordPlan([A, B, C], "d".repeat(40), "x"), /not in the rewrite range/);
  assert.throws(() => rewordPlan([A, B, C], B.hash, "  \n"), /cannot be empty/);
});

test("edits the message of an older commit through a real rebase, keeping its tree", async () => {
  const root = repositoryWithCommits(["one", "two", "three"]);
  const repository = await discoverRepository(root, new GitRunner());
  const before = git(root, "rev-parse", "HEAD:./");
  const candidates = await repository.interactiveRebaseCandidates("HEAD~3");
  const history = candidates.map((commit) => ({ hash: commit.hash, subject: commit.subject, message: originalMessage(commit) }));

  await repository.interactiveRebase("HEAD~3", rewordPlan(history, history[1].hash, "two, explained\n\nBody line."));

  assert.deepEqual(subjects(root), ["three", "two, explained", "one", "base"]);
  assert.equal(git(root, "log", "-1", "--format=%B", "HEAD~1"), "two, explained\n\nBody line.");
  assert.equal(git(root, "rev-parse", "HEAD:./"), before, "a reword changes no file");
  assert.equal(existsSync(join(root, ".git", "jb-git-rebase")), false);
  assert.equal((await repository.operationState()).kind, "none");
});

test("the Log offers Edit Commit Message and Undo Commit the way IDEA does", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panelScript(import.meta.url);
  assert.match(script, /label: 'Edit Commit Message…', run: \(\) => beginRewordEditing\(commit\.hash\)/);
  // Undo is only for the checked-out commit, and never for a merge.
  assert.match(script, /label: 'Undo Commit…', disabled: !isHead \|\| \(commit\.parents \|\| \[\]\)\.length !== 1/);
  assert.match(script, /const isHead = \(commit\.refs \|\| \[\]\)\.some\(ref => ref === 'HEAD' \|\| ref\.startsWith\('HEAD -> '\)\)/);
  // The editor is inline in the details pane: it survives a re-render with the
  // draft intact, saves on Ctrl/Cmd+Enter and cancels on Escape.
  assert.match(script, /box\.value = rewordDraft !== undefined \? rewordDraft : /);
  assert.match(script, /box\.addEventListener\('input', \(\) => \{ rewordDraft = box\.value; \}\)/);
  assert.match(script, /event\.key === 'Enter' && \(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(script, /post\('rewordCommit', \{ hash: commit\.hash, message: box\.value \}\)/);

  const host = panelHost(import.meta.url);
  // HEAD is amended in place; anything older goes through the same rebase plan
  // machinery as Drop and Squash, so it shares the refusals and the stash offer.
  const reword = host.slice(host.indexOf('message.type === "rewordCommit"'), host.indexOf('message.type === "reset"'));
  assert.match(reword, /await this\.manager\.rewordHead\(root, message\.hash, text\)/);
  assert.match(reword, /rewordPlan\(history, commit\.hash, text\)/);
  assert.match(reword, /await this\.runHistoryRewrite\(root, base, steps, expectation/);
  // A pushed commit is named before the branch is rewritten.
  assert.match(reword, /await this\.manager\.isPushed\(root, message\.hash\)/);
  const undo = host.slice(host.indexOf('message.type === "undoCommit"'), host.indexOf('message.type === "rewordCommit"'));
  assert.match(undo, /Only the last commit can be undone/);
  assert.match(undo, /snapshot\.operation\.kind !== "none"/);
  assert.match(undo, /await this\.manager\.undoCommit\(root, message\.hash\)/);
});

test("a fixup plan moves the newest commit to right after its target and folds it in", () => {
  const F = { hash: "f".repeat(40), subject: "fixup! one", message: "fixup! one" };
  const steps = fixupPlan([A, B, C, F], A.hash, F.hash);
  assert.deepEqual(steps.map((step) => [step.oid, step.action]), [
    [A.hash, "pick"],
    [F.hash, "fixup"],
    [B.hash, "pick"],
    [C.hash, "pick"],
  ]);
  // The fixup commit has to be the one just made on top of HEAD.
  assert.throws(() => fixupPlan([A, B, C, F], A.hash, C.hash), /newest commit/);
  assert.throws(() => fixupPlan([A, B, C, F], "d".repeat(40), F.hash), /not in the rewrite range/);
  assert.throws(() => fixupPlan([A, B, C, F], F.hash, F.hash), /not in the rewrite range/);
});

test("Fixup… folds the staged changes into an older commit through a real rebase", async () => {
  const root = repositoryWithCommits(["one", "two", "three"]);
  const repository = await discoverRepository(root, new GitRunner());
  const target = git(root, "rev-parse", "HEAD~2");
  writeFileSync(join(root, "one.txt"), "one\nand a fix\n");
  git(root, "add", "one.txt");
  writeFileSync(join(root, "unrelated.txt"), "not staged\n");

  const fixup = await repository.commitFixup(target);
  assert.equal(git(root, "log", "-1", "--format=%s", fixup), "fixup! one");
  const candidates = await repository.interactiveRebaseCandidates(`${target}^`);
  const history = candidates.map((commit) => ({ hash: commit.hash, subject: commit.subject, message: originalMessage(commit) }));
  await repository.interactiveRebase(`${target}^`, fixupPlan(history, target, fixup), {
    head: fixup,
    branch: git(root, "branch", "--show-current"),
    commits: candidates.map((commit) => commit.hash),
  });

  assert.deepEqual(subjects(root), ["three", "two", "one", "base"], "the fixup commit is gone and every message is kept");
  assert.equal(git(root, "show", "HEAD~2:one.txt"), "one\nand a fix", "the staged change now lives in the fixed commit");
  assert.equal(git(root, "show", "HEAD:one.txt"), "one\nand a fix");
  assert.equal(existsSync(join(root, "unrelated.txt")), true, "an untracked file rides along untouched");
  assert.equal((await repository.operationState()).kind, "none");
});

test("Fixup… aimed at HEAD is an amend that keeps the message", async () => {
  const root = repositoryWithCommits(["one"]);
  const repository = await discoverRepository(root, new GitRunner());
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "one.txt"), "one\nmore\n");
  git(root, "add", "one.txt");

  const amended = await repository.amendStaged(head);
  assert.notEqual(amended, head);
  assert.equal(git(root, "log", "-1", "--format=%s"), "one");
  assert.equal(git(root, "show", "HEAD:one.txt"), "one\nmore");
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "2");
  await assert.rejects(repository.amendStaged(head), /HEAD moved/);
});

test("the Log's Fixup… checks the target before committing and says so when the fold did not run", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panelScript(import.meta.url);
  assert.match(script, /label: 'Fixup…', run: \(\) => post\('fixupCommit', \{ hash: commit\.hash \}\)/);
  const host = panelHost(import.meta.url);
  const fixup = host.slice(host.indexOf('message.type === "fixupCommit"'), host.indexOf('message.type === "rewordCommit"'));
  // Nothing staged means nothing to fix up with; the Index is the source.
  assert.match(fixup, /Stage the changes that belong in \{0\} first/);
  // The linear-history check runs before the fixup commit exists, so a refusal
  // leaves the staged changes exactly as they were.
  const preflightAt = fixup.indexOf("Only commits on the current branch's linear history");
  const commitAt = fixup.indexOf("await this.manager.commitFixup(root, commit.hash)");
  assert.ok(preflightAt >= 0 && commitAt >= 0 && preflightAt < commitAt);
  assert.match(fixup, /await this\.manager\.amendStaged\(root, message\.hash\)/);
  assert.match(fixup, /const outcome = await this\.runHistoryRewrite\(/);
  assert.match(fixup, /was created but not folded in/);
});

test("a rewrite that stops on a conflict is not reported as done", async () => {
  // Two commits touch the same line, so dropping the first makes replaying the
  // second conflict: the real Git stop this reporting has to survive.
  const root = mkdtempSync(join(tmpdir(), "jb-git-histedit-stop-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "f.txt"), "base\n");
  git(root, "add", "f.txt");
  git(root, "commit", "-qm", "base");
  writeFileSync(join(root, "f.txt"), "first\n");
  git(root, "commit", "-qam", "one");
  writeFileSync(join(root, "f.txt"), "second\n");
  git(root, "commit", "-qam", "two");
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~2");
  const history = candidates.map((commit) => ({ hash: commit.hash, subject: commit.subject, message: originalMessage(commit) }));

  await assert.rejects(repository.interactiveRebase("HEAD~2", dropPlan(history, new Set([history[0].hash]))));
  const state = await repository.operationState();
  assert.equal(state.kind, "rebase", "the branch is parked on the conflict");
  assert.equal(state.canContinue, true);
  await repository.abortOperation("rebase");

  // The panel must not claim the rewrite happened while that state is live:
  // the outcome is three-state, and only "completed" prints the message.
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const host = panelHost(import.meta.url);
  assert.match(host, /type HistoryRewriteOutcome = "completed" \| "declined" \| "paused";/);
  const rewrite = host.slice(host.indexOf("private async runHistoryRewrite"), host.indexOf("public dispose()"));
  assert.match(rewrite, /outcome = "paused";/);
  assert.match(rewrite, /if \(outcome !== "completed"\) return outcome;\s*\n\s*void vscode\.window\.showInformationMessage\(successMessage\);/);
  assert.match(rewrite, /answer !== vscode\.l10n\.t\("Stash and Rebase"\)\) return "declined";/);
  // A stopped rebase still folds the fixup in on Continue, so only a rewrite
  // that never ran leaves the fixup commit standing.
  const fixup = host.slice(host.indexOf('message.type === "fixupCommit"'), host.indexOf('message.type === "rewordCommit"'));
  assert.match(fixup, /if \(outcome === "declined"\) \{/);
  assert.match(fixup, /was created but not folded in/);
});

test("a merge or rebase that pauses from the Log is explained rather than only reported as a Git error", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const host = panelHost(import.meta.url);
  const guard = host.slice(host.indexOf("const paused = this.currentSnapshot()?.operation;"));
  assert.match(guard.slice(0, 800), /if \(paused && paused\.kind !== "none" && paused\.canContinue\)/, "only an operation the user can continue is explained");
  assert.match(guard.slice(0, 800), /stopped on a conflict\. Resolve the conflicted files in Local Changes and Continue/);
  // Git's own text still reaches the panel's banner.
  assert.match(guard.slice(0, 900), /postMessage\(\{ type: "error", message: formatError\(error\) \}\)/);
});
