import * as path from "node:path";
import { access, mkdtemp, opendir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitCommandError, GitRunner } from "./runner";
import { parsePorcelainV2 } from "./status";
import { parseUnifiedDiff, patchForHunk } from "./patch";
import {
  GitBranch,
  GitCommitOptions,
  GitCommit,
  GitCommitFile,
  GitConflictVersions,
  GitLogOptions,
  GitBlameEntry,
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

function parseNameStatus(output: string): GitCommitFile[] {
  const fields = output.split("\0");
  const files: GitCommitFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const originalPath = fields[index++];
      const filePath = fields[index++];
      if (originalPath && filePath) files.push({ status, path: filePath, originalPath });
      continue;
    }
    const filePath = fields[index++];
    if (filePath) files.push({ status, path: filePath });
  }
  return files;
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
      // A sequencer can belong to either a multi-commit cherry-pick or revert.
      // Until its exact command is known, exposing generic buttons would run
      // the wrong Git command, so keep the state visible but actions disabled.
      { kind: "sequencer", paths: ["sequencer"], canContinue: false, canAbort: false },
    ];
    for (const candidate of candidates) {
      for (const gitPath of candidate.paths) {
        // Operation markers always live in the worktree-specific Git directory.
        // Resolving every marker through `git rev-parse --git-path` made one
        // lightweight refresh spawn up to seven extra Git processes.
        const resolved = path.join(this.info.gitDir, gitPath);
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

  public async log(limit = 50, filePath?: string, options?: Partial<GitLogOptions>): Promise<GitCommit[]> {
    const head = await this.currentRevision();
    return this.readLog(["--branches", "--remotes", "--tags", ...(head ? [head] : [])], limit, filePath, options);
  }

  public async logRef(ref: string, limit = 200, filePath?: string, options?: Partial<GitLogOptions>): Promise<GitCommit[]> {
    const revision = await this.resolveCommit(ref);
    return this.readLog([revision], limit, filePath, options);
  }

  private async readLog(
    revisions: readonly string[],
    limit: number,
    filePath?: string,
    options: Partial<GitLogOptions> = {},
  ): Promise<GitCommit[]> {
    const order = options.order === "topological" ? "--topo-order" : "--date-order";
    const output = await this.runner.text([
      "log",
      order,
      ...(options.firstParent ? ["--first-parent"] : []),
      ...(options.noMerges ? ["--no-merges"] : []),
      `--max-count=${Math.max(1, Math.min(limit, 5_000))}`,
      "--date=iso-strict",
      "--pretty=format:%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%D%x00%s%x00%B%x01",
      ...revisions,
      ...(filePath ? ["--", logPathspec(filePath)] : []),
    ], { cwd: this.info.rootPath });
    return output.split("\x01").filter((record) => record.trim()).map((record) => {
      const fields = record.replace(/^[\r\n]+/, "").split("\x00");
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

  public async formatPatch(ref: string, pathSpec?: string): Promise<string> {
    const revision = await this.resolveCommit(ref);
    return this.runner.text([
      "format-patch", "-1", "--stdout", revision,
      ...(pathSpec ? ["--", pathSpec] : []),
    ], { cwd: this.info.rootPath });
  }

  public async diffAgainstWorkingTree(ref: string, pathSpec?: string): Promise<string> {
    const revision = await this.resolveCommit(ref);
    return this.runner.text([
      "diff", revision,
      ...(pathSpec ? ["--", pathSpec] : []),
    ], { cwd: this.info.rootPath });
  }

  public async compareRefHistory(leftRef: string, rightRef: string): Promise<string> {
    const [left, right] = await Promise.all([this.resolveCommit(leftRef), this.resolveCommit(rightRef)]);
    return this.runner.text(
      ["log", "--left-right", "--graph", "--decorate=short", "--oneline", `${left}...${right}`],
      { cwd: this.info.rootPath },
    );
  }

  public async diffRefs(leftRef: string, rightRef: string): Promise<string> {
    const [left, right] = await Promise.all([this.resolveCommit(leftRef), this.resolveCommit(rightRef)]);
    return this.runner.text(["diff", left, right], { cwd: this.info.rootPath });
  }

  public async diffFiles(leftRef: string, rightRef: string): Promise<GitCommitFile[]> {
    const [left, right] = await Promise.all([this.resolveCommit(leftRef), this.resolveCommit(rightRef)]);
    const output = await this.runner.text(
      ["diff", "--no-ext-diff", "--name-status", "-z", "-M", left, right, "--"],
      { cwd: this.info.rootPath },
    );
    return parseNameStatus(output);
  }

  public async commitFiles(hash: string): Promise<GitCommitFile[]> {
    const revision = await this.resolveCommit(hash);
    const output = await this.runner.text(
      ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", "-z", revision],
      { cwd: this.info.rootPath },
    );
    return parseNameStatus(output);
  }

  public async blame(pathSpec: string, revision?: string): Promise<GitBlameEntry[]> {
    const output = await this.runner.text([
      "blame",
      "--line-porcelain",
      ...(revision ? [revision] : []),
      "--",
      pathSpec,
    ], { cwd: this.info.rootPath });
    const entries: GitBlameEntry[] = [];
    let current: GitBlameEntry | undefined;
    for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
      const header = /^([0-9a-f]{7,40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
      if (header) {
        current = {
          hash: header[1],
          originalLine: Number(header[2]),
          finalLine: Number(header[3]),
          author: "",
          authorTime: "",
          summary: "",
          content: "",
        };
        continue;
      }
      if (!current) continue;
      if (line.startsWith("author ")) current.author = line.slice("author ".length);
      else if (line.startsWith("author-time ")) current.authorTime = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
      else if (line.startsWith("summary ")) current.summary = line.slice("summary ".length);
      else if (line.startsWith("\t")) {
        current.content = line.slice(1);
        entries.push(current);
        current = undefined;
      }
    }
    return entries;
  }

  public async patch(paths: readonly string[]): Promise<string> {
    const base = (await this.currentRevision()) ?? await this.emptyTree();
    return this.runner.text(["diff", "--binary", "--no-ext-diff", base, "--", ...paths], { cwd: this.info.rootPath });
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

  public async stageHunk(pathSpec: string, expectedHunk: GitDiffHunk): Promise<void> {
    await this.applyHunk(pathSpec, expectedHunk, false, false);
  }

  public async unstageHunk(pathSpec: string, expectedHunk: GitDiffHunk): Promise<void> {
    await this.applyHunk(pathSpec, expectedHunk, true, true);
  }

  private async applyHunk(pathSpec: string, expectedHunk: GitDiffHunk, staged: boolean, reverse: boolean): Promise<void> {
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
      const hunk = hunks.find((candidate) => candidate.header === expectedHunk.header
        && candidate.lines.length === expectedHunk.lines.length
        && candidate.lines.every((line, index) => line === expectedHunk.lines[index]));
      if (!hunk) throw new Error("This hunk changed since it was displayed; refresh the changes view and try again.");
      const patch = patchForHunk(output, hunk);
      await this.runner.run(["apply", "--cached", ...(reverse ? ["--reverse"] : []), "--whitespace=nowarn", "-"], {
        cwd: this.info.rootPath,
        input: patch,
      });
    });
  }

  public async applyPatchFile(patchFile: string): Promise<void> {
    // Applying without --index/--3way deliberately leaves restored shelf changes unstaged.
    await this.serial(() => this.runner.run(["apply", "--whitespace=nowarn", "--", patchFile], { cwd: this.info.rootPath }));
  }

  /** Removes tracked paths from both index and worktree after their patch has been persisted. */
  public async shelveTrackedPaths(paths: readonly string[]): Promise<void> {
    await this.serial(async () => {
      const source = (await this.currentRevision()) ?? await this.emptyTree();
      await this.runner.run(
        ["restore", `--source=${source}`, "--staged", "--worktree", "--", ...paths],
        { cwd: this.info.rootPath },
      );
    });
  }

  public async cleanUntracked(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["clean", "-f", "--", ...paths], { cwd: this.info.rootPath }));
  }

  public async sparseCheckoutSet(paths: readonly string[], cone = true): Promise<void> {
    await this.serial(() => this.runner.run(["sparse-checkout", "set", ...(cone ? ["--cone"] : []), "--", ...paths], { cwd: this.info.rootPath }));
  }

  public async sparseCheckoutDisable(): Promise<void> {
    await this.serial(() => this.runner.run(["sparse-checkout", "disable"], { cwd: this.info.rootPath }));
  }

  public async lfsPull(signal?: AbortSignal): Promise<void> {
    await this.serial(() => this.runner.run(["lfs", "pull"], { cwd: this.info.rootPath, signal }));
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

  public async fetchRemote(name: string, prune = true, signal?: AbortSignal): Promise<void> {
    await this.serial(() => this.runner.run(["fetch", ...(prune ? ["--prune"] : []), name], { cwd: this.info.rootPath, signal }));
  }

  public async pushRemote(name: string, branch?: string, forceWithLease = false, signal?: AbortSignal): Promise<void> {
    await this.serial(() => this.runner.run(["push", ...(forceWithLease ? ["--force-with-lease"] : []), name, ...(branch ? [branch] : [])], { cwd: this.info.rootPath, signal }));
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
    const entries = output.split(/\r?\n/).filter(Boolean).map((line) => {
      const match = /^([-+ ])([0-9a-f]+)\s+(.+?)(?:\s+\([^)]+\))?$/.exec(line);
      return match
        ? { status: match[1], oid: match[2], path: match[3] }
        : { status: "?", oid: "", path: line.trim() };
    });
    return Promise.all(entries.map(async (entry) => {
      try {
        const url = trimOutput(await this.runner.text(["config", "--get", `submodule.${entry.path}.url`], { cwd: this.info.rootPath }));
        return url ? { ...entry, url } : entry;
      } catch {
        return entry;
      }
    }));
  }

  public async updateSubmodules(init = true, recursive = true, paths: readonly string[] = []): Promise<void> {
    await this.serial(() => this.runner.run(["submodule", "update", ...(init ? ["--init"] : []), ...(recursive ? ["--recursive"] : []), ...(paths.length ? ["--", ...paths] : [])], { cwd: this.info.rootPath }));
  }

  public async stage(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["add", "--", ...paths], { cwd: this.info.rootPath }));
  }

  public async unstage(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["reset", "HEAD", "--", ...paths], { cwd: this.info.rootPath }));
  }

  public async discard(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths], { cwd: this.info.rootPath }));
  }

  public async resolveConflict(pathSpec: string, side: "ours" | "theirs"): Promise<void> {
    await this.serial(() => this.runner.run(["checkout", `--${side}`, "--", pathSpec], { cwd: this.info.rootPath }));
  }

  public async conflictVersions(pathSpec: string): Promise<GitConflictVersions> {
    await this.assertConflictedPath(pathSpec);
    const [base, ours, theirs, result] = await Promise.all([
      this.conflictStage(pathSpec, 1),
      this.conflictStage(pathSpec, 2),
      this.conflictStage(pathSpec, 3),
      this.conflictWorkingTree(pathSpec),
    ]);
    return {
      path: pathSpec,
      base: base?.toString("utf8") ?? "",
      baseExists: base !== null,
      ours: ours?.toString("utf8") ?? "",
      oursExists: ours !== null,
      theirs: theirs?.toString("utf8") ?? "",
      theirsExists: theirs !== null,
      result: result?.toString("utf8") ?? "",
      resultExists: result !== null,
      binary: [base, ours, theirs, result].some((content) => content?.includes(0) ?? false),
    };
  }

  public async applyConflictResult(pathSpec: string, content: string, deleted = false): Promise<void> {
    await this.serial(async () => {
      await this.assertConflictedPath(pathSpec);
      if (deleted) await rm(this.worktreePath(pathSpec), { force: true });
      else await writeFile(this.worktreePath(pathSpec), content, "utf8");
      await this.runner.run(["add", "--", pathSpec], { cwd: this.info.rootPath });
    });
  }

  public async markResolved(paths: readonly string[]): Promise<void> {
    await this.stage(paths);
  }

  public async fetch(signal?: AbortSignal): Promise<void> {
    await this.serial(() => this.runner.run(["fetch", "--all", "--prune"], { cwd: this.info.rootPath, signal }));
  }

  public async pull(strategy: GitPullStrategy, signal?: AbortSignal): Promise<void> {
    await this.serial(() => {
      const args = ["pull"];
      if (strategy === "merge") args.push("--no-rebase");
      if (strategy === "rebase") args.push("--rebase");
      if (strategy === "ff-only") args.push("--ff-only");
      return this.runner.run(args, { cwd: this.info.rootPath, signal });
    });
  }

  public async push(forceWithLease = false, signal?: AbortSignal): Promise<void> {
    await this.serial(async () => {
      const status = await this.status(signal);
      if (!status.branch.upstream && status.branch.head) {
        const remotes = await this.remotes();
        const remote = remotes.find((item) => item.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined);
        if (!remote) {
          throw new Error(remotes.length
            ? "This branch has no upstream. Use 'JB Git: Push Remote' to select one."
            : "This repository has no remote. Add a remote before pushing.");
        }
        await this.runner.run(["push", "--set-upstream", ...(forceWithLease ? ["--force-with-lease"] : []), remote.name, status.branch.head], { cwd: this.info.rootPath, signal });
        return;
      }
      await this.runner.run(["push", ...(forceWithLease ? ["--force-with-lease"] : [])], { cwd: this.info.rootPath, signal });
    });
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
    await this.serial(async () => {
      const revision = await this.resolveCommit(ref);
      await this.runner.run(["reset", `--${mode}`, revision], { cwd: this.info.rootPath });
    });
  }

  public async checkoutRevision(ref: string): Promise<void> {
    await this.serial(async () => {
      const revision = await this.resolveCommit(ref);
      await this.runner.run(["switch", "--detach", revision], { cwd: this.info.rootPath });
    });
  }

  public async restoreFileFromRevision(ref: string, pathSpec: string): Promise<void> {
    await this.serial(async () => {
      const revision = await this.resolveCommit(ref);
      await this.runner.run(["restore", `--source=${revision}`, "--", pathSpec], { cwd: this.info.rootPath });
    });
  }

  public async continueOperation(kind: Exclude<import("./types").GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    const command = kind === "merge" ? "merge" : kind === "rebase" ? "rebase" : kind === "cherry-pick" ? "cherry-pick" : "revert";
    await this.serial(() => this.runner.run([command, "--continue"], { cwd: this.info.rootPath }));
  }

  public async abortOperation(kind: Exclude<import("./types").GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    const command = kind === "merge" ? "merge" : kind === "rebase" ? "rebase" : kind === "cherry-pick" ? "cherry-pick" : "revert";
    await this.serial(() => this.runner.run([command, "--abort"], { cwd: this.info.rootPath }));
  }

  public async bisectStart(bad: string, good: string): Promise<void> {
    await this.serial(() => this.runner.run(["bisect", "start", bad, good], { cwd: this.info.rootPath }));
  }

  public async bisectGood(ref = "HEAD"): Promise<void> {
    await this.serial(() => this.runner.run(["bisect", "good", ref], { cwd: this.info.rootPath }));
  }

  public async bisectBad(ref = "HEAD"): Promise<void> {
    await this.serial(() => this.runner.run(["bisect", "bad", ref], { cwd: this.info.rootPath }));
  }

  public async bisectSkip(): Promise<void> {
    await this.serial(() => this.runner.run(["bisect", "skip"], { cwd: this.info.rootPath }));
  }

  public async bisectReset(ref?: string): Promise<void> {
    await this.serial(() => this.runner.run(["bisect", "reset", ...(ref ? [ref] : [])], { cwd: this.info.rootPath }));
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

  /**
   * Commits complete selected paths through an isolated index. The user's real
   * index is untouched if staging or hooks fail, so partial staging is not lost.
   */
  public async commitPaths(paths: readonly string[], message: string, options: GitCommitOptions = {}): Promise<string> {
    return this.serial(async () => {
      if (paths.length === 0) throw new Error("No paths were selected for the commit.");
      const selected = new Set(paths);
      const status = await this.status();
      if (status.changes.some((change) => change.staged && !selected.has(change.path))) {
        throw new Error("Cannot commit selected paths while unrelated staged changes exist.");
      }
      const pathSpecs = [...new Set(status.changes
        .filter((change) => selected.has(change.path))
        .flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]))];
      if (pathSpecs.length === 0) throw new Error("The selected paths no longer have local changes.");
      const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "jb-git-index-"));
      const temporaryIndex = path.join(temporaryDirectory, "index");
      const environment = { GIT_INDEX_FILE: temporaryIndex };
      try {
        const revision = await this.currentRevision();
        await this.runner.run(revision ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], {
          cwd: this.info.rootPath,
          env: environment,
        });
        await this.runner.run(["add", "-A", "--", ...pathSpecs], { cwd: this.info.rootPath, env: environment });
        const args = ["commit", "--file=-"];
        if (options.amend) args.push("--amend");
        if (options.signoff) args.push("--signoff");
        if (options.noVerify) args.push("--no-verify");
        await this.runner.run(args, { cwd: this.info.rootPath, env: environment, input: message });

        // The selected working-tree content is now HEAD. Align the real index
        // with that commit; callers reject staged changes outside these paths.
        await this.runner.run(["reset", "--mixed", "HEAD"], { cwd: this.info.rootPath });
        return (await this.currentRevision()) ?? "";
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
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
      if (error instanceof GitCommandError && /(?:does not exist|exists on disk, but not in|path .* not in|invalid object name ['\"]?(?:HEAD|INDEX))/i.test(error.stderr)) return Buffer.alloc(0);
      throw error;
    }
  }

  public async checkout(branch: string, kind?: GitBranch["kind"]): Promise<void> {
    await this.serial(async () => {
      const isTag = kind === "tag" || (kind === undefined && await this.hasRef(`refs/tags/${branch}`));
      if (isTag) {
        await this.runner.run(["switch", "--detach", `refs/tags/${branch}`], { cwd: this.info.rootPath });
        return;
      }
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

  private async assertConflictedPath(pathSpec: string): Promise<void> {
    const change = (await this.status()).changes.find((candidate) => candidate.path === pathSpec);
    if (!change?.conflicted) throw new Error(`${pathSpec} is no longer an unresolved conflict.`);
  }

  private async conflictStage(pathSpec: string, stage: 1 | 2 | 3): Promise<Buffer | null> {
    try {
      return (await this.runner.run(["show", `:${stage}:${pathSpec}`], { cwd: this.info.rootPath })).stdout;
    } catch (error) {
      // A stage is legitimately absent for add/delete and rename conflicts.
      if (error instanceof GitCommandError) return null;
      throw error;
    }
  }

  private async conflictWorkingTree(pathSpec: string): Promise<Buffer | null> {
    try {
      return await readFile(this.worktreePath(pathSpec));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private worktreePath(pathSpec: string): string {
    if (!pathSpec || path.isAbsolute(pathSpec)) throw new Error("Conflict path must be relative to the repository.");
    const resolved = path.resolve(this.info.rootPath, pathSpec);
    const relative = path.relative(this.info.rootPath, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Conflict path is outside the repository.");
    return resolved;
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

  private async resolveCommit(ref: string): Promise<string> {
    return trimOutput(await this.runner.text(
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { cwd: this.info.rootPath },
    ));
  }

  private async emptyTree(): Promise<string> {
    return trimOutput(await this.runner.text(["mktree"], { cwd: this.info.rootPath, input: "" }));
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

export function logPathspec(value: string): string {
  // A bare file name is treated as a suffix search, matching IntelliJ's path
  // filter. Paths containing a directory separator remain exact and literal.
  if (value.includes("/") || value.includes("\\")) return `:(literal)${value.replaceAll("\\", "/")}`;
  const escaped = value.replace(/([*?\[\\])/g, "\\$1");
  return `:(glob)**/${escaped}`;
}

export async function discoverRepository(
  workspacePath: string,
  runner: GitRunner,
  signal?: AbortSignal,
): Promise<GitRepository | null> {
  try {
    const isBare = trimOutput(await runner.text(["rev-parse", "--is-bare-repository"], { cwd: workspacePath, signal })) === "true";
    const rawRootPath = trimOutput(await runner.text(
      ["rev-parse", isBare ? "--absolute-git-dir" : "--show-toplevel"],
      { cwd: workspacePath, signal },
    ));
    const rootPath = await canonicalPath(rawRootPath);
    const gitDirRaw = trimOutput(await runner.text(["rev-parse", "--git-dir"], { cwd: workspacePath, signal }));
    const commonGitDirRaw = trimOutput(await runner.text(["rev-parse", "--git-common-dir"], { cwd: workspacePath, signal }));
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

const DISCOVERY_EXCLUDES = new Set([".git", ".vscode-test", "node_modules", "dist", "out", "build", "target", ".cache"]);

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return path.normalize(await realpath(candidate));
  } catch {
    return path.normalize(path.resolve(candidate));
  }
}

async function repositoryCandidates(workspacePath: string): Promise<string[]> {
  const candidates = new Set<string>([workspacePath]);
  const queue = [workspacePath];
  let visited = 0;
  for (let cursor = 0; cursor < queue.length && visited < 20_000; cursor += 1) {
    const directory = queue[cursor];
    visited += 1;
    try {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (entry.name === ".git") {
          candidates.add(directory);
          continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || DISCOVERY_EXCLUDES.has(entry.name)) continue;
        const child = path.join(directory, entry.name);
        if (entry.name.endsWith(".git")) {
          candidates.add(child);
          continue;
        }
        queue.push(child);
      }
    } catch {
      // Unreadable folders are unrelated to repository roots we can operate on.
    }
  }
  return [...candidates];
}

export async function discoverRepositories(
  workspacePaths: readonly string[],
  runner: GitRunner,
  signal?: AbortSignal,
  scanNested = true,
): Promise<GitRepository[]> {
  const found = new Map<string, GitRepository>();
  for (const workspacePath of workspacePaths) {
    const candidates = scanNested ? await repositoryCandidates(workspacePath) : [workspacePath];
    for (const candidate of candidates) {
      const repository = await discoverRepository(candidate, runner, signal);
      if (repository) found.set(repository.info.rootPath, repository);
    }
  }
  return [...found.values()];
}
