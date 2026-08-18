import * as path from "node:path";
import { access, readFile } from "node:fs/promises";
import { GitCommandError, GitRunner } from "./runner";
import { parsePorcelainV2 } from "./status";
import { parseUnifiedDiff, patchForHunk } from "./patch";
import {
  GitBranch,
  GitCommitOptions,
  GitCommit,
  GitDiffHunk,
  GitPullStrategy,
  GitOperationState,
  GitRepositoryInfo,
  GitRemote,
  GitStashEntry,
  GitStatusSnapshot,
  GitSubmodule,
  GitWorktree,
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

  public async patch(paths: readonly string[]): Promise<string> {
    return this.runner.text(["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...paths], { cwd: this.info.rootPath });
  }

  public async diffHunks(pathSpec: string, staged = false): Promise<GitDiffHunk[]> {
    const output = await this.runner.text([
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      ...(staged ? ["--cached"] : []),
      "--",
      pathSpec,
    ], { cwd: this.info.rootPath });
    return parseUnifiedDiff(output);
  }

  public async stageHunk(pathSpec: string, hunkIndex: number): Promise<void> {
    await this.applyHunk(pathSpec, hunkIndex, false, false);
  }

  public async unstageHunk(pathSpec: string, hunkIndex: number): Promise<void> {
    await this.applyHunk(pathSpec, hunkIndex, true, true);
  }

  private async applyHunk(pathSpec: string, hunkIndex: number, staged: boolean, reverse: boolean): Promise<void> {
    await this.serial(async () => {
      const output = await this.runner.text([
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        ...(staged ? ["--cached"] : []),
        "--",
        pathSpec,
      ], { cwd: this.info.rootPath });
      const hunks = parseUnifiedDiff(output);
      const hunk = hunks[hunkIndex];
      if (!hunk) throw new Error(`Git hunk ${hunkIndex + 1} is no longer available; refresh the changes view.`);
      const patch = patchForHunk(output, hunk);
      await this.runner.run(["apply", "--cached", ...(reverse ? ["--reverse"] : []), "--whitespace=nowarn", "-"], {
        cwd: this.info.rootPath,
        input: patch,
      });
    });
  }

  public async applyPatchFile(patchFile: string): Promise<void> {
    await this.serial(() => this.runner.run(["apply", "--3way", "--whitespace=nowarn", "--", patchFile], { cwd: this.info.rootPath }));
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

  public async remotes(): Promise<GitRemote[]> {
    const output = await this.runner.text(["remote", "-v"], { cwd: this.info.rootPath });
    const byName = new Map<string, GitRemote>();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
      if (!match) continue;
      const [, name, url, kind] = match;
      const existing = byName.get(name) ?? { name, fetchUrl: url, pushUrl: url };
      if (kind === "fetch") existing.fetchUrl = url;
      else existing.pushUrl = url;
      byName.set(name, existing);
    }
    return [...byName.values()];
  }

  public async addRemote(name: string, url: string): Promise<void> {
    await this.serial(() => this.runner.run(["remote", "add", name, url], { cwd: this.info.rootPath }));
  }

  public async removeRemote(name: string): Promise<void> {
    await this.serial(() => this.runner.run(["remote", "remove", name], { cwd: this.info.rootPath }));
  }

  public async setRemoteUrl(name: string, url: string, push = false): Promise<void> {
    await this.serial(() => this.runner.run(["remote", "set-url", ...(push ? ["--push"] : []), name, url], { cwd: this.info.rootPath }));
  }

  public async fetchRemote(name: string, prune = true): Promise<void> {
    await this.serial(() => this.runner.run(["fetch", ...(prune ? ["--prune"] : []), name], { cwd: this.info.rootPath }));
  }

  public async pushRemote(name: string, branch?: string, forceWithLease = false): Promise<void> {
    await this.serial(() => this.runner.run(["push", ...(forceWithLease ? ["--force-with-lease"] : []), name, ...(branch ? [branch] : [])], { cwd: this.info.rootPath }));
  }

  public async createTag(name: string, ref = "HEAD"): Promise<void> {
    await this.serial(() => this.runner.run(["tag", name, ref], { cwd: this.info.rootPath }));
  }

  public async deleteTag(name: string): Promise<void> {
    await this.serial(() => this.runner.run(["tag", "-d", name], { cwd: this.info.rootPath }));
  }

  public async worktrees(): Promise<GitWorktree[]> {
    const output = await this.runner.text(["worktree", "list", "--porcelain"], { cwd: this.info.rootPath });
    const entries: GitWorktree[] = [];
    let current: GitWorktree | undefined;
    const finish = (): void => {
      if (current) entries.push(current);
      current = undefined;
    };
    for (const line of output.split(/\r?\n/)) {
      if (!line) {
        finish();
        continue;
      }
      if (line.startsWith("worktree ")) {
        finish();
        current = { path: line.slice("worktree ".length), head: null, branch: null, bare: false, detached: false, prunable: false };
      } else if (!current) {
        continue;
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.detached = true;
      } else if (line.startsWith("prunable")) {
        current.prunable = true;
      }
    }
    finish();
    return entries;
  }

  public async addWorktree(worktreePath: string, ref?: string, newBranch?: string): Promise<void> {
    const args = ["worktree", "add"];
    if (newBranch) args.push("-b", newBranch);
    args.push(worktreePath);
    if (ref) args.push(ref);
    await this.serial(() => this.runner.run(args, { cwd: this.info.rootPath }));
  }

  public async removeWorktree(worktreePath: string, force = false): Promise<void> {
    await this.serial(() => this.runner.run(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], { cwd: this.info.rootPath }));
  }

  public async pruneWorktrees(): Promise<void> {
    await this.serial(() => this.runner.run(["worktree", "prune"], { cwd: this.info.rootPath }));
  }

  public async submodules(): Promise<GitSubmodule[]> {
    const output = await this.runner.text(["submodule", "status", "--recursive"], { cwd: this.info.rootPath });
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const match = /^([-+ ])([0-9a-f]+)\s+([^ ]+)(?:\s+\(([^)]+)\))?/.exec(line);
      return match
        ? { status: match[1], oid: match[2], path: match[3], url: match[4] }
        : { status: "?", oid: "", path: line.trim() };
    });
  }

  public async updateSubmodules(init = true, recursive = true): Promise<void> {
    await this.serial(() => this.runner.run(["submodule", "update", ...(init ? ["--init"] : []), ...(recursive ? ["--recursive"] : [])], { cwd: this.info.rootPath }));
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
