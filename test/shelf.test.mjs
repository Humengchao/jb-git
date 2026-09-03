import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { panelHost, panelScript, readSource } from "./sourceText.mjs";

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

function readText(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "jb-git-shelf-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\nfour\nfive\n");
  git(root, "add", "f.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

test("a shelf that still fits is applied cleanly and left unstaged", async () => {
  const root = repository();
  writeFileSync(join(root, "f.txt"), "one\nTWO CHANGED\nthree\nfour\nfive\n");
  const repo = await discoverRepository(root, new GitRunner());
  const patch = join(root, "shelf.patch");
  writeFileSync(patch, (await repo.patch(["f.txt"])).toString("utf8"));
  git(root, "checkout", "-q", "--", "f.txt");

  assert.equal(await repo.applyPatchFileWithFallback(patch), "clean");
  assert.equal(readText(join(root, "f.txt")).split("\n")[1], "TWO CHANGED");
  // Restored changes stay out of the Index, as they were when shelved.
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("a shelf the branch moved past becomes a conflict to resolve, not an error", async () => {
  // Without the three-way fallback this left the user with a patch file and
  // Git's "patch does not apply", which is where IDEA offers a merge instead.
  const root = repository();
  writeFileSync(join(root, "f.txt"), "one\nTWO CHANGED\nthree\nfour\nfive\n");
  const repo = await discoverRepository(root, new GitRunner());
  const patch = join(root, "shelf.patch");
  writeFileSync(patch, (await repo.patch(["f.txt"])).toString("utf8"));
  git(root, "checkout", "-q", "--", "f.txt");
  // The same line moves on, so the patch cannot apply as-is.
  writeFileSync(join(root, "f.txt"), "one\ntwo edited elsewhere\nthree\nfour\nfive\n");
  git(root, "commit", "-qam", "moved on");

  assert.equal(await repo.applyPatchFileWithFallback(patch), "conflicted");
  const status = await repo.status();
  const conflicted = status.changes.filter((change) => change.conflicted).map((change) => change.path);
  assert.deepEqual(conflicted, ["f.txt"], "the conflict editor can take it from here");
  assert.match(readText(join(root, "f.txt")), /<<<<<<< /);

  // Conflicts that were already in the tree say nothing about the next patch:
  // a second, unappliable one must still fail rather than inherit this state.
  // (Checking the repository's whole unmerged list instead of the paths this
  // attempt added reported that patch as "applied with conflicts".)
  writeFileSync(patch, "diff --git a/ghost.txt b/ghost.txt\n--- a/ghost.txt\n+++ b/ghost.txt\n@@ -1 +1 @@\n-old\n+new\n");
  await assert.rejects(repo.applyPatchFileWithFallback(patch));
});

test("a fallback that merged cleanly leaves the restored changes unstaged, like a plain apply", async () => {
  // `--3way` implies `--index`, so without this the shelf's content came back
  // staged and a Commit of the staging area would have taken changes the user
  // never staged — while the plain path leaves everything unstaged.
  const root = mkdtempSync(join(tmpdir(), "jb-git-shelf-3way-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
  git(root, "add", "f.txt");
  git(root, "commit", "-qm", "base");

  writeFileSync(join(root, "f.txt"), "one\nTWO CHANGED\nthree\nfour\nfive\nsix\nseven\neight\n");
  const repo = await discoverRepository(root, new GitRunner());
  const patch = join(root, "shelf.patch");
  writeFileSync(patch, (await repo.patch(["f.txt"])).toString("utf8"));
  git(root, "checkout", "-q", "--", "f.txt");
  // A line inside the patch's context — but not the line it changes — moves
  // on. `git apply` wants exact context so the plain attempt fails, while the
  // three-way merge settles it without conflicts: the fallback this is about.
  writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\nfour\nFIVE CHANGED\nsix\nseven\neight\n");
  git(root, "commit", "-qam", "moved on");

  assert.equal(await repo.applyPatchFileWithFallback(patch, ["f.txt"]), "clean");
  const merged = readText(join(root, "f.txt")).split("\n");
  assert.equal(merged[1], "TWO CHANGED", "the shelved change came back");
  assert.equal(merged[4], "FIVE CHANGED", "and the branch's own change survived the merge");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "", "nothing was left staged");
  const status = await repo.status();
  assert.deepEqual(status.changes.filter((change) => change.path === "f.txt").map((change) => change.unstaged), [true]);
});

test("a shelf patch carries only tracked changes, so unshelving never resurrects an untracked file", async () => {
  // `git diff HEAD` ignores untracked files, which is why the shelve flow
  // filters them out before asking for a patch: a shelf that appeared to
  // include them would quietly lose them.
  const root = repository();
  writeFileSync(join(root, "f.txt"), "one\nTWO CHANGED\nthree\nfour\nfive\n");
  writeFileSync(join(root, "untracked.txt"), "never shelved\n");
  const repo = await discoverRepository(root, new GitRunner());

  const patch = (await repo.patch(["f.txt", "untracked.txt"])).toString("utf8");
  assert.match(patch, /a\/f\.txt/);
  assert.equal(patch.includes("untracked.txt"), false);
});

test("the Shelf tab has IDEA's actions and only deletes an entry it fully restored", () => {
  const script = panelScript(import.meta.url);
  const menu = script.slice(script.indexOf("function shelfMenuItems(shelf)"), script.indexOf("function consolePanel()"));
  assert.match(menu, /label: 'Unshelve', run: \(\) => post\('unshelve', \{ id: shelf\.id \}\)/);
  assert.match(menu, /label: 'Unshelve and Keep', run: \(\) => post\('unshelve', \{ id: shelf\.id, keep: true \}\)/);
  assert.match(menu, /label: 'Unshelve into Changelist…'/);
  assert.match(menu, /post\('unshelve', \{ id: shelf\.id, listId: list\.id \}\)/);
  assert.match(menu, /label: 'Show Diff', run: \(\) => post\('showShelfDiff', \{ id: shelf\.id \}\)/);
  assert.match(menu, /label: 'Rename…', run: \(\) => post\('renameShelf', \{ id: shelf\.id \}\)/);
  // The rows list what a shelf holds, expandable like every other group here.
  const pane = script.slice(script.indexOf("function shelfPanel()"), script.indexOf("function shelfMenuItems(shelf)"));
  assert.match(pane, /saveUiState\(\{ expandedShelves: \[\.\.\.expanded\] \}\); render\(\);/);
  assert.match(pane, /for \(const file of shelf\.paths\)/);

  const host = panelHost(import.meta.url);
  const shelf = host.slice(host.indexOf('message.type === "applyShelf" || message.type === "unshelve"'), host.indexOf('the commit form\'s message conveniences'));
  // A conflicted restore keeps the entry: it is the only complete copy left.
  const conflictAt = shelf.indexOf('if (outcome === "conflicted")');
  const removeAt = shelf.indexOf("if (!keep) await this.shelves.remove(root, entry);");
  assert.ok(conflictAt >= 0 && removeAt > conflictAt, "the conflict path returns before anything is deleted");
  assert.match(shelf, /const keep = message\.type !== "unshelve" \|\| message\.keep === true;/, "the old applyShelf button keeps the entry");
  assert.match(shelf, /for \(const file of entry\.paths\) await this\.changelists\.assign\(root, file, listId\);/);
  assert.match(shelf, /await requireTrusted\(\)/);

  const store = readSource("../src/shelves/store.ts", import.meta.url);
  assert.match(store, /public async apply\(repository: GitRepository, entry: ShelfEntry\): Promise<"clean" \| "conflicted">/);
  // The entry's own paths, so a cleanly-merged fallback does not leave them staged.
  assert.match(store, /applyPatchFileWithFallback\(this\.patchPath\(repository\.info\.rootPath, entry\), entry\.paths\)/);
  assert.match(store, /public async rename\(repositoryRoot: string, entry: ShelfEntry, name: string\)/);
  // Renaming rewrites the metadata only, so the patch file keeps its id.
  assert.match(store, /const renamed: ShelfEntry = \{ \.\.\.entry, name: trimmed \};/);
});

test("shelf metadata is validated before it can steer a file operation", () => {
  // Entries are read back from disk and then decide which file `apply` reads
  // and `remove` deletes, so a hand-edited or corrupt one must not be able to
  // point either of them outside the shelf directory.
  const store = readSource("../src/shelves/store.ts", import.meta.url);
  assert.match(store, /const SHELF_ID = \/\^\[0-9\]\+-\[a-z0-9\]\+\$\//);
  assert.match(store, /if \(usableEntry\(entry, name, directory\)\) entries\.push\(entry\);/);
  const check = store.slice(store.indexOf("function usableEntry("), store.indexOf("async function unlinkIfPresent("));
  // The id has to be the generated shape and name the file it came from.
  assert.match(check, /!SHELF_ID\.test\(entry\.id\) \|\| `\$\{entry\.id\}\.json` !== fileName/);
  assert.match(check, /Array\.isArray\(entry\.paths\) \|\| entry\.paths\.some\(\(item\) => typeof item !== "string"\)/);
  // A patch file anywhere else is not this store's to touch.
  assert.match(check, /path\.dirname\(path\.resolve\(entry\.patchFile\)\) === path\.resolve\(directory\)/);
  // The same rule decides where a patch is read from and deleted.
  const patchPath = store.slice(store.indexOf("private patchPath("), store.indexOf("private repositoryDirectory("));
  assert.match(patchPath, /if \(entry\.patchFile === own && existsSync\(entry\.patchFile\)\) return entry\.patchFile;/);
});
