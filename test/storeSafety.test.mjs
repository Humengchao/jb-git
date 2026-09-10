import assert from "node:assert/strict";
import test from "node:test";
import { FavoriteBranches } from "../dist/branchPopup.js";
import { ChangelistStore } from "../dist/changelists/store.js";

function memento(initial) {
  let value = initial;
  return {
    get: () => value,
    update: async (_key, next) => {
      // Make overlapping read-modify-write calls observable. A store that does
      // not serialize them will let the later snapshot overwrite the earlier one.
      await new Promise((resolve) => setTimeout(resolve, 3));
      value = structuredClone(next);
    },
    value: () => value,
  };
}

test("serializes concurrent favorite toggles without losing a branch", async () => {
  const memory = memento({});
  const favorites = new FavoriteBranches(memory);
  await Promise.all([favorites.toggle("/repo", "alpha"), favorites.toggle("/repo", "beta")]);
  assert.deepEqual(favorites.list("/repo").sort(), ["alpha", "beta"]);
});

test("serializes concurrent changelist saves and preserves both edits", async () => {
  const memory = memento(undefined);
  const lists = new ChangelistStore(memory);
  await lists.load();
  const [first, second] = await Promise.all([
    lists.create("/repo", "First"),
    lists.create("/repo", "Second"),
  ]);
  assert.deepEqual(lists.lists("/repo").map((list) => list.id), ["default", first.id, second.id]);
  const persisted = memory.value().repositories["/repo"];
  assert.deepEqual(persisted.lists.map((list) => list.name), ["Default Changelist", "First", "Second"]);
});

test("sanitizes malformed persisted changelists before they steer file operations", async () => {
  const memory = memento({
    version: 1,
    repositories: {
      "/repo": {
        activeId: "missing",
        lists: [
          { id: "work", name: "  Work  ", files: ["a.txt", 42], hunks: { "good.txt": ["h1", 7], __proto__: ["bad"] } },
          { id: "work", name: "duplicate", files: ["ignored.txt"] },
          null,
        ],
      },
      __proto__: { activeId: "evil", lists: [] },
    },
  });
  const lists = new ChangelistStore(memory);
  await lists.load();
  assert.equal(lists.activeId("/repo"), "work");
  assert.deepEqual(lists.files("/repo", "work"), ["a.txt"]);
  assert.deepEqual(lists.claims("/repo", "good.txt").get("work"), ["h1"]);
  assert.equal(lists.lists("__proto__").length, 1);
});

test("moves individual lines between Changelists, and only releases them back home", async () => {
  const memory = memento(undefined);
  const lists = new ChangelistStore(memory);
  await lists.load();
  const bugfix = await lists.create("/repo", "Bugfix");
  await lists.setActive("/repo", "default");
  await lists.reconcile("/repo", [{ path: "a.txt" }]);

  await lists.assignLines("/repo", "a.txt", ["la:0", "lb:0"], bugfix.id);
  assert.deepEqual(lists.lineClaims("/repo", "a.txt").get(bugfix.id), ["la:0", "lb:0"]);
  // Each list's commit takes exactly its own lines.
  assert.deepEqual(lists.commitPlan("/repo", bugfix.id, ["a.txt"]).hunkSelections.get("a.txt"),
    { mode: "only", keys: [], lineKeys: ["la:0", "lb:0"] });
  assert.deepEqual(lists.commitPlan("/repo", "default", ["a.txt"]).hunkSelections.get("a.txt"),
    { mode: "except", keys: [], lineKeys: ["la:0", "lb:0"] });

  // Claiming a line for the file's own list releases it rather than recording.
  await lists.assignLines("/repo", "a.txt", ["la:0"], "default");
  assert.deepEqual(lists.lineClaims("/repo", "a.txt").get(bugfix.id), ["lb:0"]);
  assert.equal(lists.lineClaims("/repo", "a.txt").has("default"), false);

  // The claims persist across a reload.
  const reloaded = new ChangelistStore(memory);
  await reloaded.load();
  assert.deepEqual(reloaded.lineClaims("/repo", "a.txt").get(bugfix.id), ["lb:0"]);

  // And vanish once the change they name is gone.
  await reloaded.reconcileLines("/repo", "a.txt", ["lc:0"]);
  assert.equal(reloaded.lineClaims("/repo", "a.txt").size, 0);
});

test("a removed Changelist's line claims fall back with its files, unless the fallback owns the file", async () => {
  const memory = memento(undefined);
  const lists = new ChangelistStore(memory);
  await lists.load();
  const feature = await lists.create("/repo", "Feature");
  const bugfix = await lists.create("/repo", "Bugfix");
  await lists.reconcile("/repo", [{ path: "a.txt" }]);
  // a.txt's home is the feature list (active when reconciled); bugfix claimed lines of it.
  await lists.assign("/repo", "a.txt", feature.id);
  await lists.assignLines("/repo", "a.txt", ["la:0"], bugfix.id);

  await lists.remove("/repo", bugfix.id);
  assert.deepEqual(lists.lineClaims("/repo", "a.txt").get("default"), ["la:0"],
    "the fallback inherits the claims of the removed list");
});

test("moving a whole file drops its line claims, and a rename carries them along", async () => {
  const memory = memento(undefined);
  const lists = new ChangelistStore(memory);
  await lists.load();
  const bugfix = await lists.create("/repo", "Bugfix");
  await lists.setActive("/repo", "default");
  await lists.reconcile("/repo", [{ path: "a.txt" }]);
  await lists.assignLines("/repo", "a.txt", ["la:0"], bugfix.id);

  // The file's rename migrates the claim to the new path.
  await lists.reconcile("/repo", [{ path: "b.txt", originalPath: "a.txt" }]);
  assert.deepEqual(lists.lineClaims("/repo", "b.txt").get(bugfix.id), ["la:0"]);
  assert.equal(lists.lineClaims("/repo", "a.txt").size, 0);

  // A whole-file move is a decision about all of it, so the claims end.
  await lists.assign("/repo", "b.txt", "default");
  assert.equal(lists.lineClaims("/repo", "b.txt").size, 0);
});

test("sanitizes malformed persisted line claims the way it does hunk claims", async () => {
  const memory = memento({
    version: 1,
    repositories: {
      "/repo": {
        activeId: "work",
        lists: [
          { id: "work", name: "Work", files: [], lines: { "a.txt": ["la:0", 7, ""], "b.txt": [] } },
        ],
      },
    },
  });
  const lists = new ChangelistStore(memory);
  await lists.load();
  assert.deepEqual(lists.lineClaims("/repo", "a.txt").get("work"), ["la:0"]);
  assert.equal(lists.lineClaims("/repo", "b.txt").size, 0);
});
