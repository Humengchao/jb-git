import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitCommandError, GitRunner, redactGitArgs, redactGitText } from "../dist/git/runner.js";

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition was not met within ${timeoutMs} ms`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

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
  assert.equal(redactGitText("https://u:p@example.com/x"), "https://***@example.com/x");
  assert.equal(redactGitText("https://pat-secret@example.com/x"), "https://***@example.com/x");
});

test("redacts authorization headers and common token encodings without leaving the credential value", () => {
  const secret = "runner-secret.ABC_123+/=";
  const samples = [
    `Authorization: Bearer ${secret}`,
    `Proxy-Authorization: Basic ${secret}`,
    `http.extraHeader=Authorization: Bearer ${secret}`,
    `Bearer ${secret}`,
    `https://oauth2:${secret}@example.com/repository.git`,
    `https://${secret}@example.com/repository.git`,
    `https://example.com/repository.git?token=${secret}&page=1`,
    `https://example.com/repository.git?private_token=${secret}`,
    `{"authorization":"Bearer ${secret}","api_key":"${secret}"}`,
    `password=${secret}`,
  ];

  for (const sample of samples) {
    assert.equal(redactGitText(sample).includes(secret), false, sample);
  }
  assert.equal(redactGitArgs(["-c", `http.extraHeader=Proxy-Authorization: Basic ${secret}`]).join(" ").includes(secret), false);
  assert.equal(redactGitArgs(["--client-secret", secret]).join(" ").includes(secret), false);
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

test("bounds captured process output", async () => {
  const runner = new GitRunner(process.execPath);
  await assert.rejects(
    runner.text(["-e", "process.stdout.write('x'.repeat(100000))"], { cwd: process.cwd(), maxOutputBytes: 1024 }),
    /output exceeded the 1024-byte safety limit/,
  );
});

test("bounds decoded output retained on a large command error", () => {
  const error = new GitCommandError(["test"], { stderr: Buffer.alloc(2 * 1024 * 1024, "x") });
  assert.ok(error.stderr.length < 70 * 1024, "error text should not duplicate multi-megabyte process output");
  assert.match(error.stderr, /output truncated/);
});

test("waits for an aborted child to close and emits one trace", async () => {
  const runner = new GitRunner(process.execPath);
  const controller = new AbortController();
  const traces = [];
  runner.onDidRun((event) => traces.push(event));
  const running = runner.text(["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, /Git command aborted/);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].exitCode, null);
});

test("applies a total runtime limit and remains usable after timing out", async () => {
  const runner = new GitRunner(process.execPath);
  const traces = [];
  runner.onDidRun((event) => traces.push(event));
  await assert.rejects(
    runner.text(["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), timeoutMs: 50 }),
    /Git command timed out after 50 ms/,
  );
  assert.equal(traces.length, 1);
  assert.equal(traces[0].exitCode, null);
  assert.match(traces[0].stderr, /timed out after 50 ms/);
  assert.equal(await runner.text(["-e", "process.stdout.write('ok')"], { cwd: process.cwd(), timeoutMs: 1_000 }), "ok");
});

for (const termination of ["abort", "timeout"]) {
  test(`${termination} terminates descendant processes as well as the direct child`, async () => {
    const root = mkdtempSync(join(tmpdir(), `jb-git-${termination}-tree-`));
    const pidFile = join(root, "descendant.pid");
    const runner = new GitRunner(process.execPath);
    const controller = new AbortController();
    let descendantPid;
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const running = runner.text(["-e", parentScript, pidFile], {
      cwd: root,
      signal: controller.signal,
      timeoutMs: termination === "timeout" ? 1_000 : 5_000,
    });
    const rejected = assert.rejects(
      running,
      termination === "timeout" ? /timed out after 1000 ms/ : /Git command aborted/,
    );

    try {
      await waitFor(() => existsSync(pidFile));
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      assert.equal(Number.isInteger(descendantPid) && descendantPid > 0, true);
      assert.equal(processExists(descendantPid), true);
      if (termination === "abort") controller.abort();
      await rejected;
      await waitFor(() => !processExists(descendantPid));
    } finally {
      controller.abort();
      if (descendantPid && processExists(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("never lets a git subcommand open an interactive editor", async () => {
  // `rebase --continue` and friends pass no --no-edit; with core.editor = "code --wait" the
  // git process would block forever while holding the per-repository mutex.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "jb-git-editor-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: root });
  // An editor that would hang forever if launched, and prove it ran by creating a file.
  execFileSync("git", ["config", "core.editor", `touch ${join(root, "EDITOR_RAN")} && sleep 600`], { cwd: root });
  writeFileSync(join(root, "a.txt"), "one\n");
  execFileSync("git", ["add", "a.txt"], { cwd: root });

  const runner = new GitRunner();
  // Plain `git commit` without -m consults the editor; GIT_EDITOR=true must preempt it.
  await runner.run(["commit", "--allow-empty-message", "-m", ""], { cwd: root });
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(root, "EDITOR_RAN")), false, "the configured editor must never launch");
  const { readSource } = await import("./sourceText.mjs");
  assert.match(readSource("../src/git/runner.ts", import.meta.url), /GIT_EDITOR: "true"/);
});

test("keeps the event loop alive until a terminated command settles", async () => {
  const { readSource } = await import("./sourceText.mjs");
  const source = readSource("../src/git/runner.ts", import.meta.url);
  // Once termination starts, the child's own handles can disappear at any
  // moment, and these timers are the only remaining route to settling the
  // Promise. Unref'ing one lets the loop drain with the Promise pending, which
  // in the extension host would strand a repository mutex forever.
  for (const timer of ["forceKillTimer", "terminationSettleTimer", "terminationPollTimer", "safetyTimer"]) {
    assert.ok(
      !new RegExp(`${timer}\\.unref\\(\\)`).test(source),
      `${timer} must not be unref'd: it is on the path that settles a terminated command`,
    );
  }
  // Each one is still cleared on the settle path, so none outlives its command.
  assert.match(source, /if \(forceKillTimer\) clearTimeout\(forceKillTimer\)/);
  assert.match(source, /if \(terminationSettleTimer\) clearTimeout\(terminationSettleTimer\)/);
  assert.match(source, /if \(terminationPollTimer\) clearTimeout\(terminationPollTimer\)/);
  assert.match(source, /clearTimeout\(safetyTimer\)/);
});
