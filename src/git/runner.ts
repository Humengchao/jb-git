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
        env: { ...process.env, ...options.env },
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
          this.emitTrace(args, options.cwd, startedAt, started, terminationError ? null : result.exitCode, result.stdout.toString("utf8"), terminationMessage || result.stderr.toString("utf8"));
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
    exitCode: number | null, stdout: string, stderr: string,
  ): void {
    const event: GitTraceEvent = {
      cwd,
      args: redactGitArgs(args),
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - started,
      exitCode,
      stdout: redactGitText(stdout).slice(0, 8_000),
      stderr: redactGitText(stderr).slice(0, 8_000),
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
