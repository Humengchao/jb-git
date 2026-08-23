import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  /** Maximum combined stdout/stderr retained in memory. Defaults to 64 MiB. */
  maxOutputBytes?: number;
  /** Maximum total command runtime in milliseconds. Defaults to 10 minutes. */
  timeoutMs?: number;
}

export interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface GitTraceEvent {
  cwd: string;
  args: readonly string[];
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const SENSITIVE_OPTION = /^(?:--?(?:password|passwd|token|access-token|auth|authorization|proxy-authorization|oauth-token|private-token|api-key|client-secret|private-key|credential))(?:=|$)/i;

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s?#@]+@/gi;
const SENSITIVE_QUERY_VALUE = /([?&#;](?:access[_-]?token|oauth[_-]?token|id[_-]?token|refresh[_-]?token|private[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|token|auth|authorization|signature|x-amz-signature)=)[^&#;\s"'<>]+/gi;
const AUTHORIZATION_HEADER = /(\b(?:proxy-authorization|authorization)\b\s*[:=]\s*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi;
const AUTH_SCHEME_VALUE = /(\b(?:bearer|basic)\s+)[a-z0-9._~+/=-]+/gi;
const SENSITIVE_KEY_VALUE = /((?:["']?)(?:password|passwd|access[_-]?token|oauth[_-]?token|id[_-]?token|refresh[_-]?token|private[_-]?token|api[_-]?key|client[_-]?secret|token|credential|auth|authorization|proxy-authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:bearer|basic)\s+[^\s,;&#]+|[^\s,;&#]+)/gi;

/** Removes credentials from command arguments and Git output before they reach UI or logs. */
export function redactGitText(value: string): string {
  return value
    // A username can itself be a personal access token, so redact the complete
    // URL userinfo rather than preserving the part before a colon.
    .replace(URL_USERINFO, "$1***@")
    .replace(SENSITIVE_QUERY_VALUE, "$1***")
    // Header values may contain an authentication scheme followed by the real
    // secret. Redact the complete header, including obsolete folded lines.
    .replace(AUTHORIZATION_HEADER, "$1***")
    .replace(SENSITIVE_KEY_VALUE, "$1***")
    .replace(AUTH_SCHEME_VALUE, "$1***");
}

export function redactGitArgs(args: readonly string[]): string[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "***";
    }
    if (SENSITIVE_OPTION.test(argument)) {
      if (!argument.includes("=")) redactNext = true;
      return argument.includes("=") ? `${argument.slice(0, argument.indexOf("=") + 1)}***` : argument;
    }
    return redactGitText(argument);
  });
}

/** Bytes of process output decoded for a trace preview before redaction. */
const TRACE_PREVIEW_BYTES = 16_000;
const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1_000;
const TERMINATION_GRACE_MS = 2_000;
const TERMINATION_SETTLE_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

/** Decodes only a small prefix for tracing so multi-megabyte output never runs through the redaction regexes. */
function tracePreview(output: Buffer | string): string {
  const truncated = output.length > TRACE_PREVIEW_BYTES;
  let text = Buffer.isBuffer(output) ? output.subarray(0, TRACE_PREVIEW_BYTES).toString("utf8") : output.slice(0, TRACE_PREVIEW_BYTES);
  // A credential straddling the cut would evade the redaction patterns, so
  // the tail of a truncated preview is dropped as well.
  if (truncated) text = text.slice(0, -200);
  return redactGitText(text).slice(0, 8_000);
}

/**
 * Environment for a spawned Git process. Repo-targeting variables that a
 * hook-launched editor may have inherited are stripped so commands act on the
 * requested cwd, and interactive credential prompts are disabled because no
 * terminal is attached. Explicit overrides always win.
 */
function gitProcessEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // GIT_EDITOR=true: nothing in this extension is interactive, and a command that opened
  // core.editor (e.g. `rebase --continue` with `code --wait`) would block forever while
  // holding the per-repository mutex.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true", ...overrides };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
    if (overrides?.[name] === undefined) delete env[name];
  }
  return env;
}

/** Marks the error raised when an AbortSignal stops a Git command, so callers can tell a deliberate cancellation from a failure. */
export class GitAbortError extends Error {
  public constructor() {
    super("Git command aborted");
    this.name = "GitAbortError";
  }
}

/** True when the user cancelled the operation rather than Git failing. */
export function isGitAbort(error: unknown): boolean {
  if (error instanceof GitAbortError) return true;
  return error instanceof GitCommandError && error.cause instanceof GitAbortError;
}

export class GitCommandError extends Error {
  public readonly exitCode: number | null;
  public readonly stderr: string;
  public readonly stdout: string;
  public readonly args: readonly string[];

  public constructor(args: readonly string[], result: Partial<GitResult> = {}, cause?: unknown) {
    const safeArgs = redactGitArgs(args);
    const stderr = redactGitText(result.stderr?.toString("utf8") ?? "");
    const stdout = redactGitText(result.stdout?.toString("utf8") ?? "");
    const detail = redactGitText(cause instanceof Error ? cause.message : stderr.trim() || stdout.trim() || "Git command failed");
    super(`git ${safeArgs.join(" ")}: ${detail}`);
    this.name = "GitCommandError";
    this.exitCode = result.exitCode ?? null;
    this.stderr = stderr;
    this.stdout = stdout;
    this.args = safeArgs;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Executes Git without passing a command through a shell. */
export class GitRunner {
  private readonly traceListeners = new Set<(event: GitTraceEvent) => void>();

  public constructor(public readonly gitPath = "git") {}

  public onDidRun(listener: (event: GitTraceEvent) => void): { dispose(): void } {
    this.traceListeners.add(listener);
    return { dispose: () => this.traceListeners.delete(listener) };
  }

  public run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    return new Promise<GitResult>((resolve, reject) => {
      // Validate before spawning: an invalid option must not leave an
      // unobserved child process running after this Promise rejects.
      const timeoutMs = normalizeTimeout(options.timeoutMs);
      const startedAt = new Date();
      const started = Date.now();
      let settled = false;
      let terminationError: Error | undefined;
      let closeResult: GitResult | undefined;
      let forceKillSent = false;
      let treeKillPending = 0;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let terminationSettleTimer: NodeJS.Timeout | undefined;
      let terminationPollTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      const child = spawn(this.gitPath, [...args], {
        cwd: options.cwd,
        env: gitProcessEnv(options.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // A separate process group lets POSIX cancellation reach hooks,
        // credential helpers, editors, and any other descendants as one unit.
        detached: process.platform !== "win32",
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const maximumOutput = options.maxOutputBytes ?? 64 * 1024 * 1024;

      const resultFromOutput = (exitCode = child.exitCode ?? -1): GitResult => ({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
      });

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (terminationSettleTimer) clearTimeout(terminationSettleTimer);
        if (terminationPollTimer) clearTimeout(terminationPollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        options.signal?.removeEventListener("abort", abort);
        callback();
      };

      const finishTermination = (result = closeResult ?? resultFromOutput()): void => {
        const error = terminationError;
        if (!error) return;
        finish(() => {
          this.emitTrace(args, options.cwd, startedAt, started, null, result.stdout, error.message);
          reject(new GitCommandError(args, result, error));
        });
      };

      const maybeFinishTermination = (): void => {
        if (settled || !terminationError || !closeResult || treeKillPending > 0) return;
        if (process.platform !== "win32" && !forceKillSent && processGroupExists(child.pid)) {
          if (!terminationPollTimer) {
            terminationPollTimer = setTimeout(() => {
              terminationPollTimer = undefined;
              maybeFinishTermination();
            }, 25);
            terminationPollTimer.unref();
          }
          return;
        }
        finishTermination(closeResult);
      };

      const killTree = (force: boolean): void => {
        treeKillPending += 1;
        void terminateProcessTree(child, force).finally(() => {
          treeKillPending -= 1;
          maybeFinishTermination();
        });
      };

      const terminate = (error: Error): void => {
        if (terminationError) return;
        terminationError = error;
        child.stdin.destroy();
        killTree(false);
        forceKillTimer = setTimeout(() => {
          forceKillSent = true;
          killTree(true);
        }, TERMINATION_GRACE_MS);
        forceKillTimer.unref();
        // Even a descendant that escaped the process group and inherited a
        // pipe must not keep this Promise (and a repository mutex) forever.
        terminationSettleTimer = setTimeout(() => {
          forceKillSent = true;
          killTree(true);
          child.stdout.destroy();
          child.stderr.destroy();
          finishTermination();
        }, TERMINATION_GRACE_MS + TERMINATION_SETTLE_MS);
        terminationSettleTimer.unref();
      };
      const remember = (target: Buffer[], chunk: Buffer): void => {
        if (settled || terminationError) return;
        const copy = Buffer.from(chunk);
        outputBytes += copy.length;
        if (outputBytes > maximumOutput) {
          terminate(new Error(`Git command output exceeded the ${maximumOutput}-byte safety limit`));
          return;
        }
        target.push(copy);
      };
      child.stdout.on("data", (chunk: Buffer) => remember(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => remember(stderr, chunk));
      child.on("error", (error) => {
        if (terminationError) {
          closeResult ??= resultFromOutput();
          maybeFinishTermination();
          return;
        }
        finish(() => {
          this.emitTrace(args, options.cwd, startedAt, started, null, "", error.message);
          reject(new GitCommandError(args, {}, error));
        });
      });
      child.on("close", (exitCode) => {
        const result = resultFromOutput(exitCode ?? -1);
        closeResult = result;
        if (terminationError) {
          maybeFinishTermination();
          return;
        }
        finish(() => {
          this.emitTrace(args, options.cwd, startedAt, started, result.exitCode, result.stdout, result.stderr);
          if (result.exitCode === 0) {
            resolve(result);
          } else {
            reject(new GitCommandError(args, result));
          }
        });
      });

      const abort = (): void => {
        terminate(new GitAbortError());
      };
      if (options.signal) {
        if (options.signal.aborted) {
          abort();
          return;
        }
        options.signal.addEventListener("abort", abort, { once: true });
      }
      timeoutTimer = setTimeout(() => {
        terminate(new Error(`Git command timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timeoutTimer.unref();

      child.stdin.on("error", () => {
        // A terminating child can close stdin before a pending write finishes.
      });
      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });
  }

  public async text(args: readonly string[], options: GitRunOptions): Promise<string> {
    const result = await this.run(args, options);
    return result.stdout.toString("utf8");
  }

  public async version(cwd: string): Promise<string> {
    return (await this.text(["--version"], { cwd })).trim();
  }

  private emitTrace(
    args: readonly string[], cwd: string, startedAt: Date, started: number,
    exitCode: number | null, stdout: Buffer | string, stderr: Buffer | string,
  ): void {
    if (this.traceListeners.size === 0) return;
    const event: GitTraceEvent = {
      cwd,
      args: redactGitArgs(args),
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - started,
      exitCode,
      stdout: tracePreview(stdout),
      stderr: tracePreview(stderr),
    };
    for (const listener of this.traceListeners) {
      try {
        listener(event);
      } catch {
        // Observability must never change the outcome of a Git command.
      }
    }
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_GIT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Git command timeoutMs must be a positive finite number");
  }
  return Math.min(Math.floor(timeoutMs), MAX_TIMER_MS);
}

function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // Fall back to the direct process even for ESRCH. That error can mean
      // process-group creation was unavailable rather than that the child is
      // already gone.
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
      return;
    }
  }

  // Node has no Windows Job Object API. taskkill is present on supported
  // Windows versions and /T walks the descendant tree before /F terminates it.
  await new Promise<void>((resolve) => {
    let finished = false;
    const complete = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const safetyTimer = setTimeout(() => {
      try { killer.kill(); } catch { /* already gone */ }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      complete();
    }, TERMINATION_SETTLE_MS);
    safetyTimer.unref();
    killer.once("error", () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      complete();
    });
    killer.once("close", complete);
  });
}
