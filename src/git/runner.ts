import { spawn } from "node:child_process";

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  /** Maximum combined stdout/stderr retained in memory. Defaults to 64 MiB. */
  maxOutputBytes?: number;
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

const SENSITIVE_OPTION = /^(?:--?(?:password|passwd|token|access-token|auth|authorization|oauth-token|private-key))(?:=|$)/i;

/** Removes credentials from command arguments and Git output before they reach UI or logs. */
export function redactGitText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1***@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+@/gi, "$1***@")
    .replace(/([?&](?:access_?token|auth|authorization|oauth_?token|password)=)[^&#\s]+/gi, "$1***")
    .replace(/((?:authorization|password|access[_-]?token|oauth[_-]?token)\s*[:=]\s*)(?!\*\*\*)[^\s,;]+/gi, "$1***");
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
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...overrides };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
    if (overrides?.[name] === undefined) delete env[name];
  }
  return env;
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
    const detail = cause instanceof Error ? cause.message : stderr.trim() || stdout.trim() || "Git command failed";
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
      const startedAt = new Date();
      const started = Date.now();
      let settled = false;
      let terminationError: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const child = spawn(this.gitPath, [...args], {
        cwd: options.cwd,
        env: gitProcessEnv(options.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const maximumOutput = options.maxOutputBytes ?? 64 * 1024 * 1024;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", abort);
        callback();
      };

      const terminate = (error: Error): void => {
        if (terminationError) return;
        terminationError = error;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        forceKillTimer.unref();
      };
      const remember = (target: Buffer[], chunk: Buffer): void => {
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
        finish(() => {
          this.emitTrace(args, options.cwd, startedAt, started, null, "", error.message);
          reject(new GitCommandError(args, {}, error));
        });
      });
      child.on("close", (exitCode) => {
        const result: GitResult = {
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: exitCode ?? -1,
        };
        finish(() => {
          const terminationMessage = terminationError?.message ?? "";
          this.emitTrace(args, options.cwd, startedAt, started, terminationError ? null : result.exitCode, result.stdout, terminationMessage || result.stderr);
          if (terminationError) {
            reject(new GitCommandError(args, result, terminationError));
          } else if (result.exitCode === 0) {
            resolve(result);
          } else {
            reject(new GitCommandError(args, result));
          }
        });
      });

      const abort = (): void => {
        terminate(new Error("Git command aborted"));
      };
      if (options.signal) {
        if (options.signal.aborted) {
          abort();
          return;
        }
        options.signal.addEventListener("abort", abort, { once: true });
      }

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
