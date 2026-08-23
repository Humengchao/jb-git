import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalPath, deepestContaining, isPathInside } from "../dist/pathRouting.js";

test("routes a file to the deepest nested repository", () => {
  const items = [{ root: "/workspace" }, { root: "/workspace/packages/app" }];
  assert.equal(deepestContaining(items, "/workspace/packages/app/src/main.ts", (item) => item.root), items[1]);
  assert.equal(deepestContaining(items, "/workspace/packages/lib.ts", (item) => item.root), items[0]);
  assert.equal(deepestContaining(items, "/workspace-other/file.ts", (item) => item.root), undefined);
});

test("accepts in-repository names beginning with two dots", () => {
  const root = join(tmpdir(), "jb-git-routing-root");
  assert.equal(isPathInside(root, join(root, "..foo", "file.ts")), true);
  assert.equal(isPathInside(root, join(root, "..", "outside", "file.ts")), false);
});

test("canonicalizes paths below symlinked and deleted descendants", async () => {
  const root = mkdtempSync(join(tmpdir(), "jb-git-routing-"));
  const real = join(root, "real");
  mkdirSync(real);
  symlinkSync(real, join(root, "alias"));
  // realpathSync.native matches fsPromises.realpath (used by canonicalPath):
  // on Windows both expand 8.3 short names like RUNNER~1, the JS
  // implementation behind plain realpathSync does not.
  assert.equal(await canonicalPath(join(root, "alias", "missing", "file.ts")), join(realpathSync.native(real), "missing", "file.ts"));
});
