import assert from "node:assert/strict";
import test from "node:test";
import { GitCommandError, GitRunner, redactGitArgs, redactGitText } from "../dist/git/runner.js";

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
  assert.equal(redactGitText("https://pat-secret@example.com/x"), "https://***@example.com/x");
});

test("redacts credentials before emitting Git console traces", async () => {
  const secret = "trace-secret";
  const url = `https://alice:${secret}@example.com/repo.git?access_token=${secret}`;
  const runner = new GitRunner(process.execPath);
  let trace;
  const subscription = runner.onDidRun((event) => { trace = event; });
  try {
    await runner.text(["-e", "process.stdout.write(process.argv[1])", url], { cwd: process.cwd() });
  } finally {
    subscription.dispose();
  }
  assert.ok(trace);
  assert.equal(trace.args.join(" ").includes(secret), false);
  assert.equal(trace.stdout.includes(secret), false);
});

test("does not let a Git console listener break command execution", async () => {
  const runner = new GitRunner(process.execPath);
  runner.onDidRun(() => { throw new Error("trace listener failed"); });
  const output = await runner.text(["-e", "process.stdout.write('ok')"], { cwd: process.cwd() });
  assert.equal(output, "ok");
});
