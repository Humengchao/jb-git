import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FavoriteBranches, recentBranchesFromReflog } from "../dist/branchPopup.js";
import { discoverRepository } from "../dist/git/repository.js";
import { GitRunner } from "../dist/git/runner.js";
import { readSource } from "./sourceText.mjs";

function git(cwd, ...args) {
  const output = execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
  if (args[0] === "init") execFileSync("git", ["-C", cwd, "config", "core.autocrlf", "false"]);
  return output;
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "jb-git-branches-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "JB Git Test");
  git(root, "config", "user.email", "jb-git-test@example.invalid");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "first");
  return root;
}

/** A Memento stand-in: the store only needs get/update. */
function memento(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    update: async (key, value) => { values.set(key, value); },
    keys: () => [...values.keys()],
  };
}

test("recent branches come from checkout reflog entries, newest first, existing local branches only", () => {
  const subjects = [
    "commit: work on feature",
    "checkout: moving from main to feature",
    "checkout: moving from 1a2b3c4d to main",
    "checkout: moving from deleted-branch to 1a2b3c4d",
    "checkout: moving from main to deleted-branch",
    "checkout: moving from feature to main",
    "checkout: moving from main to feature",
    "checkout: moving from release/2 to main",
  ];
  const existing = new Set(["main", "feature", "release/2"]);
  // Both ends of a checkout were checked out at some point, newest first:
  // `feature` is the current branch, so it is not "recent"; a detached hash
  // and a branch that no longer exists are skipped; repeats collapse.
  assert.deepEqual(recentBranchesFromReflog(subjects, existing, "feature"), ["main", "release/2"]);
  assert.deepEqual(recentBranchesFromReflog(subjects, existing, "main", 1), ["feature"]);
  assert.deepEqual(recentBranchesFromReflog([], existing, "main"), []);
});

test("favorites are per repository, toggle, survive a malformed store and prune deleted branches", async () => {
  const store = new FavoriteBranches(memento({ "jbGit.favoriteBranches": { "/repo": ["local:main", 42, null] } }));
  assert.deepEqual(store.list("/repo"), ["local:main"], "non-strings in the persisted list are ignored");
  assert.equal(await store.toggle("/repo", "remote:origin/dev"), true);
  assert.equal(await store.toggle("/other", "local:x"), true);
  assert.deepEqual(store.list("/repo"), ["local:main", "remote:origin/dev"]);
  assert.equal(store.has("/other", "local:x"), true);
  assert.equal(await store.toggle("/repo", "local:main"), false);
  assert.deepEqual(store.list("/repo"), ["remote:origin/dev"]);
  await store.prune("/repo", new Set(["local:main"]));
  assert.deepEqual(store.list("/repo"), [], "a favorite that names nothing any more is forgotten");
  assert.deepEqual(new FavoriteBranches(memento({ "jbGit.favoriteBranches": "garbage" })).list("/repo"), []);
});

test("reads HEAD's reflog and fast-forwards a branch that is not checked out from its upstream", async () => {
  const root = repository();
  const remote = mkdtempSync(join(tmpdir(), "jb-git-branches-remote-"));
  // The bare remote's HEAD must name main, or the clone below lands on an unborn default branch.
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  git(root, "checkout", "-qb", "feature");
  git(root, "checkout", "-q", "main");
  const repo = await discoverRepository(root, new GitRunner());

  const subjects = await repo.reflogSubjects();
  assert.ok(subjects.includes("checkout: moving from feature to main"), subjects.join("\n"));
  assert.deepEqual(recentBranchesFromReflog(subjects, new Set(["main", "feature"]), "main"), ["feature"]);

  // Someone else advances origin/main while `feature` is checked out here.
  const other = mkdtempSync(join(tmpdir(), "jb-git-branches-other-"));
  git(other, "clone", "-q", remote, ".");
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.invalid");
  writeFileSync(join(other, "b.txt"), "b\n");
  git(other, "add", "b.txt");
  git(other, "commit", "-qm", "upstream work");
  git(other, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "feature");

  await repo.updateBranch("main");
  assert.equal(git(root, "rev-parse", "main"), git(other, "rev-parse", "main"), "main moved to the upstream commit without being checked out");
  assert.equal(git(root, "branch", "--show-current"), "feature");
  // The checked-out branch is a pull, not a fetch into it; a branch without an upstream has nothing to update from.
  await assert.rejects(repo.updateBranch("feature"), /checked out/);
  git(root, "branch", "-q", "lonely");
  await assert.rejects(repo.updateBranch("lonely"), /no upstream/);
});

test("the branches popup has IDEA's Recent and Favorites groups and a per-branch Update button", () => {
  const extension = readSource("../src/extension.ts", import.meta.url);
  const popup = extension.slice(extension.indexOf('registerCommand("jbGit.branchesPopup"'), extension.indexOf('registerCommand("jbGit.operationsPopup"'));
  assert.match(popup, /recentBranchesFromReflog\(await manager\.reflogSubjects\(root\)\.catch\(\(\) => \[\]\), localNames, current\)/);
  assert.match(popup, /await favoriteBranches\.prune\(root, existing\);/);
  // Starring keeps the popup open and redraws it; Update on the current branch is a pull.
  assert.match(popup, /await favoriteBranches\.toggle\(root, favoriteKey\(event\.item\.branch\)\);\s*\n\s*picker\.items = build\(\);/);
  assert.match(popup, /if \(selected\.branch\.name === current\) \{\s*\n\s*await vscode\.commands\.executeCommand\("jbGit\.pull", root\);/);
  assert.match(popup, /manager\.updateBranch\(root, selected\.branch!\.name\)/);
  // Only a local branch with a live upstream offers Update.
  assert.match(popup, /if \(branch\.kind === "local" && branch\.upstream && !branch\.upstreamGone\) buttons\.push\(updateButton\);/);
});

test("one favorites store serves both surfaces and tells its owner to redraw", () => {
  // A star toggled in the popup has to reach the Log's Branches pane, so the
  // store is created once and handed to the panel; the module stays free of
  // VS Code objects (the unit tests import it directly), so the notification
  // is a plain callback rather than an event emitter.
  const store = readSource("../src/branchPopup.ts", import.meta.url);
  assert.doesNotMatch(store, /^import \* as vscode/m);
  assert.match(store, /import type \{ Memento \} from "vscode";/);
  assert.match(store, /private readonly onChange\?: \(\) => void/);
  assert.equal(store.match(/this\.onChange\?\.\(\);/g)?.length, 2, "both toggle and prune notify");

  const extension = readSource("../src/extension.ts", import.meta.url);
  assert.match(extension, /const favoriteBranches = new FavoriteBranches\(context\.workspaceState, \(\) => gitToolWindow\.refreshView\(\)\);/);
  assert.match(extension, /new IntelliJGitToolWindowProvider\(manager, changelistStore, shelfStore, diffProvider, context\.workspaceState, favoriteBranches\)/);
});

test("the Log's Branches pane has IDEA's Recent and Favorites groups, a star and Update", () => {
  const panel = readSource("../src/webviews/logPanel.ts", import.meta.url);
  const script = panel.slice(panel.indexOf("const logScript = String.raw`"));
  const pane = script.slice(script.indexOf("function branchPane()"), script.indexOf("function refreshBranchPane()"));
  assert.match(pane, /appendSection\('Recent', recent, 'recent'\)/);
  assert.match(pane, /appendSection\('Favorites', \(state\.branches \|\| \[\]\)\.filter\(item => item\.kind !== 'tag' && isFavorite\(item\)/);
  // A row can appear in two groups, so its focus key has to distinguish them.
  assert.match(pane, /row\.dataset\.focusKey = 'branch:' \+ group \+ ':' \+ key;/);
  // The star is a span: a button inside a button would steal the row's click.
  assert.match(pane, /const star = node\('span', 'branch-star'/);
  assert.match(pane, /star\.addEventListener\('click', event => \{\s*\n\s*event\.stopPropagation\(\); event\.preventDefault\(\);/);
  assert.match(pane, /post\('toggleFavoriteBranch', \{ name: branch\.name, kind: branch\.kind \}\)/);
  // Only a branch with a live upstream can be updated; the current one is a pull.
  const menu = script.slice(script.indexOf("function branchContextItems"), script.indexOf("function branchPane()"));
  assert.match(menu, /if \(kind === 'local' && branch\.upstream && !branch\.upstreamGone\)/);
  assert.match(menu, /label: isCurrent \? 'Update Project…' : "Update '" \+ branch\.name \+ "'", run: act\('updateRef'\)/);

  const host = panel.slice(0, panel.indexOf("const logScript = String.raw`"));
  const update = host.slice(host.indexOf('message.action === "updateRef"'), host.indexOf('message.action === "checkoutAndRebase"'));
  assert.match(update, /if \(branch\.kind !== "local" \|\| !branch\.upstream \|\| branch\.upstreamGone\) return;/);
  assert.match(update, /executeCommand\("jbGit\.pull", root\)/);
  assert.match(update, /this\.manager\.updateBranch\(root, branch\.name\)/);
  // The reflog is only re-read when the refs moved, not on every refresh.
  assert.match(host, /private async recentBranches\(root: string, snapshot: RepositorySnapshot, refsKey: string\)/);
  assert.match(host, /if \(cached\?\.refsKey === refsKey\) return cached\.names;/);
  assert.match(host, /favoriteBranches: this\.favorites\.list\(root\),/);
});
