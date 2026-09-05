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
