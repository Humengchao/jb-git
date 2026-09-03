import * as path from "node:path";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, opendir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitAbortError, GitCommandError, GitRunner, isGitAbort } from "./runner";
import { parsePorcelainV2, parseUpstreamTrack } from "./status";
import { parsePorcelainBlame } from "./blame";
import { hunkKeys, type HunkSelection } from "../changelists/hunkOwnership";
import { parseUnifiedDiff, patchForHunk, patchForHunks } from "./patch";
import { buildRebaseTodo, posixPath, shellQuote, validateRebasePlan, type InteractiveRebaseExpectation, type RebaseStep } from "../interactiveRebase";
import { parseDiff3, resolveSimpleConflicts, type Diff3Labels, type MergeBlock } from "../mergeAnalysis";
import { appendIgnoreLine } from "../ignoreRules";
import { DEFAULT_COMMENT_CHAR } from "../commitMessage";
import {
  GitBranch,
  GitCommitOptions,
  GitCommit,
  GitCommitFile,
  GitConflictVersions,
  GitIgnoreTarget,
  GitLogOptions,
  GitBlameEntry,
  GitBlameOptions,
  GitDiffHunk,
  GitMergeOptions,
  GitPullStrategy,
  GitOperationState,
  GitRepositoryInfo,
  GitRebaseOptions,
  GitRemote,
  GitResetMode,
  GitStashEntry,
  GitStatusSnapshot,
  GitSubmodule,
  GitWorktree,
} from "./types";

function trimOutput(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

function resolveGitDir(commandCwd: string, value: string): string {
  // rev-parse prints relative --git-dir/--git-common-dir values relative to
  // the command's cwd, which may be a workspace nested below the repository.
  return path.isAbsolute(value) ? path.normalize(value) : path.normalize(path.resolve(commandCwd, value));
}

/** Prevents a path obtained from Git from being reinterpreted as pathspec magic. */
function literalPathspec(value: string): string {
  const normalized = path.sep === "\\" ? value.replaceAll("\\", "/") : value;
  return `:(literal)${normalized}`;
}

function literalPathspecs(values: readonly string[]): string[] {
  return values.map(literalPathspec);
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

/**
 * With a custom pretty format, `--log-size` reports that formatted record's
 * exact byte length. Unlike a sentinel byte, this framing cannot be forged by
 * a legal commit message.
 */
function parseLengthPrefixedLog(output: Buffer): GitCommit[] {
  const commits: GitCommit[] = [];
  let cursor = 0;
  while (cursor < output.length) {
    while (cursor < output.length && (output[cursor] === 0x0a || output[cursor] === 0x0d)) cursor += 1;
    if (cursor >= output.length) break;
    const lineEnd = output.indexOf(0x0a, cursor);
    if (lineEnd < 0) throw new Error("Git log ended before its record-size header was complete.");
    const header = output.subarray(cursor, lineEnd).toString("ascii").replace(/\r$/, "");
    const sizeMatch = /^log size (\d+)$/.exec(header);
    if (!sizeMatch) throw new Error("Git log returned an invalid record-size header.");
    const size = Number(sizeMatch[1]);
    const recordStart = lineEnd + 1;
    const recordEnd = recordStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || recordEnd > output.length) {
      throw new Error("Git log returned an invalid record size.");
    }
    const record = output.subarray(recordStart, recordEnd);
    const fields: Buffer[] = [];
    let fieldStart = 0;
    for (let field = 0; field < 8; field += 1) {
      const separator = record.indexOf(0, fieldStart);
      if (separator < 0) throw new Error("Git log returned an incomplete metadata record.");
      fields.push(record.subarray(fieldStart, separator));
      fieldStart = separator + 1;
    }
    const [hashBytes, parentsBytes, authorBytes, emailBytes, authoredAtBytes, committedAtBytes, refsBytes, subjectBytes] = fields;
    const hash = hashBytes.toString("utf8");
    const parents = parentsBytes.toString("utf8");
    const refs = refsBytes.toString("utf8");
    commits.push({
      hash,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      author: authorBytes.toString("utf8"),
      email: emailBytes.toString("utf8"),
      authoredAt: authoredAtBytes.toString("utf8"),
      committedAt: committedAtBytes.toString("utf8"),
      refs: refs ? refs.split(",").map((ref) => ref.trim()).filter(Boolean) : [],
      subject: subjectBytes.toString("utf8"),
      body: record.subarray(fieldStart).toString("utf8").trim(),
    });
    cursor = recordEnd;
  }
  return commits;
}

/** Carries progress when a sequential multi-commit operation stops early. */
export class GitBatchError extends Error {
  public constructor(
    public readonly applied: number,
    public readonly currentHash: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "GitBatchError";
  }
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

  public async log(limit = 50, filePath?: string, options?: Partial<GitLogOptions>, signal?: AbortSignal): Promise<GitCommit[]> {
    return this.logPage(limit, 0, filePath, options, signal);
  }

  /** Reads a page of the same walk without re-sending the commits before it. */
  public async logPage(limit = 50, skip = 0, filePath?: string, options?: Partial<GitLogOptions>, signal?: AbortSignal): Promise<GitCommit[]> {
    const head = await this.currentRevision(signal);
    // A line-range walk is limited by Git to a single starting revision, and
    // the lines it names exist in HEAD's file, so that is the revision it walks.
    const revisions = options?.lineRange
      ? [head ?? "HEAD"]
      : ["--branches", "--remotes", "--tags", ...(head ? [head] : [])];
    return this.readLog(revisions, limit, filePath, options, skip, signal);
  }

  public async logRef(ref: string, limit = 200, filePath?: string, options?: Partial<GitLogOptions>, signal?: AbortSignal): Promise<GitCommit[]> {
    const revision = await this.resolveCommit(ref, signal);
    return this.readLog([revision], limit, filePath, options, 0, signal);
  }

  public async logRefPage(ref: string, limit = 200, skip = 0, filePath?: string, options?: Partial<GitLogOptions>, signal?: AbortSignal): Promise<GitCommit[]> {
    const revision = await this.resolveCommit(ref, signal);
    return this.readLog([revision], limit, filePath, options, skip, signal);
  }

  public async logRange(baseExclusive: string, head = "HEAD", limit = 200): Promise<GitCommit[]> {
    const [baseRevision, headRevision] = await Promise.all([this.resolveCommit(baseExclusive), this.resolveCommit(head)]);
    return this.readLog([`${baseRevision}..${headRevision}`], limit);
  }

  /** Returns commits reachable only from left and only from right. */
  public async aheadBehind(left: string, right = "HEAD"): Promise<{ left: number; right: number }> {
    const [leftRevision, rightRevision] = await Promise.all([this.resolveCommit(left), this.resolveCommit(right)]);
    const output = trimOutput(await this.runner.text(
      ["rev-list", "--left-right", "--count", `${leftRevision}...${rightRevision}`],
      { cwd: this.info.rootPath },
    ));
    const match = /^(\d+)\s+(\d+)$/.exec(output);
    if (!match) throw new Error("Git returned invalid ahead/behind counts.");
    return { left: Number(match[1]), right: Number(match[2]) };
  }

  private async readLog(
    revisions: readonly string[],
    limit: number,
    filePath?: string,
    options: Partial<GitLogOptions> = {},
    skip = 0,
    signal?: AbortSignal,
  ): Promise<GitCommit[]> {
    const order = options.order === "topological" ? "--topo-order" : "--date-order";
    const safeSkip = Number.isFinite(skip) && skip > 0 ? Math.min(Math.floor(skip), 5_000) : 0;
    const pretty = options.includeBody === false
      ? "%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%D%x00%s%x00"
      : "%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%D%x00%s%x00%B";
    const lineRange = options.lineRange ? lineRangeArgument(options.lineRange) : undefined;
    // Git refuses a pathspec next to -L: the range already names its file.
    const pathspec = filePath && !lineRange
      ? (options.exactPath ? literalPathspec(filePath) : logPathspec(filePath))
      : undefined;
    // `--follow` rejects pathspec magic other than literal, so a suffix search
    // simply does not follow renames rather than failing the whole log.
    const follow = Boolean(options.follow && pathspec?.startsWith(":(literal)"));
    const result = await this.runner.run([
      "log",
      order,
      ...(options.firstParent ? ["--first-parent"] : []),
      ...(options.noMerges ? ["--no-merges"] : []),
      ...(options.author ? [`--author=${options.author}`] : []),
      ...(options.since ? [`--since=${options.since}`] : []),
      // Fixed strings: the box is a search box, so a bracket in a message is
      // findable rather than a broken regular expression.
      ...(options.grep ? ["--fixed-strings", "--regexp-ignore-case", `--grep=${options.grep}`] : []),
      ...(safeSkip > 0 ? [`--skip=${safeSkip}`] : []),
      `--max-count=${Math.max(1, Math.min(limit, 5_000))}`,
      "--log-size",
      "--date=iso-strict",
      `--pretty=format:${pretty}`,
      ...(follow ? ["--follow"] : []),
      // -L implies a patch per commit; the list only needs the records.
      ...(lineRange ? [lineRange, "--no-patch"] : []),
      ...revisions,
      ...(pathspec ? ["--", pathspec] : []),
    ], { cwd: this.info.rootPath, signal });
    return parseLengthPrefixedLog(result.stdout);
  }

  public async showCommit(hash: string): Promise<string> {
    return this.runner.text(["show", "--format=fuller", "--stat", "--patch", "--decorate=short", hash], { cwd: this.info.rootPath });
  }

  public async commitMessage(hash: string, signal?: AbortSignal): Promise<string> {
    const revision = await this.resolveCommit(hash, signal);
    return trimOutput(await this.runner.text(["show", "-s", "--format=%B", revision], {
      cwd: this.info.rootPath,
      signal,
      maxOutputBytes: 8 * 1024 * 1024,
    }));
  }

  public async formatPatch(ref: string, pathSpec?: string): Promise<string> {
    const revision = await this.resolveCommit(ref);
    return this.runner.text([
      "format-patch", "-1", "--stdout", revision,
      ...(pathSpec ? ["--", literalPathspec(pathSpec)] : []),
    ], { cwd: this.info.rootPath });
  }

  public async diffAgainstWorkingTree(ref: string, pathSpec?: string): Promise<string> {
    const revision = await this.resolveCommit(ref);
    return this.runner.text([
      "diff", revision,
      ...(pathSpec ? ["--", literalPathspec(pathSpec)] : []),
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

  public async commitFiles(hash: string, signal?: AbortSignal): Promise<GitCommitFile[]> {
    const revision = await this.resolveCommit(hash, signal);
    try {
      // Diffing against the first parent also covers merge commits, which a
      // plain `diff-tree <commit>` lists as empty; IntelliJ shows first-parent.
      const output = await this.runner.text(
        ["diff", "--no-ext-diff", "--name-status", "-z", "-M", `${revision}^`, revision, "--"],
        { cwd: this.info.rootPath, signal },
      );
      return parseNameStatus(output);
    } catch (error) {
      if (isGitAbort(error)) throw error;
      if (!(error instanceof GitCommandError)) throw error;
      // A root commit has no first parent.
      const output = await this.runner.text(
        ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", "-z", revision],
        { cwd: this.info.rootPath, signal },
      );
      return parseNameStatus(output);
    }
  }

  /**
   * Annotates a file, optionally at `revision`, and optionally against
   * `contents` instead of what is on disk so an unsaved editor buffer stays
   * aligned with its own lines.
   */
  public async blame(
    pathSpec: string,
    revision?: string,
    contents?: string | Buffer,
    options: GitBlameOptions = {},
  ): Promise<GitBlameEntry[]> {
    // `git blame` hands its leftover arguments to the revision parser, so
    // `--end-of-options` does not keep an option-like revision out of blame's
    // own option parser: `-L1,1` would run as a flag and silently return one
    // line as if that were the whole file. Pin the input to a commit hash.
    const commit = revision ? await this.resolveCommit(revision) : undefined;
    const output = await this.runner.text([
      "--literal-pathspecs",
      "blame",
      "--porcelain",
      // IDEA's annotation Options, which change which commit a line is
      // credited to: skip a reindent, follow a block moved inside the file, or
      // follow one copied in from another file the same commit touched.
      ...(options.ignoreWhitespace ? ["-w"] : []),
      ...(options.detectMovementsWithinFile ? ["-M"] : []),
      ...(options.detectMovementsAcrossFiles ? ["-C"] : []),
      // IDEA's Hide Revision. Only object ids get through: anything else would
      // be parsed as a revision expression, or as another option.
      ...(options.ignoreRevisions ?? []).filter((hash) => /^[0-9a-f]{4,64}$/i.test(hash)).flatMap((hash) => ["--ignore-rev", hash]),
      ...(contents !== undefined ? ["--contents", "-"] : []),
      ...(commit ? [commit] : []),
      "--",
      pathSpec,
    ], { cwd: this.info.rootPath, ...(contents !== undefined ? { input: contents } : {}) });
    return parsePorcelainBlame(output);
  }

  /** Returns raw patch bytes: shelf content may be in any encoding, and a UTF-8 round-trip would corrupt it. */
  public async patch(paths: readonly string[]): Promise<Buffer> {
    const base = (await this.currentRevision()) ?? await this.emptyTree();
    const result = await this.runner.run(["diff", "--binary", "--no-ext-diff", base, "--", ...literalPathspecs(paths)], { cwd: this.info.rootPath });
    return result.stdout;
  }

  /**
   * The whole diff of one path between HEAD and the working tree, text and hunks together.
   *
   * This is the unit a commit deals with: `diffHunks` splits at the Index, which
   * is where a file is staged, not where a change belongs to a Changelist.
   */
  public async diffAgainstHead(pathSpec: string): Promise<{ output: string; hunks: GitDiffHunk[] }> {
    const revision = await this.currentRevision();
    const output = await this.runner.text([
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      ...(revision ? ["HEAD"] : []),
      "--",
      literalPathspec(pathSpec),
    ], { cwd: this.info.rootPath });
    return { output, hunks: parseUnifiedDiff(output) };
  }

  public async diffHunks(pathSpec: string, staged = false): Promise<GitDiffHunk[]> {
    const output = await this.runner.text([
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      ...(staged ? ["--cached"] : []),
      "--",
      literalPathspec(pathSpec),
    ], { cwd: this.info.rootPath });
    return parseUnifiedDiff(output);
  }

  public async stageHunk(pathSpec: string, expectedHunk: GitDiffHunk): Promise<void> {
    await this.applyHunk(pathSpec, expectedHunk, false, false);
  }

  public async unstageHunk(pathSpec: string, expectedHunk: GitDiffHunk): Promise<void> {
    await this.applyHunk(pathSpec, expectedHunk, true, true);
  }

  /**
   * IDEA's per-change Rollback inside a file: one hunk of the working tree
   * goes back to what the Index holds, leaving the file's other changes and
   * everything staged alone.
   *
   * The patch is reverse-applied to the working tree only (no `--cached`), so
   * a hunk the user also staged stays staged — rolling back the text they see
   * is not the same as unstaging it.
   */
  public async rollbackHunk(pathSpec: string, expectedHunk: GitDiffHunk): Promise<void> {
    await this.applyHunk(pathSpec, expectedHunk, false, true, "worktree");
  }

  /**
   * The standalone patch for one working-tree hunk, without applying it.
   *
   * A rollback is about to throw exactly this away, so the caller persists it
   * as the recovery entry first. Unlike a whole-file patch it applies cleanly
   * on top of the changes that stay, which is what makes the recovery useful.
   * The hunk is identified the same way the apply identifies it, so a stale
   * one is refused here rather than producing a patch for something else.
   */
  public async hunkPatch(pathSpec: string, expectedHunk: GitDiffHunk): Promise<string> {
    const output = await this.runner.text([
      "diff", "--no-ext-diff", "--no-color", "--unified=3", "--", literalPathspec(pathSpec),
    ], { cwd: this.info.rootPath });
    const hunk = parseUnifiedDiff(output).find((candidate) => candidate.header === expectedHunk.header
      && candidate.lines.length === expectedHunk.lines.length
      && candidate.lines.every((line, index) => line === expectedHunk.lines[index]));
    if (!hunk) throw new Error("This hunk changed since it was displayed; refresh the changes view and try again.");
    return patchForHunk(output, hunk);
  }

  private async applyHunk(
    pathSpec: string,
    expectedHunk: GitDiffHunk,
    staged: boolean,
    reverse: boolean,
    target: "index" | "worktree" = "index",
  ): Promise<void> {
    await this.serial(async () => {
      const output = await this.runner.text([
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        ...(staged ? ["--cached"] : []),
        "--",
        literalPathspec(pathSpec),
      ], { cwd: this.info.rootPath });
      const hunks = parseUnifiedDiff(output);
      const hunk = hunks.find((candidate) => candidate.header === expectedHunk.header
        && candidate.lines.length === expectedHunk.lines.length
        && candidate.lines.every((line, index) => line === expectedHunk.lines[index]));
      if (!hunk) throw new Error("This hunk changed since it was displayed; refresh the changes view and try again.");
      const patch = patchForHunk(output, hunk);
      await this.runner.run([
        "apply",
        ...(target === "index" ? ["--cached"] : []),
        ...(reverse ? ["--reverse"] : []),
        "--whitespace=nowarn",
        "-",
      ], {
        cwd: this.info.rootPath,
        input: patch,
      });
    });
  }

  /**
   * IDEA's Create Patch from local changes: a patch of the given paths as they
   * differ from HEAD, including what is staged, in a form `git apply` and
   * IDEA's own Apply Patch both accept.
   *
   * `--src-prefix`/`--dst-prefix` are left at Git's defaults (`a/`, `b/`) so
   * the file keeps the `-p1` shape every patch tool expects, and `--binary`
   * keeps a binary change appliable instead of a bare "differ" line.
   */
  public async localChangesPatch(paths: readonly string[]): Promise<string> {
    if (!paths.length) throw new Error("Select at least one change to create a patch from.");
    const base = (await this.currentRevision()) ?? await this.emptyTree();
    return this.runner.text([
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-color",
      base,
      "--",
      ...literalPathspecs(paths),
    ], { cwd: this.info.rootPath });
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
        ["restore", `--source=${source}`, "--staged", "--worktree", "--", ...literalPathspecs(paths)],
        { cwd: this.info.rootPath },
      );
    });
  }

  public async cleanUntracked(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["clean", "-f", "--", ...literalPathspecs(paths)], { cwd: this.info.rootPath }));
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
      const track = parseUpstreamTrack(tracking);
      branches.push({
        name,
        fullName: refName,
        oid,
        kind,
        upstream: upstream || undefined,
        tracking: tracking || undefined,
        ...(track.ahead ? { ahead: track.ahead } : {}),
        ...(track.behind ? { behind: track.behind } : {}),
        ...(track.gone ? { upstreamGone: true } : {}),
      });
    }
    return branches;
  }

  public async remotes(): Promise<GitRemote[]> {
    const output = await this.runner.text(["remote", "-v"], { cwd: this.info.rootPath });
    const byName = new Map<string, GitRemote>();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      // `git remote -v` separates name and URL with a tab; the URL itself may
      // contain spaces (local paths), so splitting on whitespace drops remotes.
      const match = /^([^\t]+)\t(.+) \((fetch|push)\)$/.exec(line);
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

  public async pushRemote(name: string, refspec?: string, forceWithLease = false, signal?: AbortSignal, setUpstream = false): Promise<void> {
    await this.serial(() => this.runner.run([
      "push",
      ...(setUpstream && refspec ? ["--set-upstream"] : []),
      ...(forceWithLease ? ["--force-with-lease"] : []),
      name,
      ...(refspec ? [refspec] : []),
    ], { cwd: this.info.rootPath, signal }));
  }

  public async createTag(name: string, ref = "HEAD"): Promise<void> {
    await this.serial(async () => {
      const revision = await this.resolveCommit(ref);
      await this.runner.run(["tag", "--end-of-options", name, revision], { cwd: this.info.rootPath });
    });
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
    args.push("--end-of-options", worktreePath);
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
    await this.serial(() => this.runner.run(["submodule", "update", ...(init ? ["--init"] : []), ...(recursive ? ["--recursive"] : []), ...(paths.length ? ["--", ...literalPathspecs(paths)] : [])], { cwd: this.info.rootPath }));
  }

  public async stage(paths: readonly string[]): Promise<void> {
    await this.serial(() => this.runner.run(["add", "--", ...literalPathspecs(paths)], { cwd: this.info.rootPath }));
  }

  public async unstage(paths: readonly string[]): Promise<void> {
    await this.serial(async () => {
      const head = await this.currentRevision();
      if (head) {
        await this.runner.run(["reset", head, "--", ...literalPathspecs(paths)], { cwd: this.info.rootPath });
        return;
      }
      // An unborn repository has no HEAD for `git reset` to resolve. Removing
      // paths from the index keeps their working-tree contents intact.
      await this.runner.run(["rm", "--cached", "-r", "--ignore-unmatch", "--", ...literalPathspecs(paths)], { cwd: this.info.rootPath });
    });
  }

  public async discard(paths: readonly string[]): Promise<void> {
    await this.serial(async () => {
      const snapshot = await this.status();
      const requested = new Set(paths);
      const candidates = new Set(paths);
      const renamedTargets = new Set<string>();
      for (const change of snapshot.changes) {
        if (!requested.has(change.path) && (!change.originalPath || !requested.has(change.originalPath))) continue;
        candidates.add(change.path);
        if (change.originalPath) {
          candidates.add(change.originalPath);
          renamedTargets.add(change.path);
        }
      }

      const pathSpecs = [...candidates];
      const literalSpecs = literalPathspecs(pathSpecs);
      const head = await this.currentRevision();
      if (!head) {
        await this.runner.run(["rm", "--cached", "-r", "--ignore-unmatch", "--", ...literalSpecs], { cwd: this.info.rootPath });
        return;
      }

      const [treeOutput, indexOutput] = await Promise.all([
        this.runner.text(["ls-tree", "-r", "-z", "--name-only", head, "--", ...literalSpecs], { cwd: this.info.rootPath }),
        this.runner.text(["ls-files", "-z", "--cached", "--", ...literalSpecs], { cwd: this.info.rootPath }),
      ]);
      const treePaths = treeOutput.split("\0").filter(Boolean);
      const indexPaths = indexOutput.split("\0").filter(Boolean);
      const containsPath = (entries: readonly string[], candidate: string): boolean =>
        entries.includes(candidate) || entries.some((entry) => entry.startsWith(`${candidate}/`));
      const trackedAtHead = pathSpecs.filter((candidate) => containsPath(treePaths, candidate));
      const addedToIndex = pathSpecs.filter((candidate) =>
        !containsPath(treePaths, candidate) && containsPath(indexPaths, candidate));

      if (trackedAtHead.length) {
        await this.runner.run(
          ["restore", `--source=${head}`, "--staged", "--worktree", "--", ...literalPathspecs(trackedAtHead)],
          { cwd: this.info.rootPath },
        );
      }
      if (addedToIndex.length) {
        // IntelliJ-style rollback of a newly added file removes it from the
        // index but deliberately keeps the user's local file as untracked.
        await this.runner.run(["restore", "--staged", "--", ...literalPathspecs(addedToIndex)], { cwd: this.info.rootPath });
      }
      const obsoleteRenameTargets = addedToIndex.filter((candidate) => renamedTargets.has(candidate));
      if (obsoleteRenameTargets.length) {
        await this.runner.run(["clean", "-f", "--", ...literalPathspecs(obsoleteRenameTargets)], { cwd: this.info.rootPath });
      }
    });
  }

  public async resolveConflict(pathSpec: string, side: "ours" | "theirs"): Promise<void> {
    await this.serial(() => this.runner.run(["checkout", `--${side}`, "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath }));
  }

  /**
   * True when the bytes survive a UTF-8 round trip. NUL bytes mark classic binaries; a failed
   * round trip marks legacy encodings (Latin-1, Shift-JIS, GBK) whose bytes would silently
   * become U+FFFD replacement characters if edited as text and written back.
   */
  private static isEditableText(content: Buffer): boolean {
    if (content.includes(0)) return false;
    return Buffer.from(content.toString("utf8"), "utf8").equals(content);
  }

  /**
   * Recomputes the merge in `diff3` style so every conflict carries the base
   * text it started from.
   *
   * Git's working-tree conflict shows only the two sides, which cannot say
   * whether a side changed the text or simply kept it. The merge is replayed on
   * temporary copies of the three stages, so the user's in-progress edits in the
   * working tree are never touched.
   */
  public async conflictAnalysis(pathSpec: string): Promise<MergeBlock[]> {
    await this.assertConflictedPath(pathSpec);
    const stageModes = await this.conflictStageModes(pathSpec);
    const [base, ours, theirs] = await Promise.all([
      this.conflictStage(pathSpec, 1, stageModes),
      this.conflictStage(pathSpec, 2, stageModes),
      this.conflictStage(pathSpec, 3, stageModes),
    ]);
    for (const side of [base, ours, theirs]) {
      if (side !== null && !GitRepository.isEditableText(side)) {
        throw new Error(`${pathSpec} is not a text file, so its conflict cannot be analysed line by line.`);
      }
    }

    const directory = await mkdtemp(path.join(tmpdir(), "jb-git-merge-"));
    try {
      const files = { ours: path.join(directory, "ours"), base: path.join(directory, "base"), theirs: path.join(directory, "theirs") };
      // A missing stage is an add/add or delete/modify conflict; an empty file
      // is exactly how merge-file represents "this side has nothing here".
      await Promise.all([
        writeFile(files.ours, ours ?? Buffer.alloc(0)),
        writeFile(files.base, base ?? Buffer.alloc(0)),
        writeFile(files.theirs, theirs ?? Buffer.alloc(0)),
      ]);
      const merged = await this.runner.run([
        "merge-file", "-p", "--diff3",
        "-L", "ours", "-L", "base", "-L", "theirs",
        files.ours, files.base, files.theirs,
      ], {
        cwd: this.info.rootPath,
        // merge-file reports the number of remaining conflicts as its exit code,
        // so anything up to the marker limit is a normal result, not a failure.
        allowExitCodes: Array.from({ length: 128 }, (_, index) => index + 1),
      });
      const parsed = parseDiff3(merged.stdout.toString("utf8"));
      if (parsed.ambiguous) {
        throw new Error(`${pathSpec} contains conflict-marker lines of its own, so its conflict cannot be framed reliably.`);
      }
      return parsed.blocks;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  public async conflictVersions(pathSpec: string): Promise<GitConflictVersions> {
    await this.assertConflictedPath(pathSpec);
    const stageModes = await this.conflictStageModes(pathSpec);
    const [base, ours, theirs, workingTree] = await Promise.all([
      this.conflictStage(pathSpec, 1, stageModes),
      this.conflictStage(pathSpec, 2, stageModes),
      this.conflictStage(pathSpec, 3, stageModes),
      this.conflictWorkingTree(pathSpec),
    ]);
    const result = workingTree.content;
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
      // A symlink blob contains UTF-8-looking target text, but presenting it in
      // the text merge editor would turn the link into a regular file. Route
      // mode 120000 (and other special entries) through whole-side checkout.
      binary: workingTree.special
        || [...stageModes.values()].some((mode) => mode !== "100644" && mode !== "100755")
        || [base, ours, theirs, result].some((item) => item !== null && !GitRepository.isEditableText(item)),
    };
  }

  public async applyConflictResult(pathSpec: string, content: string, deleted = false): Promise<void> {
    await this.serial(async () => {
      await this.assertConflictedPath(pathSpec);
      const stageModes = await this.conflictStageModes(pathSpec);
      if ([...stageModes.values()].some((mode) => mode !== "100644" && mode !== "100755")) {
        throw new Error(`${pathSpec} is a symbolic-link or special-file conflict; resolve it by accepting ours or theirs.`);
      }
      const target = this.worktreePath(pathSpec);
      await this.assertSafeConflictParent(target);
      if (deleted) {
        const current = await this.conflictPathStat(target);
        if (current?.isSymbolicLink()) throw new Error(`Refusing to resolve ${pathSpec} through a symbolic link.`);
        await rm(target, { force: true });
      } else {
        await this.writeConflictResult(target, pathSpec, content);
      }
      await this.runner.run(["add", "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath });
    });
  }

  /**
   * Resolves the conflicts in a file that only have one sensible outcome once
   * the base is known, and leaves the rest for the user.
   *
   * The file is staged only when nothing is left to decide: staging a file that
   * still carries markers would tell Git the conflict was settled.
   */
  public async resolveSimpleConflicts(
    pathSpec: string,
    labels: Diff3Labels,
  ): Promise<{ resolved: number; remaining: number }> {
    return this.serial(async () => {
      const blocks = await this.conflictAnalysis(pathSpec);
      const stageModes = await this.conflictStageModes(pathSpec);
      if ([...stageModes.values()].some((mode) => mode !== "100644" && mode !== "100755")) {
        throw new Error(`${pathSpec} is a symbolic-link or special-file conflict; resolve it by accepting ours or theirs.`);
      }
      const outcome = resolveSimpleConflicts(blocks, labels);
      if (outcome.resolved === 0) return { resolved: 0, remaining: outcome.remaining };

      const target = this.worktreePath(pathSpec);
      await this.assertSafeConflictParent(target);
      await this.writeConflictResult(target, pathSpec, outcome.text);
      if (outcome.remaining === 0) {
        await this.runner.run(["add", "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath });
      }
      return { resolved: outcome.resolved, remaining: outcome.remaining };
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

  public async merge(ref: string, options: GitMergeOptions = {}): Promise<void> {
    await this.serial(() => this.runner.run(["merge", ...mergeArguments(options), "--", ref], { cwd: this.info.rootPath }));
  }

  public async rebase(ref: string, options: GitRebaseOptions = {}): Promise<void> {
    await this.serial(() => this.runner.run([
      "rebase",
      ...(options.rebaseMerges ? ["--rebase-merges"] : []),
      ...(options.onto ? ["--onto", options.onto] : []),
      ref,
    ], { cwd: this.info.rootPath }));
  }

  /**
   * IDEA's Fixup…: commits whatever is staged as a `fixup!` of `target`, the
   * commit the caller then folds it into. Returns the new commit's id.
   */
  public async commitFixup(target: string, noVerify = false): Promise<string> {
    return this.serial(async () => {
      const revision = await this.resolveCommit(target);
      await this.runner.run(["commit", `--fixup=${revision}`, ...(noVerify ? ["--no-verify"] : [])], { cwd: this.info.rootPath });
      return (await this.currentRevision()) ?? "";
    });
  }

  /** Folds the staged changes into HEAD, keeping its message: Fixup… aimed at the last commit. */
  public async amendStaged(expectedHead: string, noVerify = false): Promise<string> {
    return this.serial(async () => {
      const head = await this.currentRevision();
      if (!head || head.toLowerCase() !== expectedHead.toLowerCase()) {
        throw new Error("HEAD moved since the commit was selected; refresh the Log and try again.");
      }
      await this.runner.run(["commit", "--amend", "--no-edit", ...(noVerify ? ["--no-verify"] : [])], { cwd: this.info.rootPath });
      return (await this.currentRevision()) ?? "";
    });
  }

  /** HEAD's reflog subjects, newest first: the raw material of IDEA's Recent branches. */
  public async reflogSubjects(limit = 200): Promise<string[]> {
    try {
      const output = await this.runner.text(["reflog", "show", `--max-count=${Math.max(1, Math.min(limit, 5_000))}`, "--format=%gs", "HEAD"], { cwd: this.info.rootPath });
      return trimOutput(output).split(/\r?\n/).filter(Boolean);
    } catch (error) {
      // An unborn branch has no reflog; that is no recent history, not a failure.
      if (error instanceof GitCommandError) return [];
      throw error;
    }
  }

  /**
   * IDEA's Update on a local branch that is not checked out: fetches its
   * configured upstream straight into the branch, fast-forward only — Git
   * refuses a non-fast-forward refspec without a `+`, which is the point.
   * The checked-out branch is refused here because Git refuses to move it
   * from a fetch; that case is a pull.
   */
  public async updateBranch(name: string): Promise<void> {
    await this.serial(async () => {
      const current = trimOutput(await this.runner.text(["branch", "--show-current"], { cwd: this.info.rootPath }));
      if (current === name) throw new Error(`'${name}' is checked out; pull it instead.`);
      const [remote, merge] = await Promise.all([
        this.configValue(`branch.${name}.remote`),
        this.configValue(`branch.${name}.merge`),
      ]);
      if (!remote || !merge) throw new Error(`'${name}' has no upstream to update from.`);
      await this.runner.run(["fetch", remote, `${merge}:refs/heads/${name}`], { cwd: this.info.rootPath });
    });
  }

  private async configValue(key: string): Promise<string | undefined> {
    try {
      return trimOutput(await this.runner.text(["config", "--get", key], { cwd: this.info.rootPath })) || undefined;
    } catch (error) {
      if (error instanceof GitCommandError) return undefined;
      throw error;
    }
  }

  /**
   * The authors of the recent history, most recent first and without
   * repeats — the completions IDEA's Author field offers.
   */
  public async recentAuthors(limit = 100): Promise<string[]> {
    const head = await this.currentRevision();
    if (!head) return [];
    const output = await this.runner.text(["log", `--max-count=${Math.max(1, Math.min(limit, 1_000))}`, "--format=%an%x00%ae", head], { cwd: this.info.rootPath });
    const seen = new Set<string>();
    const authors: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      const [name, email] = line.split("\0");
      if (!name) continue;
      const author = email ? `${name} <${email}>` : name;
      if (seen.has(author)) continue;
      seen.add(author);
      authors.push(author);
    }
    return authors;
  }

  /**
   * The text of the configured `commit.template`, or undefined when there is
   * none. A path starting with `~` is the user's home, as Git reads it; a
   * relative one is relative to the working tree.
   */
  /** `core.commentChar`, which decides which lines `--cleanup=strip` drops. */
  public async commentChar(): Promise<string> {
    return (await this.configValue("core.commentChar")) || DEFAULT_COMMENT_CHAR;
  }

  public async commitTemplate(): Promise<string | undefined> {
    let configured: string;
    try {
      configured = trimOutput(await this.runner.text(["config", "--get", "--path", "commit.template"], { cwd: this.info.rootPath }));
    } catch (error) {
      if (error instanceof GitCommandError) return undefined;
      throw error;
    }
    if (!configured) return undefined;
    const file = path.isAbsolute(configured) ? configured : path.resolve(this.info.rootPath, configured);
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Upper bound on a plan the sequence editor will build, keeping the todo reviewable and the panel responsive. */
  private static readonly INTERACTIVE_REBASE_LIMIT = 1_000;

  /**
   * Lists the commits an interactive rebase from `base` would replay, oldest
   * first, which is the order Git's todo uses.
   *
   * `base` has to be an ancestor of HEAD. That keeps the approved plan and Git's
   * own todo identical: rebasing onto an unrelated branch lets Git silently drop
   * commits it considers already upstream, so the user would approve a plan Git
   * never carries out.
   */
  public async interactiveRebaseCandidates(base: string): Promise<GitCommit[]> {
    const revision = await this.resolveCommit(base);
    const count = Number(trimOutput(await this.runner.text(["rev-list", "--count", ...GitRepository.REBASE_RANGE_FLAGS, `${revision}...HEAD`], { cwd: this.info.rootPath })));
    if (!Number.isSafeInteger(count)) throw new Error("Git could not count the commits to rebase.");
    if (count > GitRepository.INTERACTIVE_REBASE_LIMIT) {
      // Truncating instead would produce a todo missing commits Git expects,
      // which rewrites history differently from the reviewed plan.
      throw new Error(`${count} commits is beyond the ${GitRepository.INTERACTIVE_REBASE_LIMIT}-commit interactive rebase limit. Start from a later commit.`);
    }
    const commits = await this.rebaseRange(revision, GitRepository.INTERACTIVE_REBASE_LIMIT);
    const merges = commits.filter((commit) => commit.parents.length > 1);
    if (merges.length > 0) {
      throw new Error(`This range contains ${merges.length} merge commit(s), which an interactive rebase would flatten. Start from a commit after the last merge.`);
    }
    return commits.reverse();
  }

  /**
   * How `git rebase` itself chooses what to replay onto `upstream`: the commits
   * reachable from HEAD and not from upstream, minus those whose patch is
   * already upstream. For an upstream that is an ancestor of HEAD this is
   * simply `upstream..HEAD`; for a diverged branch it is the plan Git would
   * have generated, so the reviewed todo matches what Git would have done.
   */
  private static readonly REBASE_RANGE_FLAGS = ["--right-only", "--cherry-pick"] as const;

  private async rebaseRange(upstream: string, limit: number): Promise<GitCommit[]> {
    return this.readLog([...GitRepository.REBASE_RANGE_FLAGS, `${upstream}...HEAD`], limit);
  }

  /**
   * Runs an interactive rebase from an explicit plan.
   *
   * The plan is handed over as a complete todo file, so Git never consults an
   * editor and the operation cannot stall waiting for one. Scratch files live
   * under the Git directory rather than the system temp directory because a
   * conflict suspends the sequence for as long as the user needs, and `exec`
   * lines must still find their message files on `--continue`.
   */
  public async interactiveRebase(
    base: string,
    steps: readonly RebaseStep[],
    expectation?: InteractiveRebaseExpectation,
  ): Promise<void> {
    await this.serial(async () => {
      const operation = await this.operationState();
      if (operation.kind !== "none") {
        throw new Error(`A ${operation.kind} is already in progress. Finish or abort it before rebasing.`);
      }
      const status = await this.status();
      const revision = await this.resolveCommit(base);
      const planProblem = validateRebasePlan(steps);
      if (planProblem) throw new Error(planProblem);
      if (expectation) await this.verifyRebaseExpectation(revision, steps, expectation, status);
      // Only a tracked change blocks a rebase. Git itself replays happily over
      // untracked files and only complains about one it would actually
      // overwrite, so counting them here refused a rebase Git would have run.
      const blocking = status.changes.filter((change) => change.kind !== "untracked" && change.kind !== "ignored");
      if (blocking.length > 0) {
        // `rebase.autoStash` would mix an unrelated stash into a history
        // rewrite and restore it without asking; the caller offers an explicit
        // stash instead, and a failed restore there leaves a recoverable entry.
        throw new Error(`${blocking.length} local change(s) would block the rebase. Commit, shelve, or stash them first.`);
      }
      const scratch = path.join(this.info.gitDir, "jb-git-rebase");
      // A previous plan's files are dead once a new one starts, and cleanup
      // cannot run at the end of a rebase that paused on a conflict.
      await rm(scratch, { recursive: true, force: true });
      let keepScratch = false;
      let rebaseInvoked = false;
      try {
        await mkdir(scratch, { recursive: true });
        const plan = buildRebaseTodo(steps, scratch, this.runner.gitPath);
        const todoPath = path.join(scratch, "todo");
        await writeFile(todoPath, plan.todo, "utf8");
        for (const message of plan.messages) {
          await writeFile(path.join(scratch, message.name), message.content, "utf8");
        }
        // Writing the todo can take long enough for another worktree to move
        // HEAD. Verify once more immediately before handing control to Git.
        if (expectation) await this.verifyRebaseExpectation(revision, steps, expectation);
        rebaseInvoked = true;
        await this.runner.run([
          // Config that rewrites the todo is pinned off so the plan Git runs is
          // the plan that was reviewed, whatever the user has configured.
          "-c", "rebase.autoSquash=false",
          "-c", "rebase.autoStash=false",
          "-c", "rebase.updateRefs=false",
          "-c", "rebase.rebaseMerges=false",
          "rebase", "--interactive", revision,
        ], {
          cwd: this.info.rootPath,
          // An inherited GIT_SEQUENCE_EDITOR outranks `sequence.editor`, so the
          // user's real editor would open and block while holding the mutex.
          // Git runs this through its own shell, which `cp` is always part of.
          env: { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(posixPath(todoPath))}` },
        });
        keepScratch = (await this.operationState()).kind === "rebase";
      } finally {
        // A conflict or an `edit` stop needs the message files for Continue;
        // every other exit (including a preflight/write failure) must not leave
        // stale sensitive commit messages under .git forever.
        if (!keepScratch) {
          const paused = await this.operationState().then((state) => state.kind === "rebase").catch(() => rebaseInvoked);
          if (!paused) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    });
  }

  public async cherryPick(hash: string): Promise<void> {
    await this.serial(async () => {
      // `cherry-pick` and `revert` hand whatever survives their own option
      // parser to `setup_revisions()`, which parses option-like tokens a
      // second time. The `--end-of-options` that stopped the first parser has
      // already been consumed by then, so free-form input is pinned to a
      // resolved commit hash the same way `bisect` is.
      const revision = await this.resolveCommit(hash);
      await this.runner.run(["cherry-pick", revision], { cwd: this.info.rootPath });
    });
  }

  /** Applies a reviewed sequence while holding one repository lock and refreshes only once upstream. */
  public async cherryPickMany(hashes: readonly string[], signal?: AbortSignal, onApplied?: (count: number) => void): Promise<void> {
    if (hashes.length === 0) throw new Error("Batch cherry-pick needs at least one commit.");
    await this.serial(async () => {
      let applied = 0;
      for (const hash of hashes) {
        if (signal?.aborted) throw new GitAbortError();
        try {
          // The log already supplied complete object IDs.  Avoid a second
          // rev-parse per commit while retaining the same safe argument shape.
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)) {
            throw new Error("Batch cherry-pick received an invalid commit ID.");
          }
          await this.runner.run(["cherry-pick", hash], { cwd: this.info.rootPath, signal });
          applied += 1;
          try { onApplied?.(applied); } catch { /* progress reporting must not change Git's outcome */ }
        } catch (error) {
          throw new GitBatchError(applied, hash, error);
        }
      }
    });
  }

  public async revert(hash: string): Promise<void> {
    await this.serial(async () => {
      const revision = await this.resolveCommit(hash);
      await this.runner.run(["revert", "--no-edit", revision], { cwd: this.info.rootPath });
    });
  }

  public async reset(ref: string, mode: GitResetMode): Promise<void> {
    await this.serial(async () => {
      const revision = await this.resolveCommit(ref);
      await this.runner.run(["reset", `--${mode}`, revision], { cwd: this.info.rootPath });
    });
  }

  /**
   * IDEA's Undo Commit: moves the branch back to the commit's parent and
   * leaves everything the commit contained staged, so it can be recommitted.
   *
   * `expectedHead` is the commit the user looked at. It is compared with HEAD
   * inside the mutex, because a commit that landed in between would otherwise
   * be the one silently undone; a merge is refused, since undoing it to one
   * parent would stage the other side's whole history as local changes.
   */
  public async undoCommit(expectedHead: string): Promise<void> {
    await this.serial(async () => {
      const head = await this.currentRevision();
      if (!head || head.toLowerCase() !== expectedHead.toLowerCase()) {
        throw new Error("HEAD moved since the commit was selected; refresh the Log and try again.");
      }
      const parents = trimOutput(await this.runner.text(["show", "-s", "--format=%P", head], { cwd: this.info.rootPath })).split(/\s+/).filter(Boolean);
      if (parents.length === 0) throw new Error("The root commit has no parent to move the branch back to.");
      if (parents.length > 1) throw new Error("A merge commit cannot be undone from the Log; use Reset instead.");
      await this.runner.run(["reset", "--soft", parents[0]], { cwd: this.info.rootPath });
    });
  }

  /**
   * IDEA's Edit Commit Message on the last commit: replaces HEAD's message
   * without touching its tree. `--only` with no paths is Git's way of saying
   * "amend the message alone", so whatever is staged stays staged for the next
   * commit instead of being swept into this one.
   */
  public async rewordHead(expectedHead: string, message: string): Promise<string> {
    return this.serial(async () => {
      const head = await this.currentRevision();
      if (!head || head.toLowerCase() !== expectedHead.toLowerCase()) {
        throw new Error("HEAD moved since the commit was selected; refresh the Log and try again.");
      }
      await this.runner.run(["commit", "--amend", "--only", "--allow-empty", "--file=-"], { cwd: this.info.rootPath, input: message });
      return (await this.currentRevision()) ?? "";
    });
  }

  /** True when `revision` is already contained in some remote-tracking branch, i.e. it has been pushed. */
  public async isPushed(revision: string): Promise<boolean> {
    const output = await this.runner.text(
      ["branch", "--remotes", "--contains", revision, "--format=%(refname)"],
      { cwd: this.info.rootPath },
    );
    return trimOutput(output).length > 0;
  }

  /**
   * Resolves a conflict by taking one side whole, the way IDEA's Accept Yours
   * / Accept Theirs do. A side that deleted the file is honoured by deleting
   * it, since there is no content to check out; the path leaves the index as
   * resolved either way.
   */
  public async acceptConflictSide(pathSpec: string, side: "ours" | "theirs"): Promise<void> {
    await this.serial(async () => {
      await this.assertConflictedPath(pathSpec);
      const stage = side === "ours" ? "2" : "3";
      const entries = trimOutput(await this.runner.text(["ls-files", "--unmerged", "-z", "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath }));
      const hasSide = entries.split("\0").some((entry) => /^\d+ [0-9a-f]+ (\d)\t/.exec(entry)?.[1] === stage);
      if (hasSide) {
        await this.runner.run(["checkout", `--${side}`, "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath });
        await this.runner.run(["add", "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath });
      } else {
        await this.runner.run(["rm", "--quiet", "--force", "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath });
      }
    });
  }

  /**
   * Appends one ignore rule: to the repository's top-level `.gitignore`, or to
   * `info/exclude`, which is private to this clone. The exclude file lives in
   * the common Git directory, so a linked worktree shares it with the others.
   */
  public async addIgnoreRule(target: GitIgnoreTarget, line: string): Promise<string> {
    const file = target === "exclude"
      ? path.join(this.info.commonGitDir, "info", "exclude")
      : path.join(this.info.rootPath, ".gitignore");
    await this.serial(async () => {
      let existing = "";
      try {
        existing = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const updated = appendIgnoreLine(existing, line);
      if (updated === existing) return;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, updated, "utf8");
    });
    return file;
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
      await this.runner.run(["restore", `--source=${revision}`, "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath });
    });
  }

  public async continueOperation(kind: Exclude<import("./types").GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    const command = kind === "merge" ? "merge" : kind === "rebase" ? "rebase" : kind === "cherry-pick" ? "cherry-pick" : "revert";
    await this.serial(async () => {
      try {
        await this.runner.run([command, "--continue"], { cwd: this.info.rootPath });
      } finally {
        await this.cleanupRebaseScratchIfFinished();
      }
    });
  }

  public async abortOperation(kind: Exclude<import("./types").GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    const command = kind === "merge" ? "merge" : kind === "rebase" ? "rebase" : kind === "cherry-pick" ? "cherry-pick" : "revert";
    await this.serial(async () => {
      try {
        await this.runner.run([command, "--abort"], { cwd: this.info.rootPath });
      } finally {
        await this.cleanupRebaseScratchIfFinished();
      }
    });
  }

  public async bisectStart(bad: string, good: string): Promise<void> {
    await this.serial(async () => {
      // `git bisect` has its own option parser, so free-form input is pinned
      // to resolved commit hashes instead of `--end-of-options`.
      const [badRevision, goodRevision] = await Promise.all([this.resolveCommit(bad), this.resolveCommit(good)]);
      await this.runner.run(["bisect", "start", badRevision, goodRevision], { cwd: this.info.rootPath });
    });
  }

  public async bisectGood(ref = "HEAD"): Promise<void> {
    await this.serial(async () => {
      const revision = await this.resolveCommit(ref);
      await this.runner.run(["bisect", "good", revision], { cwd: this.info.rootPath });
    });
  }

  public async bisectBad(ref = "HEAD"): Promise<void> {
    await this.serial(async () => {
      const revision = await this.resolveCommit(ref);
      await this.runner.run(["bisect", "bad", revision], { cwd: this.info.rootPath });
    });
  }

  public async bisectSkip(): Promise<void> {
    await this.serial(() => this.runner.run(["bisect", "skip"], { cwd: this.info.rootPath }));
  }

  public async bisectReset(ref?: string): Promise<void> {
    await this.serial(() => this.runner.run(["bisect", "reset", ...(ref ? [ref] : [])], { cwd: this.info.rootPath }));
  }

  public async skipOperation(kind: "rebase" | "cherry-pick"): Promise<void> {
    await this.serial(async () => {
      try {
        await this.runner.run([kind, "--skip"], { cwd: this.info.rootPath });
      } finally {
        await this.cleanupRebaseScratchIfFinished();
      }
    });
  }

  public async commit(message: string, options: GitCommitOptions = {}): Promise<string> {
    return this.serial(async () => {
      const args = ["commit", "--file=-", ...commitOptionArguments(options)];
      await this.runner.run(args, { cwd: this.info.rootPath, input: message });
      return (await this.currentRevision()) ?? "";
    });
  }

  /**
   * Commits complete selected paths through an isolated index. The user's real
   * index is untouched if staging or hooks fail, so partial staging is not lost.
   */
  /**
   * Selects which hunks of one path a partial commit takes.
   *
   * The two Changelist cases are genuinely different and cannot share one set
   * of names: a list that claimed hunks out of somebody else's file commits
   * exactly those, while the list the file belongs to commits everything the
   * others did not claim — including a hunk that appeared since.
   */
  private static selectHunks(
    selection: HunkSelection,
    hunks: readonly GitDiffHunk[],
    keys: readonly string[],
    pathSpec: string,
  ): GitDiffHunk[] {
    if (selection.mode === "except") {
      const excluded = new Set(selection.keys);
      return hunks.filter((_hunk, index) => !excluded.has(keys[index]));
    }
    const wanted = new Set(selection.keys);
    const chosen = hunks.filter((_hunk, index) => wanted.has(keys[index]));
    if (chosen.length !== wanted.size) {
      // Reconciliation drops a claim whose hunk is gone, so a mismatch here
      // means the file moved on since the last refresh. Committing the rest
      // would quietly commit something the user never reviewed.
      throw new Error(`The changes selected in '${pathSpec}' are no longer the ones on disk. Refresh Local Changes and commit again.`);
    }
    return chosen;
  }

  public async commitPaths(
    paths: readonly string[],
    message: string,
    options: GitCommitOptions = {},
    hunkSelections?: ReadonlyMap<string, HunkSelection>,
  ): Promise<string> {
    return this.serial(async () => {
      if (paths.length === 0) throw new Error("No paths were selected for the commit.");
      // A partial commit during a merge, cherry-pick, or revert would conclude that operation:
      // MERGE_HEAD turns the temp-index commit into a two-parent merge whose tree silently
      // drops everything the operation had staged, and the trailing reset erases the unmerged
      // entries, so the half-done merge looks finished.
      const operation = await this.operationState();
      if (operation.kind !== "none") {
        throw new Error(`A ${operation.kind} is in progress. Resolve it and use a full commit; committing selected paths would ${operation.kind === "rebase" || operation.kind === "bisect" ? "interfere with it" : "conclude it and discard the other side's staged changes"}.`);
      }
      const selected = new Set(paths);
      const status = await this.status();
      const conflictedSelection = status.changes.find((change) => change.conflicted && selected.has(change.path));
      if (conflictedSelection) {
        throw new Error(`'${conflictedSelection.path}' has unresolved conflicts. Resolve them before committing.`);
      }
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
        const whole = pathSpecs.filter((pathSpec) => !hunkSelections?.has(pathSpec));
        if (whole.length > 0) {
          await this.runner.run(["add", "-A", "--", ...literalPathspecs(whole)], { cwd: this.info.rootPath, env: environment });
        }
        for (const [pathSpec, selection] of hunkSelections ?? []) {
          if (!pathSpecs.includes(pathSpec)) continue;
          const { output, hunks } = await this.diffAgainstHead(pathSpec);
          if (hunks.length === 0) {
            throw new Error(`'${pathSpec}' no longer differs from HEAD, so there is nothing of it to commit.`);
          }
          const chosen = GitRepository.selectHunks(selection, hunks, hunkKeys(hunks), pathSpec);
          if (chosen.length === 0) continue;
          // The patch was taken against HEAD and the temporary index was seeded
          // from HEAD, so it applies to exactly the side it was measured from.
          // --cached leaves the working tree alone, which is what keeps the
          // hunks the other Changelists own where they are.
          await this.runner.run(["apply", "--cached", "--whitespace=nowarn", "-"], {
            cwd: this.info.rootPath,
            env: environment,
            input: patchForHunks(output, chosen),
          });
        }
        const args = ["commit", "--file=-", ...commitOptionArguments(options)];
        await this.runner.run(args, { cwd: this.info.rootPath, env: environment, input: message });

        // The selected working-tree content is now HEAD. Align the real index
        // with that commit; callers reject staged changes outside these paths.
        await this.runner.run(["reset", "--mixed", "HEAD"], { cwd: this.info.rootPath });
        return (await this.currentRevision()) ?? "";
      } finally {
        // Never let cleanup failure replace the commit's own error.
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
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
    const output = await this.runner.text(["stash", "list", "--format=%gd%x00%H%x00%gs"], { cwd: this.info.rootPath });
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [ref, oid, message] = line.split("\0");
      return { ref, oid: oid ?? "", message: message ?? "" };
    });
  }

  /**
   * Positional `stash@{N}` refs shift whenever the stash list changes, so a captured ref can
   * point at a different stash by the time the user confirms. When the entry's commit is
   * known, re-resolve the current position from it and refuse if it is gone.
   */
  private async resolveStashRef(ref: string, oid?: string): Promise<string> {
    if (!oid) return ref;
    const entries = await this.stashes();
    const found = entries.find((entry) => entry.oid === oid);
    if (!found) throw new Error("That stash no longer exists; the list has changed since it was read.");
    return found.ref;
  }

  public async applyStash(ref: string, pop = false, oid?: string, reinstateIndex = false): Promise<void> {
    await this.serial(async () => {
      const current = await this.resolveStashRef(ref, oid);
      await this.runner.run(["stash", pop ? "pop" : "apply", ...(reinstateIndex ? ["--index"] : []), current], { cwd: this.info.rootPath });
    });
  }

  public async dropStash(ref: string, oid?: string): Promise<void> {
    await this.serial(async () => {
      const current = await this.resolveStashRef(ref, oid);
      await this.runner.run(["stash", "drop", current], { cwd: this.info.rootPath });
    });
  }

  /** True when `pathSpec` is a file in HEAD's tree — the precondition for a line-range history. */
  public async isTrackedAtHead(pathSpec: string): Promise<boolean> {
    const head = await this.currentRevision();
    if (!head) return false;
    const output = await this.runner.text(["ls-tree", "-z", "--name-only", head, "--", literalPathspec(pathSpec)], { cwd: this.info.rootPath });
    return output.split("\0").includes(pathSpec.replaceAll("\\", "/"));
  }

  public async fileContent(pathSpec: string, revision?: string, signal?: AbortSignal): Promise<Buffer> {
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
      const result = await this.runner.run(["show", objectSpec], { cwd: this.info.rootPath, signal });
      return result.stdout;
    } catch (error) {
      if (error instanceof GitCommandError && /(?:does not exist|exists on disk, but not in|path .* not in|invalid object name ['\"]?(?:HEAD|INDEX))/i.test(error.stderr)) return Buffer.alloc(0);
      throw error;
    }
  }

  /**
   * Checks out a ref.
   *
   * `fullRef` is preferred because `%(refname:short)` disambiguates a name shared by a branch
   * and a tag by lengthening it ("heads/v1"), and neither `git switch heads/v1` nor
   * `refs/tags/tags/v1` is a usable reference.
   */
  public async checkout(branch: string, kind?: GitBranch["kind"], fullRef?: string): Promise<void> {
    await this.serial(async () => {
      const tagRef = fullRef?.startsWith("refs/tags/") ? fullRef : undefined;
      const isTag = kind === "tag" || Boolean(tagRef) || (kind === undefined && !fullRef && await this.hasRef(`refs/tags/${branch}`));
      if (isTag) {
        await this.runner.run(["switch", "--detach", tagRef ?? `refs/tags/${branch}`], { cwd: this.info.rootPath });
        return;
      }
      const isRemote = fullRef ? fullRef.startsWith("refs/remotes/") : await this.hasRef(`refs/remotes/${branch}`);
      const remoteName = fullRef?.startsWith("refs/remotes/") ? fullRef.slice("refs/remotes/".length) : branch;
      // git switch takes a branch name, so drop the ref namespace and, for a remote-tracking
      // ref, the remote itself: `origin/main` is checked out as the local branch `main`.
      const localName = fullRef?.startsWith("refs/heads/")
        ? fullRef.slice("refs/heads/".length)
        : isRemote ? remoteName.split("/").slice(1).join("/") : branch;
      if (isRemote && !(await this.hasRef(`refs/heads/${localName}`))) {
        await this.runner.run(["switch", "--track", remoteName], { cwd: this.info.rootPath });
        return;
      }
      await this.runner.run(["switch", localName], { cwd: this.info.rootPath });
    });
  }

  public async init(): Promise<void> {
    await this.serial(() => this.runner.run(["init"], { cwd: this.info.rootPath }));
  }

  public async currentRevision(signal?: AbortSignal): Promise<string | null> {
    try {
      return trimOutput(await this.runner.text(["rev-parse", "HEAD"], { cwd: this.info.rootPath, signal }));
    } catch (error) {
      if (isGitAbort(error)) throw error;
      if (error instanceof GitCommandError) return null;
      throw error;
    }
  }

  private async assertConflictedPath(pathSpec: string): Promise<void> {
    const change = (await this.status()).changes.find((candidate) => candidate.path === pathSpec);
    if (!change?.conflicted) throw new Error(`${pathSpec} is no longer an unresolved conflict.`);
  }

  private async conflictStageModes(pathSpec: string): Promise<Map<1 | 2 | 3, string>> {
    const output = await this.runner.text(
      ["ls-files", "--unmerged", "-z", "--", literalPathspec(pathSpec)],
      { cwd: this.info.rootPath },
    );
    const modes = new Map<1 | 2 | 3, string>();
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      const match = /^(\d{6}) [0-9a-f]+ ([123])\t/.exec(entry);
      if (!match) throw new Error(`Git returned an invalid conflict entry for ${pathSpec}.`);
      modes.set(Number(match[2]) as 1 | 2 | 3, match[1]);
    }
    if (modes.size === 0) throw new Error(`${pathSpec} is no longer an unresolved conflict.`);
    return modes;
  }

  private async conflictStage(
    pathSpec: string,
    stage: 1 | 2 | 3,
    modes: ReadonlyMap<1 | 2 | 3, string>,
  ): Promise<Buffer | null> {
    if (!modes.has(stage)) return null;
    return (await this.runner.run(["show", `:${stage}:${pathSpec}`], { cwd: this.info.rootPath })).stdout;
  }

  private async conflictWorkingTree(pathSpec: string): Promise<{ content: Buffer | null; special: boolean }> {
    const target = this.worktreePath(pathSpec);
    await this.assertSafeConflictParent(target);
    const initial = await this.conflictPathStat(target);
    if (!initial) return { content: null, special: false };
    if (initial.isSymbolicLink()) {
      try {
        return { content: await readlink(target, { encoding: "buffer" }), special: true };
      } catch (error) {
        throw new Error(`Conflict path ${pathSpec} changed while it was being read.`, { cause: error });
      }
    }
    if (!initial.isFile()) return { content: Buffer.alloc(0), special: true };
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
        throw new Error(`Conflict path ${pathSpec} changed while it was being read.`);
      }
      return { content: await handle.readFile(), special: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`Refusing to read conflict path ${pathSpec} through a symbolic link.`, { cause: error });
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async conflictPathStat(target: string): Promise<Stats | null> {
    try {
      return await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async assertSafeConflictParent(target: string): Promise<void> {
    const relativeParent = path.relative(this.info.rootPath, path.dirname(target));
    let current = this.info.rootPath;
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to access a conflict below symbolic-link directory ${current}.`);
      if (!stat.isDirectory()) throw new Error(`Conflict parent ${current} is not a directory.`);
    }
  }

  private async writeConflictResult(target: string, pathSpec: string, content: string): Promise<void> {
    const initial = await this.conflictPathStat(target);
    if (initial?.isSymbolicLink()) throw new Error(`Refusing to write conflict path ${pathSpec} through a symbolic link.`);
    if (initial && !initial.isFile()) throw new Error(`Conflict path ${pathSpec} is not a regular file.`);

    const temporaryDirectory = await mkdtemp(path.join(path.dirname(target), ".jb-git-conflict-"));
    const temporaryFile = path.join(temporaryDirectory, "result");
    try {
      await writeFile(temporaryFile, content, { encoding: "utf8", mode: initial ? initial.mode & 0o777 : 0o666 });
      const current = await this.conflictPathStat(target);
      if (current?.isSymbolicLink()) throw new Error(`Refusing to write conflict path ${pathSpec} through a symbolic link.`);
      if (current && !current.isFile()) throw new Error(`Conflict path ${pathSpec} is not a regular file.`);
      if ((initial === null) !== (current === null)
        || (initial && current && (initial.dev !== current.dev || initial.ino !== current.ino))) {
        throw new Error(`Conflict path ${pathSpec} changed while it was being written.`);
      }
      await rename(temporaryFile, target);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private worktreePath(pathSpec: string): string {
    if (!pathSpec || path.isAbsolute(pathSpec)) throw new Error("Conflict path must be relative to the repository.");
    const resolved = path.resolve(this.info.rootPath, pathSpec);
    const relative = path.relative(this.info.rootPath, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Conflict path is outside the repository.");
    }
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

  /** True when `ancestor` is reachable from `descendant`, distinguishing Git's "no" (exit 1) from a real failure. */
  private async hasRef(ref: string): Promise<boolean> {
    try {
      await this.runner.run(["show-ref", "--verify", "--quiet", ref], { cwd: this.info.rootPath });
      return true;
    } catch (error) {
      if (error instanceof GitCommandError) return false;
      throw error;
    }
  }

  private async resolveCommit(ref: string, signal?: AbortSignal): Promise<string> {
    return trimOutput(await this.runner.text(
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { cwd: this.info.rootPath, signal },
    ));
  }

  private async emptyTree(): Promise<string> {
    return trimOutput(await this.runner.text(["mktree"], { cwd: this.info.rootPath, input: "" }));
  }

  private async cleanupRebaseScratchIfFinished(): Promise<void> {
    try {
      if ((await this.operationState()).kind !== "rebase") {
        await rm(path.join(this.info.gitDir, "jb-git-rebase"), { recursive: true, force: true });
      }
    } catch {
      // Cleanup is best effort and must not replace the Git command's result.
    }
  }

  private async verifyRebaseExpectation(
    revision: string,
    steps: readonly RebaseStep[],
    expectation: InteractiveRebaseExpectation,
    knownStatus?: GitStatusSnapshot,
  ): Promise<void> {
    const status = knownStatus ?? await this.status();
    // The plan was reviewed outside this mutex. Re-read the branch and the
    // complete range before writing the replacement todo; otherwise a commit
    // created in another worktree during confirmation would be silently
    // omitted by Git and disappear from the branch.
    if (status.branch.oid !== expectation.head
      || (expectation.branch !== undefined && status.branch.head !== expectation.branch)) {
      throw new Error("The branch changed while the rebase plan was being reviewed. Reload the history and try again.");
    }
    const current = (await this.rebaseRange(revision, Math.max(1, expectation.commits.length + 1))).reverse();
    if (!sameObjectIdSequence(current.map((commit) => commit.hash), expectation.commits)) {
      throw new Error("The commit history changed while the rebase plan was being reviewed. Reload the history and try again.");
    }
    const planned = steps.map((step) => step.oid);
    if (!sameObjectIdSet(planned, expectation.commits)) {
      throw new Error("The rebase plan no longer covers the reviewed commits. Close the editor and start again.");
    }
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

/** The flags shared by every commit path: amend, sign-off, hooks, author and comment handling. */
export function commitOptionArguments(options: GitCommitOptions): string[] {
  const author = options.author?.trim();
  if (author && /[\r\n\0]/.test(author)) throw new Error("The author must be a single line.");
  return [
    ...(options.amend ? ["--amend"] : []),
    ...(options.signoff ? ["--signoff"] : []),
    ...(options.noVerify ? ["--no-verify"] : []),
    ...(author ? [`--author=${author}`] : []),
    ...(options.stripComments ? ["--cleanup=strip"] : []),
  ];
}

/**
 * The flags for IDEA's merge options. Combinations Git itself rejects are
 * refused here with a sentence instead of Git's terse "cannot combine".
 */
export function mergeArguments(options: GitMergeOptions): string[] {
  if (options.squash && options.noFastForward) throw new Error("A squash merge never creates a merge commit, so it cannot also be --no-ff.");
  if (options.squash && options.fastForwardOnly) throw new Error("A squash merge cannot be fast-forward only.");
  if (options.noFastForward && options.fastForwardOnly) throw new Error("--no-ff and --ff-only contradict each other.");
  return [
    ...(options.noFastForward ? ["--no-ff"] : []),
    ...(options.fastForwardOnly ? ["--ff-only"] : []),
    ...(options.squash ? ["--squash"] : []),
    ...(options.noCommit && !options.squash ? ["--no-commit"] : []),
    ...(options.allowUnrelatedHistories ? ["--allow-unrelated-histories"] : []),
  ];
}

/**
 * Git's `-L<start>,<end>:<file>` argument. The range is 1-based and inclusive;
 * the file is read literally after the first colon, so a colon inside the
 * path is fine. A range Git could not honour is refused here, before it
 * becomes a confusing "file has only N lines" error from the log.
 */
export function lineRangeArgument(range: { path: string; start: number; end: number }): string {
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error(`Invalid line range ${start}-${end}.`);
  }
  const file = range.path.replaceAll("\\", "/");
  if (!file || file.includes("\0") || /[\r\n]/.test(file)) throw new Error("Invalid file path for a line range.");
  return `-L${start},${end}:${file}`;
}

function sameObjectIdSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value.toLowerCase() === right[index].toLowerCase());
}

function sameObjectIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right.map((value) => value.toLowerCase()));
  return new Set(left.map((value) => value.toLowerCase())).size === expected.size
    && left.every((value) => expected.has(value.toLowerCase()));
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
        gitDir: resolveGitDir(workspacePath, gitDirRaw),
        commonGitDir: resolveGitDir(workspacePath, commonGitDirRaw),
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
