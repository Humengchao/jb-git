import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRebaseTodo, isNoOpPlan, isRebaseAction, posixPath, shellQuote, validateRebasePlan } from "../dist/interactiveRebase.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

/** Builds a repository whose commits each add one file, oldest first. */
function repositoryWithCommits(subjects) {
  const root = mkdtempSync(join(tmpdir(), "jb-git-irebase-"));
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

function todoLines(plan) {
  return plan.todo.trimEnd().split("\n").filter((line) => !line.startsWith("#"));
}

test("keeps a plain pick plan as a flat todo with no message files", () => {
  const plan = buildRebaseTodo([
    { oid: OID_A, subject: "first", action: "pick" },
    { oid: OID_B, subject: "second", action: "pick" },
  ], "/tmp/scratch");
  assert.deepEqual(todoLines(plan), [`pick ${OID_A} first`, `pick ${OID_B} second`]);
  assert.deepEqual(plan.messages, []);
});

test("lowers reword onto pick plus an exec that amends from a file", () => {
  const plan = buildRebaseTodo([
    { oid: OID_A, subject: "first", action: "reword", message: "better subject" },
  ], "/tmp/scratch");
  assert.deepEqual(todoLines(plan), [
    `pick ${OID_A} first`,
    `exec test "$('git' log -1 --format=%s)" = 'first' && 'git' commit --amend --no-verify --cleanup=whitespace --file='/tmp/scratch/message-${OID_A}.txt'`,
  ]);
  assert.deepEqual(plan.messages, [{ name: `message-${OID_A}.txt`, content: "better subject\n" }]);
});

test("lowers squash onto fixup and amends only after the run's last commit", () => {
  const plan = buildRebaseTodo([
    { oid: OID_A, subject: "first", action: "pick" },
    { oid: OID_B, subject: "second", action: "squash", message: "combined" },
    { oid: OID_C, subject: "third", action: "pick" },
  ], "/tmp/scratch");
  assert.deepEqual(todoLines(plan), [
    `pick ${OID_A} first`,
    `fixup ${OID_B} second`,
    // The guard names the run leader, whose message a fixup keeps.
    `exec test "$('git' log -1 --format=%s)" = 'first' && 'git' commit --amend --no-verify --cleanup=whitespace --file='/tmp/scratch/message-${OID_A}.txt'`,
    `pick ${OID_C} third`,
  ]);
  // The file is named for the run's leader, which is the commit that survives.
  assert.deepEqual(plan.messages.map((entry) => entry.name), [`message-${OID_A}.txt`]);
});

test("leaves fixup without a message file so the run keeps the leader's message", () => {
  const plan = buildRebaseTodo([
    { oid: OID_A, subject: "first", action: "pick" },
    { oid: OID_B, subject: "second", action: "fixup" },
  ], "/tmp/scratch");
  assert.deepEqual(todoLines(plan), [`pick ${OID_A} first`, `fixup ${OID_B} second`]);
  assert.deepEqual(plan.messages, []);
});

test("emits drop lines so Git sees every commit the plan covers", () => {
  const plan = buildRebaseTodo([
    { oid: OID_A, subject: "first", action: "pick" },
    { oid: OID_B, subject: "second", action: "drop" },
  ], "/tmp/scratch");
  assert.deepEqual(todoLines(plan), [`pick ${OID_A} first`, `drop ${OID_B} second`]);
});

test("rejects plans Git would refuse or carry out differently", () => {
  assert.match(validateRebasePlan([]), /at least one commit/);
  assert.match(
    validateRebasePlan([{ oid: OID_A, subject: "first", action: "squash", message: "x" }]),
    /first replayed commit cannot be "squash"/,
  );
  assert.match(
    validateRebasePlan([{ oid: OID_A, subject: "first", action: "fixup" }]),
    /first replayed commit cannot be "fixup"/,
  );
  assert.match(
    validateRebasePlan([{ oid: OID_A, subject: "first", action: "drop" }]),
    /Dropping every commit/,
  );
  assert.match(
    validateRebasePlan([{ oid: OID_A, subject: "first", action: "reword", message: "  " }]),
    /needs a commit message/,
  );
  assert.match(
    validateRebasePlan([
      { oid: OID_A, subject: "first", action: "pick" },
      { oid: OID_A, subject: "first", action: "pick" },
    ]),
    /appears more than once/,
  );
  assert.match(validateRebasePlan([{ oid: "abc123", subject: "first", action: "pick" }]), /not a full commit ID/);
  // A SHA-256 repository reports 64-character IDs, which must not look malformed.
  assert.equal(validateRebasePlan([{ oid: "a".repeat(64), subject: "first", action: "pick" }]), undefined);
  assert.equal(isRebaseAction("pick"), true);
  assert.equal(isRebaseAction("exec"), false);
});

test("quotes a scratch directory that contains shell-significant characters", () => {
  assert.equal(shellQuote("/tmp/it's here/x"), "'/tmp/it'\\''s here/x'");
  // A space and a `;` inside the path must not split the exec line into two commands.
  const plan = buildRebaseTodo(
    [{ oid: OID_A, subject: "first", action: "reword", message: "m" }],
    "/tmp/dir with space; rm -rf",
  );
  assert.ok(plan.todo.includes(`--file='/tmp/dir with space; rm -rf/message-${OID_A}.txt'`));
  // A single quote in the path is the case naive quoting gets wrong.
  const quoted = buildRebaseTodo(
    [{ oid: OID_A, subject: "first", action: "reword", message: "m" }],
    "/tmp/it's/.git/jb-git-rebase/",
  );
  assert.ok(quoted.todo.includes(`--file='/tmp/it'\\''s/.git/jb-git-rebase/message-${OID_A}.txt'`));
});

test("keeps a multi-line subject on one todo line", () => {
  const plan = buildRebaseTodo(
    [{ oid: OID_A, subject: "first line\npick deadbeef injected", action: "pick" }],
    "/tmp/scratch",
  );
  assert.deepEqual(todoLines(plan), [`pick ${OID_A} first line`]);
});

test("treats a pure reorder as a real change", () => {
  const steps = [
    { oid: OID_B, subject: "second", action: "pick" },
    { oid: OID_A, subject: "first", action: "pick" },
  ];
  assert.equal(isNoOpPlan(steps, [OID_B, OID_A]), true);
  assert.equal(isNoOpPlan(steps, [OID_A, OID_B]), false);
});

test("uses Windows-independent separators in the exec path", () => {
  const plan = buildRebaseTodo(
    [{ oid: OID_A, subject: "first", action: "reword", message: "m" }],
    "C:\\repo\\.git\\jb-git-rebase",
  );
  assert.ok(plan.todo.includes(`--file='C:/repo/.git/jb-git-rebase/message-${OID_A}.txt'`));
});

test("refuses to amend when the replayed commit is not the one the plan named", () => {
  const plan = buildRebaseTodo(
    [{ oid: OID_A, subject: "expected subject", action: "reword", message: "new" }],
    "/tmp/scratch",
  );
  // `test ... &&` makes a mismatch fail the exec, which stops the rebase instead
  // of rewriting the message of whatever commit HEAD happens to be.
  assert.ok(plan.todo.includes(`test "$('git' log -1 --format=%s)" = 'expected subject' &&`));
});

test("skips the subject guard when it cannot be expressed on one todo line", () => {
  const plan = buildRebaseTodo(
    [{ oid: OID_A, subject: "first line\nsecond line", action: "reword", message: "new" }],
    "/tmp/scratch",
  );
  const lines = plan.todo.trimEnd().split("\n").filter((line) => !line.startsWith("#"));
  assert.equal(lines.length, 2, "a newline in the subject must not split the todo");
  assert.ok(lines[1].startsWith("exec 'git' commit --amend"));
});

test("runs the configured Git binary rather than whatever PATH resolves", () => {
  const plan = buildRebaseTodo(
    [{ oid: OID_A, subject: "first", action: "reword", message: "m" }],
    "/tmp/scratch",
    "/opt/custom path/bin/git",
  );
  assert.ok(plan.todo.includes("'/opt/custom path/bin/git' commit --amend"));
  // The guard must use the configured binary too, not PATH's git.
  assert.ok(plan.todo.includes(`test "$('/opt/custom path/bin/git' log -1 --format=%s)\"`));
});

test("hands the shell forward slashes, which Windows MSYS needs", () => {
  // Git runs exec and the sequence editor through its bundled sh on Windows,
  // where a backslash inside single quotes is a literal, not a separator.
  assert.equal(posixPath("C:\\repo\\.git\\jb-git-rebase"), "C:/repo/.git/jb-git-rebase");
  assert.equal(posixPath("/tmp/scratch"), "/tmp/scratch");

  const plan = buildRebaseTodo(
    [{ oid: OID_A, subject: "first", action: "reword", message: "m" }],
    "C:\\repo\\.git\\jb-git-rebase",
    "C:\\Program Files\\Git\\cmd\\git.exe",
  );
  assert.ok(plan.todo.includes("exec test \"$('C:/Program Files/Git/cmd/git.exe' log -1"));
  assert.ok(plan.todo.includes(`--file='C:/repo/.git/jb-git-rebase/message-${OID_A}.txt'`));
  assert.ok(!plan.todo.includes("\\"), "no backslash may survive into the todo");
});

test("reorders commits through a real interactive rebase", async () => {
  const root = repositoryWithCommits(["one", "two"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~2");
  assert.deepEqual(candidates.map((commit) => commit.subject), ["one", "two"]);

  await repository.interactiveRebase("HEAD~2", [
    { oid: candidates[1].hash, subject: "two", action: "pick" },
    { oid: candidates[0].hash, subject: "one", action: "pick" },
  ]);
  assert.deepEqual(subjects(root), ["one", "two", "base"]);
  assert.equal((await repository.operationState()).kind, "none");
});

test("rewords a commit without opening an editor and keeps its author", async () => {
  const root = repositoryWithCommits(["one", "two"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~2");
  const authorBefore = git(root, "log", "-1", "--format=%an <%ae>", candidates[0].hash);

  await repository.interactiveRebase("HEAD~2", [
    { oid: candidates[0].hash, subject: "one", action: "reword", message: "one, explained\n\nA body line.\n#1234 stays" },
    { oid: candidates[1].hash, subject: "two", action: "pick" },
  ]);

  assert.deepEqual(subjects(root), ["two", "one, explained", "base"]);
  const body = git(root, "log", "-1", "--format=%B", "HEAD~1");
  assert.ok(body.includes("A body line."));
  // --cleanup=whitespace keeps a line that merely starts like a comment.
  assert.ok(body.includes("#1234 stays"));
  assert.equal(git(root, "log", "-1", "--format=%an <%ae>", "HEAD~1"), authorBefore);
});

test("squashes commits into one with the combined message", async () => {
  const root = repositoryWithCommits(["one", "two", "three"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~3");

  await repository.interactiveRebase("HEAD~3", [
    { oid: candidates[0].hash, subject: "one", action: "pick" },
    { oid: candidates[1].hash, subject: "two", action: "squash", message: "one and two together" },
    { oid: candidates[2].hash, subject: "three", action: "pick" },
  ]);

  assert.deepEqual(subjects(root), ["three", "one and two together", "base"]);
  // Squashing folds content in rather than discarding it.
  assert.ok(git(root, "show", "--stat", "--format=", "HEAD~1").includes("two.txt"));
});

test("folds a fixup while keeping the leader's message", async () => {
  const root = repositoryWithCommits(["one", "two"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~2");

  await repository.interactiveRebase("HEAD~2", [
    { oid: candidates[0].hash, subject: "one", action: "pick" },
    { oid: candidates[1].hash, subject: "two", action: "fixup" },
  ]);
  assert.deepEqual(subjects(root), ["one", "base"]);
  assert.ok(git(root, "show", "--stat", "--format=", "HEAD").includes("two.txt"));
});

test("drops a commit and its content", async () => {
  const root = repositoryWithCommits(["one", "two"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~2");

  await repository.interactiveRebase("HEAD~2", [
    { oid: candidates[0].hash, subject: "one", action: "drop" },
    { oid: candidates[1].hash, subject: "two", action: "pick" },
  ]);
  assert.deepEqual(subjects(root), ["two", "base"]);
  assert.equal(git(root, "ls-files", "one.txt"), "");
});

test("refuses to rebase over local changes instead of autostashing them", async () => {
  const root = repositoryWithCommits(["one"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~1");
  writeFileSync(join(root, "base.txt"), "edited\n");

  await assert.rejects(
    repository.interactiveRebase("HEAD~1", [{ oid: candidates[0].hash, subject: "one", action: "reword", message: "x" }]),
    /local change\(s\) would block the rebase/,
  );
  assert.deepEqual(subjects(root), ["one", "base"]);
});

test("rebases over an untracked file, which Git itself does not mind", async () => {
  // Counting untracked files as blocking refused a rebase Git would have run,
  // and a scratch file or a build artefact is enough to hit that.
  const root = repositoryWithCommits(["one"]);
  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~1");
  writeFileSync(join(root, "scratch-note.txt"), "not committed, not staged\n");

  await repository.interactiveRebase("HEAD~1", [
    { oid: candidates[0].hash, subject: "one", action: "reword", message: "reworded over an untracked file" },
  ]);
  assert.deepEqual(subjects(root), ["reworded over an untracked file", "base"]);
  // The file is still there, untouched: nothing stashed it away.
  assert.equal(readFileSync(join(root, "scratch-note.txt"), "utf8"), "not committed, not staged\n");
});

test("refuses a starting commit that is not an ancestor of the branch", async () => {
  const root = repositoryWithCommits(["one"]);
  const repository = await discoverRepository(root, new GitRunner());
  git(root, "checkout", "-q", "-b", "side", "HEAD~1");
  writeFileSync(join(root, "side.txt"), "side\n");
  git(root, "add", "side.txt");
  git(root, "commit", "-qm", "side commit");
  const sideTip = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-");

  await assert.rejects(repository.interactiveRebaseCandidates(sideTip), /ancestor of the current branch/);
});

test("refuses a range whose history contains a merge", async () => {
  const root = repositoryWithCommits(["one"]);
  const repository = await discoverRepository(root, new GitRunner());
  const trunk = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "side");
  writeFileSync(join(root, "side.txt"), "side\n");
  git(root, "add", "side.txt");
  git(root, "commit", "-qm", "side commit");
  git(root, "checkout", "-q", "-");
  writeFileSync(join(root, "trunk.txt"), "trunk\n");
  git(root, "add", "trunk.txt");
  git(root, "commit", "-qm", "trunk commit");
  git(root, "merge", "-q", "--no-ff", "-m", "merge side", "side");

  await assert.rejects(repository.interactiveRebaseCandidates(trunk), /merge commit\(s\), which an interactive rebase would flatten/);
});

test("pauses on a conflict and can still finish from the persisted plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-irebase-conflict-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "shared.txt"), "base\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-qm", "base");
  writeFileSync(join(root, "shared.txt"), "first\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-qm", "one");
  writeFileSync(join(root, "shared.txt"), "second\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-qm", "two");

  const repository = await discoverRepository(root, new GitRunner());
  const candidates = await repository.interactiveRebaseCandidates("HEAD~2");
  // Swapping two edits to the same line makes the replayed commits conflict.
  await assert.rejects(repository.interactiveRebase("HEAD~2", [
    { oid: candidates[1].hash, subject: "two", action: "pick" },
    { oid: candidates[0].hash, subject: "one", action: "reword", message: "one, reworded" },
  ]));
  assert.equal((await repository.operationState()).kind, "rebase");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if ((await repository.operationState()).kind === "none") break;
    writeFileSync(join(root, "shared.txt"), `resolved ${attempt}\n`);
    git(root, "add", "shared.txt");
    try {
      await repository.continueOperation("rebase");
    } catch {
      // A later commit in the plan can conflict too; the loop resolves each pause.
    }
  }

  assert.equal((await repository.operationState()).kind, "none");
  // The exec line's message file survived the pause, so the reword still applied.
  assert.deepEqual(subjects(root), ["one, reworded", "two", "base"]);
});
