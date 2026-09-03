import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { readSource } from "./sourceText.mjs";

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

const lines = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

function repository() {
  const root = mkdtempSync(join(tmpdir(), "jb-git-local-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "f.txt"), `${lines(20).join("\n")}\n`);
  writeFileSync(join(root, "other.txt"), "other\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}

function readText(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

test("rolls back one working-tree hunk, leaving the file's other changes and the Index alone", async () => {
  const root = repository();
  // Two changes far enough apart to be separate hunks, plus a staged change.
  const edited = lines(20);
  edited[1] = "SECOND CHANGED";
  edited[18] = "NINETEENTH CHANGED";
  writeFileSync(join(root, "f.txt"), `${edited.join("\n")}\n`);
  writeFileSync(join(root, "other.txt"), "staged change\n");
  git(root, "add", "other.txt");
  const repo = await discoverRepository(root, new GitRunner());

  const hunks = await repo.diffHunks("f.txt");
  assert.equal(hunks.length, 2, "the two edits are separate hunks");

  await repo.rollbackHunk("f.txt", hunks[0]);

  const after = readText(join(root, "f.txt")).split("\n");
  assert.equal(after[1], "line 2", "the rolled-back hunk is back to HEAD");
  assert.equal(after[18], "NINETEENTH CHANGED", "the file's other change survives");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "other.txt", "the staged change is untouched");
  assert.equal((await repo.diffHunks("f.txt")).length, 1);

  // A hunk that moved on since it was displayed is refused rather than applied
  // to whatever is there now.
  await assert.rejects(repo.rollbackHunk("f.txt", hunks[0]), /changed since it was displayed/);
});

test("a hunk the user also staged keeps its staged copy when the working tree is rolled back", async () => {
  const root = repository();
  const edited = lines(20);
  edited[1] = "SECOND CHANGED";
  writeFileSync(join(root, "f.txt"), `${edited.join("\n")}\n`);
  git(root, "add", "f.txt");
  // Stage that change, then edit the same line again in the working tree.
  const again = [...edited];
  again[1] = "SECOND CHANGED TWICE";
  writeFileSync(join(root, "f.txt"), `${again.join("\n")}\n`);
  const repo = await discoverRepository(root, new GitRunner());

  const unstaged = await repo.diffHunks("f.txt");
  assert.equal(unstaged.length, 1);
  await repo.rollbackHunk("f.txt", unstaged[0]);

  // Rollback means "back to the Index", not "unstage": the staged version stays.
  assert.equal(readText(join(root, "f.txt")).split("\n")[1], "SECOND CHANGED");
  const staged = await repo.diffHunks("f.txt", true);
  assert.equal(staged.length, 1, "the staged hunk is still staged");
});

test("creates an applicable patch from the local changes, including what is staged", async () => {
  const root = repository();
  const edited = lines(20);
  edited[3] = "FOURTH CHANGED";
  writeFileSync(join(root, "f.txt"), `${edited.join("\n")}\n`);
  writeFileSync(join(root, "other.txt"), "changed and staged\n");
  git(root, "add", "other.txt");
  writeFileSync(join(root, "added.txt"), "brand new\n");
  git(root, "add", "added.txt");
  const repo = await discoverRepository(root, new GitRunner());

  const patch = await repo.localChangesPatch(["f.txt", "other.txt", "added.txt"]);
  assert.match(patch, /^diff --git a\/added\.txt b\/added\.txt$/m, "the a/ b/ prefixes keep the patch at -p1");
  assert.match(patch, /FOURTH CHANGED/);
  assert.match(patch, /changed and staged/, "a staged change is part of the patch");

  // The real proof: a clean clone of HEAD accepts it and ends up identical.
  const elsewhere = mkdtempSync(join(tmpdir(), "jb-git-local-apply-"));
  git(elsewhere, "clone", "-q", root, ".");
  git(elsewhere, "checkout", "-q", git(root, "rev-parse", "HEAD"));
  writeFileSync(join(elsewhere, "incoming.patch"), patch);
  git(elsewhere, "apply", "incoming.patch");
  assert.equal(readText(join(elsewhere, "f.txt")), readText(join(root, "f.txt")));
  assert.equal(readText(join(elsewhere, "other.txt")), readText(join(root, "other.txt")));
  assert.equal(readText(join(elsewhere, "added.txt")), "brand new\n");

  await assert.rejects(repo.localChangesPatch([]), /at least one change/);
});

test("Local Changes offers per-hunk Rollback and Create Patch, with the destructive one confirmed and backed up", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panel.slice(panel.indexOf("const logScript = String.raw`"));
  // Only a working-tree hunk: taking a staged one back is Unstage, not Rollback.
  assert.match(script, /if \(source === 'unstaged'\) \{\s*\n\s*header\.append\(button\('Rollback', 'Rollback this change'/);
  assert.match(script, /post\('rollbackHunk', \{ path: change\.path, index \}\)/);
  assert.match(script, /button\('Create Patch…', 'Save the selected changes as a patch file', \(\) => post\('createLocalPatch'\)/);

  const host = panel.slice(0, panel.indexOf("const logScript = String.raw`"));
  const rollback = host.slice(host.indexOf('message.type === "rollbackHunk"'), host.indexOf('message.type === "createLocalPatch"'));
  assert.match(rollback, /change\.conflicted \|\| change\.kind === "untracked"/);
  assert.match(rollback, /confirmDiscard/, "the same setting that gates a file rollback gates this one");
  assert.match(rollback, /modal: true/);
  // The README's promise: nothing tracked is thrown away without a recovery entry.
  const shelfAt = rollback.indexOf("await this.shelves.create(");
  const rollbackAt = rollback.indexOf("await this.manager.rollbackHunk(");
  assert.ok(shelfAt >= 0 && rollbackAt > shelfAt, "the recovery shelf is written before the change is discarded");
  const patch = host.slice(host.indexOf('message.type === "createLocalPatch"'), host.indexOf('message.type === "toggleFavoriteBranch"'));
  assert.match(patch, /selected\.has\(change\.path\) && !change\.conflicted/);
  assert.match(patch, /change\.originalPath \? \[change\.originalPath\] : \[\]/, "a rename needs both of its paths in the patch");
  assert.match(patch, /localChangesPatch\(root, \[\.\.\.new Set\(paths\)\]\)/);
});
