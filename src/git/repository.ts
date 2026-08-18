import * as path from "node:path";
import { GitCommandError, GitRunner } from "./runner";
import { parsePorcelainV2 } from "./status";
import { GitBranch, GitRepositoryInfo, GitStatusSnapshot } from "./types";

function trimOutput(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

function resolveGitDir(rootPath: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.normalize(path.resolve(rootPath, value));
}

export class GitRepository {
  private operationPromise: Promise<unknown> = Promise.resolve();

  public constructor(
    public readonly info: GitRepositoryInfo,
    private readonly runner: GitRunner,
  ) {}

  public async status(signal?: AbortSignal): Promise<GitStatusSnapshot> {
    const result = await this.runner.run(
      ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
      { cwd: this.info.rootPath, signal },
    );
    return parsePorcelainV2(result.stdout);
  }

  public async branches(signal?: AbortSignal): Promise<GitBranch[]> {
    const output = await this.runner.text(
      [
        "for-each-ref",
        "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      { cwd: this.info.rootPath, signal },
    );
    const branches: GitBranch[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [refName, name, oid, upstream, tracking] = line.split("\0");
      const kind: GitBranch["kind"] = refName.startsWith("refs/tags/")
        ? "tag"
        : refName.startsWith("refs/remotes/")
          ? "remote"
          : "local";
      branches.push({
        name,
        oid,
        kind,
        upstream: upstream || undefined,
        tracking: tracking || undefined,
      });
    }
    return branches;
  }

  public async stage(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["add", "--", ...paths], { cwd: this.info.rootPath }));
  }

  public async unstage(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["reset", "HEAD", "--", ...paths], { cwd: this.info.rootPath }));
  }

  public async discard(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["restore", "--worktree", "--", ...paths], { cwd: this.info.rootPath }));
  }

  public async fetch(): Promise<void> {
    await this.serial(() => this.runner.run(["fetch", "--all", "--prune"], { cwd: this.info.rootPath }));
  }

  public async checkout(branch: string): Promise<void> {
    await this.serial(async () => {
      const isRemote = await this.hasRef(`refs/remotes/${branch}`);
      const hasLocal = await this.hasRef(`refs/heads/${branch}`);
      await this.runner.run(
        isRemote && !hasLocal ? ["switch", "--track", branch] : ["switch", branch],
        { cwd: this.info.rootPath },
      );
    });
  }

  public async init(): Promise<void> {
    await this.serial(() => this.runner.run(["init"], { cwd: this.info.rootPath }));
  }

  public async currentRevision(): Promise<string | null> {
    try {
      return trimOutput(await this.runner.text(["rev-parse", "HEAD"], { cwd: this.info.rootPath }));
    } catch (error) {
      if (error instanceof GitCommandError) return null;
      throw error;
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationPromise;
    let release!: () => void;
    this.operationPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async hasRef(ref: string): Promise<boolean> {
    try {
      await this.runner.run(["show-ref", "--verify", "--quiet", ref], { cwd: this.info.rootPath });
      return true;
    } catch (error) {
      if (error instanceof GitCommandError) return false;
      throw error;
    }
  }
}

export async function discoverRepository(
  workspacePath: string,
  runner: GitRunner,
  signal?: AbortSignal,
): Promise<GitRepository | null> {
  try {
    const rootPath = trimOutput(await runner.text(["rev-parse", "--show-toplevel"], { cwd: workspacePath, signal }));
    const gitDirRaw = trimOutput(await runner.text(["rev-parse", "--git-dir"], { cwd: workspacePath, signal }));
    const commonGitDirRaw = trimOutput(await runner.text(["rev-parse", "--git-common-dir"], { cwd: workspacePath, signal }));
    const isBare = trimOutput(await runner.text(["rev-parse", "--is-bare-repository"], { cwd: workspacePath, signal })) === "true";
    return new GitRepository(
      {
        rootPath: path.normalize(rootPath),
        gitDir: resolveGitDir(rootPath, gitDirRaw),
        commonGitDir: resolveGitDir(rootPath, commonGitDirRaw),
        isBare,
      },
      runner,
    );
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
}

export async function discoverRepositories(
  workspacePaths: readonly string[],
  runner: GitRunner,
  signal?: AbortSignal,
): Promise<GitRepository[]> {
  const found = new Map<string, GitRepository>();
  for (const workspacePath of workspacePaths) {
    const repository = await discoverRepository(workspacePath, runner, signal);
    if (repository) found.set(repository.info.rootPath, repository);
  }
  return [...found.values()];
}
