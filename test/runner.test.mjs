import assert from "node:assert/strict";
import test from "node:test";
import { GitCommandError, redactGitArgs, redactGitText } from "../dist/git/runner.js";

test("redacts credentials in Git arguments and output", () => {
  const secret = "pat-super-secret";
  const url = `https://alice:${secret}@example.com/repo.git?access_token=${secret}`;
  const error = new GitCommandError(["clone", url, "--password", secret], {
    exitCode: 1,
    stderr: Buffer.from(`fatal: unable to access '${url}' Authorization: Bearer-${secret}`),
  });

  assert.equal(error.message.includes(secret), false);
  assert.equal(error.stderr.includes(secret), false);
  assert.equal(error.args.join(" ").includes(secret), false);
  assert.deepEqual(redactGitArgs(["--token=abc", "--password", "def"]), ["--token=***", "--password", "***"]);
  assert.equal(redactGitText("https://u:p@example.com/x"), "https://u:***@example.com/x");
});
