import { spawn } from "node:child_process";

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
}

export interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

const SENSITIVE_OPTION = /^(?:--?(?:password|passwd|token|access-token|auth|authorization|oauth-token|private-key))(?:=|$)/i;

/** Removes credentials from command arguments and Git output before they reach UI or logs. */
export function redactGitText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1***@")
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
    const detail = stderr.trim() || stdout.trim() || "Git command failed";
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
  public constructor(public readonly gitPath = "git") {}

  public run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    return new Promise<GitResult>((resolve, reject) => {
      let settled = false;
      const child = spawn(this.gitPath, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };

      child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.on("error", (error) => {
        finish(() => reject(new GitCommandError(args, {}, error)));
      });
      child.on("close", (exitCode) => {
        const result: GitResult = {
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: exitCode ?? -1,
        };
        finish(() => {
          if (result.exitCode === 0) {
            resolve(result);
          } else {
            reject(new GitCommandError(args, result));
          }
        });
      });

      const abort = (): void => {
        child.kill();
        finish(() => reject(new GitCommandError(args, {}, new Error("Git command aborted"))));
      };
      if (options.signal) {
        if (options.signal.aborted) {
          abort();
          return;
        }
        options.signal.addEventListener("abort", abort, { once: true });
        child.once("close", () => options.signal?.removeEventListener("abort", abort));
      }

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
}
