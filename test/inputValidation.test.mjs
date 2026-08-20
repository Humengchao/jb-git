import assert from "node:assert/strict";
import test from "node:test";
import { validateGitRefName, validatePathInput, validateRemoteName } from "../dist/inputValidation.js";

test("validates Git names before an operation starts", () => {
  assert.equal(validateGitRefName("feature/usable-name"), undefined);
  assert.match(validateGitRefName("bad branch"), /cannot contain/);
  assert.match(validateGitRefName("topic..old"), /cannot contain/);
  assert.equal(validateGitRefName("", true), undefined);
  assert.equal(validateRemoteName("origin"), undefined);
  assert.match(validateRemoteName("bad remote"), /without spaces/);
  assert.equal(validatePathInput("../worktree"), undefined);
  assert.match(validatePathInput("bad\npath"), /line breaks/);
});
