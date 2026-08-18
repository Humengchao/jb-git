import * as path from "node:path";
import { access, readFile } from "node:fs/promises";
import { GitCommandError, GitRunner } from "./runner";
import { parsePorcelainV2 } from "./status";
import {
  GitBranch,
  GitCommitOptions,
  GitCommit,
  GitPullStrategy,
  GitOperationState,
  GitRepositoryInfo,
  GitStashEntry,
  GitStatusSnapshot,
} from "./types";

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

  public async operationState(): Promise<GitOperationState> {
    const candidates: Array<{ kind: GitOperationState["kind"]; paths: string[]; canContinue: boolean; canAbort: boolean }> = [
      { kind: "merge", paths: ["MERGE_HEAD"], canContinue: true, canAbort: true },
      { kind: "cherry-pick", paths: ["CHERRY_PICK_HEAD"], canContinue: true, canAbort: true },
      { kind: "revert", paths: ["REVERT_HEAD"], canContinue: true, canAbort: true },
      { kind: "rebase", paths: ["rebase-merge", "rebase-apply"], canContinue: true, canAbort: true },
      { kind: "bisect", paths: ["BISECT_LOG"], canContinue: false, canAbort: true },
      { kind: "sequencer", paths: ["sequencer"], canContinue: true, canAbort: true },
    ];
    for (const candidate of candidates) {
      for (const gitPath of candidate.paths) {
        const resolved = await this.gitPath(gitPath);
        if (await this.exists(resolved)) {
          return {
            kind: candidate.kind,
            canContinue: candidate.canContinue,
            canAbort: candidate.canAbort,
            detail: resolved,
          };
        }
      }
    }
    return { kind: "none", canContinue: false, canAbort: false };
  }

  public async log(limit = 50, filePath?: string): Promise<GitCommit[]> {
    const output = await this.runner.text(
      [
        "log",
        "--all",
        "--topo-order",
        `--max-count=${Math.max(1, Math.min(limit, 500))}`,
        "--date=iso-strict",
        "--pretty=format:%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%D%x00%s%x00%B%x01",
        ...(filePath ? ["--", filePath] : []),
      ],
      { cwd: this.info.rootPath },
    );
    return output.split("\x01").filter((record) => record.trim()).map((record) => {
      const fields = record.split("\x00");
      const [hash, parents, author, email, authoredAt, committedAt, refs, subject, ...body] = fields;
      return {
        hash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        author,
        email,
        authoredAt,
        committedAt,
        refs: refs ? refs.split(",").map((ref) => ref.trim()).filter(Boolean) : [],
        subject,
        body: body.join("\0").trim(),
      };
    });
  }

  public async showCommit(hash: string): Promise<string> {
    return this.runner.text(["show", "--format=fuller", "--stat", "--patch", "--decorate=short", hash], { cwd: this.info.rootPath });
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

  public async pull(strategy: GitPullStrategy): Promise<void> {
    await this.serial(() => {
      const args = ["pull"];
      if (strategy === "rebase") args.push("--rebase");
      if (strategy === "ff-only") args.push("--ff-only");
      return this.runner.run(args, { cwd: this.info.rootPath });
    });
  }

  public async push(forceWithLease = false): Promise<void> {
    await this.serial(() => this.runner.run(["push", ...(forceWithLease ? ["--force-with-lease"] : [])], { cwd: this.info.rootPath }));
  }

  public async merge(ref: string): Promise<void> {
    await this.serial(() => this.runner.run(["merge", ref], { cwd: this.info.rootPath }));
  }

  public async rebase(ref: string): Promise<void> {
    await this.serial(() => this.runner.run(["rebase", ref], { cwd: this.info.rootPath }));
  }

  public async cherryPick(hash: string): Promise<void> {
    await this.serial(() => this.runner.run(["cherry-pick", hash], { cwd: this.info.rootPath }));
  }

  public async revert(hash: string): Promise<void> {
    await this.serial(() => this.runner.run(["revert", "--no-edit", hash], { cwd: this.info.rootPath }));
  }

  public async reset(ref: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
    await this.serial(() => this.runner.run(["reset", `--${mode}`, ref], { cwd: this.info.rootPath }));
  }

  public async continueOperation(kind: Exclude<import("./types").GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    const command = kind === "merge" ? "merge" : kind === "rebase" ? "rebase" : kind === "cherry-pick" ? "cherry-pick" : "revert";
    await this.serial(() => this.runner.run([command, "--continue"], { cwd: this.info.rootPath }));
  }

  public async abortOperation(kind: Exclude<import("./types").GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    const command = kind === "merge" ? "merge" : kind === "rebase" ? "rebase" : kind === "cherry-pick" ? "cherry-pick" : "revert";
    await this.serial(() => this.runner.run([command, "--abort"], { cwd: this.info.rootPath }));
  }

  public async skipOperation(kind: "rebase" | "cherry-pick"): Promise<void> {
    await this.serial(() => this.runner.run([kind, "--skip"], { cwd: this.info.rootPath }));
  }

  public async commit(message: string, options: GitCommitOptions = {}): Promise<string> {
    return this.serial(async () => {
      const args = ["commit", "--file=-"];
      if (options.amend) args.push("--amend");
      if (options.signoff) args.push("--signoff");
      if (options.noVerify) args.push("--no-verify");
      await this.runner.run(args, { cwd: this.info.rootPath, input: message });
      return (await this.currentRevision()) ?? "";
    });
  }

  public async createBranch(name: string, startPoint?: string): Promise<void> {
    await this.serial(() => this.runner.run(["switch", "-c", name, ...(startPoint ? [startPoint] : [])], { cwd: this.info.rootPath }));
  }

  public async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.serial(() => this.runner.run(["branch", "-m", oldName, newName], { cwd: this.info.rootPath }));
  }

  public async deleteBranch(name: string, force = false): Promise<void> {
    await this.serial(() => this.runner.run(["branch", force ? "-D" : "-d", name], { cwd: this.info.rootPath }));
  }

  public async stash(message?: string, includeUntracked = false, keepIndex = false): Promise<void> {
    await this.serial(() => {
      const args = ["stash", "push"];
      if (includeUntracked) args.push("--include-untracked");
      if (keepIndex) args.push("--keep-index");
      if (message) args.push("--message", message);
      return this.runner.run(args, { cwd: this.info.rootPath });
    });
  }

  public async stashes(): Promise<GitStashEntry[]> {
    const output = await this.runner.text(["stash", "list", "--format=%gd%x00%gs"], { cwd: this.info.rootPath });
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [ref, message] = line.split("\0");
      return { ref, message: message ?? "" };
    });
  }

  public async applyStash(ref: string, pop = false): Promise<void> {
    await this.serial(() => this.runner.run(["stash", pop ? "pop" : "apply", ref], { cwd: this.info.rootPath }));
  }

  public async dropStash(ref: string): Promise<void> {
    await this.serial(() => this.runner.run(["stash", "drop", ref], { cwd: this.info.rootPath }));
  }

  public async fileContent(pathSpec: string, revision?: string): Promise<Buffer> {
    if (!revision) {
      try {
        return await readFile(path.resolve(this.info.rootPath, pathSpec));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
        throw error;
      }
    }
    try {
      const objectSpec = revision === "INDEX" ? `:${pathSpec}` : `${revision}:${pathSpec}`;
      const result = await this.runner.run(["show", objectSpec], { cwd: this.info.rootPath });
      return result.stdout;
    } catch (error) {
      if (error instanceof GitCommandError) return Buffer.alloc(0);
      throw error;
    }
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

  private async gitPath(relativePath: string): Promise<string> {
    const raw = trimOutput(await this.runner.text(["rev-parse", "--git-path", relativePath], { cwd: this.info.rootPath }));
    return path.isAbsolute(raw) ? raw : path.resolve(this.info.rootPath, raw);
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
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
