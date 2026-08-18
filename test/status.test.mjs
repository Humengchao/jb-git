import assert from "node:assert/strict";
import test from "node:test";
import { parsePorcelainV2 } from "../dist/git/status.js";

test("parses branch metadata and common change records", () => {
  const output = [
    "# branch.oid abc123",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 abc123 def456 src/app.ts",
    "1 .M N... 100644 100644 100644 abc123 def456 path with spaces.txt",
    "2 R. N... 100644 100644 100644 abc123 def456 R100 renamed.ts",
    "old-name.ts",
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc ddd conflicted.ts",
    "? new file.txt",
  ].join("\0") + "\0";

  const snapshot = parsePorcelainV2(output);

  assert.deepEqual(snapshot.branch, {
    head: "main",
    oid: "abc123",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  });
  assert.equal(snapshot.changes.length, 5);
  assert.equal(snapshot.changes[0].staged, true);
  assert.equal(snapshot.changes[0].unstaged, false);
  assert.equal(snapshot.changes[1].kind, "modified");
  assert.equal(snapshot.changes[2].kind, "renamed");
  assert.equal(snapshot.changes[2].originalPath, "old-name.ts");
  assert.equal(snapshot.changes[3].kind, "conflicted");
  assert.equal(snapshot.changes[4].kind, "untracked");
  assert.equal(snapshot.changes[4].path, "new file.txt");
});

test("parses an initial detached repository", () => {
  const snapshot = parsePorcelainV2([
    "# branch.oid (initial)",
    "# branch.head (detached)",
    "? README.md",
    "",
  ].join("\0"));

  assert.equal(snapshot.branch.oid, null);
  assert.equal(snapshot.branch.head, null);
  assert.equal(snapshot.changes[0].kind, "untracked");
});

test("treats every porcelain v2 unmerged record as conflicted", () => {
  for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    const snapshot = parsePorcelainV2(`u ${xy} N... 100644 100644 100644 100644 a b c conflict-${xy}.txt\0`);
    assert.equal(snapshot.changes.length, 1);
    assert.equal(snapshot.changes[0].kind, "conflicted", xy);
    assert.equal(snapshot.changes[0].conflicted, true, xy);
  }
});
