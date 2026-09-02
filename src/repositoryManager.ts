import * as vscode from "vscode";
import { discoverRepositories, discoverRepository, GitRepository } from "./git/repository";
import * as path from "node:path";
import { GitRunner, isGitAbort } from "./git/runner";
import { type InteractiveRebaseExpectation, type RebaseStep } from "./interactiveRebase";
import { type Diff3Labels, type MergeBlock } from "./mergeAnalysis";
import { type HunkSelection } from "./changelists/hunkOwnership";
import { GitBlameEntry, GitBlameOptions, GitBranch, GitCommit, GitCommitFile, GitCommitOptions, GitConflictVersions, GitDiffHunk, GitIgnoreTarget, GitMergeOptions, GitOperationKind, GitRebaseOptions, GitOperationState, GitPullStrategy, GitRemote, GitResetMode, GitStashEntry, GitStatusSnapshot, GitSubmodule, GitWorktree } from "./git/types";

export interface RepositorySnapshot {
  repository: GitRepository;
  status: GitStatusSnapshot | null;
  branches: GitBranch[];
  operation: GitOperationState;
  error?: string;
}

/** Lease held across a compound stash/rebase workflow. */
export interface RepositoryMutationLease {
  readonly rootPath: string;
  readonly token: symbol;
}

export class RepositoryManager implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly activeLeases = new Map<string, RepositoryMutationLease>();
  private repositories: GitRepository[] = [];
  private disposed = false;
  private refreshQueue: Promise<void> = Promise.resolve();
  private contextWorkspace?: boolean;
  private contextRepository?: boolean;
  private contextHasChanges?: boolean;
  private contextOperationKind?: GitOperationKind;
  private contextCanContinue?: boolean;
  private contextCanAbort?: boolean;
  private contextCanSkip?: boolean;

  public constructor(
    private readonly runner: GitRunner,
    private readonly workspacePaths: () => string[],
  ) {}

  public readonly onDidChange = this.changeEmitter.event;

  public get all(): readonly RepositorySnapshot[] {
    return [...this.snapshots.values()];
  }

  public get hasRepositories(): boolean {
    return this.repositories.length > 0;
  }

  public repository(rootPath?: string): GitRepository | undefined {
    if (rootPath) return this.repositories.find((repo) => repo.info.rootPath === rootPath);
    return this.repositories[0];
  }

  public async discoverAndRefresh(scanNested = true): Promise<void> {
    await this.enqueueRefresh(async () => {
      const previous = this.snapshotKeys();
      const discovered = await discoverRepositories(this.workspacePaths(), this.runner, undefined, scanNested);
      const existingByRoot = new Map(this.repositories.map((repository) => [repository.info.rootPath, repository]));
      const repositories = discovered.map((repository) => {
        const existing = existingByRoot.get(repository.info.rootPath);
        // GitRepository owns the per-repository mutation mutex. Reusing it when
        // discovery found the same underlying repository keeps commands issued
        // across a rescan on one lock instead of creating two independent queues.
        return existing && sameRepositoryIdentity(existing, repository) ? existing : repository;
      });
      const snapshots = await Promise.all(repositories.map((repository) => this.readSnapshot(repository)));
      if (this.disposed) return;
      // Swap the list and its snapshots together: while the reads were in flight, commands
      // could otherwise see a repository without a snapshot or a snapshot without its
      // repository, turning into silent no-ops or raw "Repository not found" errors.
      this.repositories = repositories;
      this.snapshots.clear();
      for (const snapshot of snapshots) this.snapshots.set(snapshot.repository.info.rootPath, snapshot);
      await this.updateContextKeys();
      if (this.snapshotsChanged(previous)) this.changeEmitter.fire();
    });
  }

  public async refresh(rootPath?: string): Promise<void> {
    await this.enqueueRefresh(async () => {
      const previous = this.snapshotKeys();
      const targets = rootPath ? this.repositories.filter((repo) => repo.info.rootPath === rootPath) : this.repositories;
      await Promise.all(
        targets.map(async (repository) => {
          this.snapshots.set(repository.info.rootPath, await this.readSnapshot(repository));
        }),
      );
      await this.updateContextKeys();
      if (this.snapshotsChanged(previous)) this.changeEmitter.fire();
    });
  }

  public snapshot(rootPath: string): RepositorySnapshot | undefined {
    return this.snapshots.get(rootPath);
  }

  public async initializeRepository(rootPath: string): Promise<boolean> {
    // Ask Git directly so symlinked/canonical path aliases cannot bypass this guard.
    const containing = await discoverRepository(rootPath, this.runner);
    if (containing) return false;
    await this.runner.run(["init"], { cwd: rootPath });
    await this.discoverAndRefresh();
    return true;
  }

  public async stage(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).stage(paths));
  }

  public async unstage(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).unstage(paths));
  }

  public async diffHunks(rootPath: string, pathSpec: string, staged = false): Promise<GitDiffHunk[]> {
    return this.requireRepository(rootPath).diffHunks(pathSpec, staged);
  }

  public async blame(
    rootPath: string,
    pathSpec: string,
    revision?: string,
    contents?: string | Buffer,
    options?: GitBlameOptions,
  ): Promise<GitBlameEntry[]> {
    return this.requireRepository(rootPath).blame(pathSpec, revision, contents, options);
  }

  public async commitFiles(rootPath: string, hash: string, signal?: AbortSignal): Promise<GitCommitFile[]> {
    return this.requireRepository(rootPath).commitFiles(hash, signal);
  }

  public async commitMessage(rootPath: string, hash: string, signal?: AbortSignal): Promise<string> {
    return this.requireRepository(rootPath).commitMessage(hash, signal);
  }

  public async logPage(rootPath: string, limit: number, skip: number, filePath?: string, options?: Partial<import("./git/types").GitLogOptions>, signal?: AbortSignal): Promise<GitCommit[]> {
    return this.requireRepository(rootPath).logPage(limit, skip, filePath, options, signal);
  }

  public async logRefPage(rootPath: string, ref: string, limit: number, skip: number, filePath?: string, options?: Partial<import("./git/types").GitLogOptions>, signal?: AbortSignal): Promise<GitCommit[]> {
    return this.requireRepository(rootPath).logRefPage(ref, limit, skip, filePath, options, signal);
  }

  public async stageHunk(rootPath: string, pathSpec: string, hunk: GitDiffHunk): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).stageHunk(pathSpec, hunk));
  }

  public async unstageHunk(rootPath: string, pathSpec: string, hunk: GitDiffHunk): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).unstageHunk(pathSpec, hunk));
  }

  public async discard(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).discard(paths));
  }

  public async cleanUntracked(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).cleanUntracked(paths));
  }

  public async applyPatch(rootPath: string, patchFile: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).applyPatchFile(patchFile));
  }

  public async sparseCheckoutSet(rootPath: string, paths: readonly string[], cone = true): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).sparseCheckoutSet(paths, cone));
  }

  public async sparseCheckoutDisable(rootPath: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).sparseCheckoutDisable());
  }

  public async lfsPull(rootPath: string, signal?: AbortSignal): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).lfsPull(signal));
  }

  public async resolveConflict(rootPath: string, pathSpec: string, side: "ours" | "theirs"): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).resolveConflict(pathSpec, side));
  }

  public async resolveSimpleConflicts(
    rootPath: string,
    pathSpec: string,
    labels: Diff3Labels,
  ): Promise<{ resolved: number; remaining: number }> {
    return this.mutate(rootPath, () => this.requireRepository(rootPath).resolveSimpleConflicts(pathSpec, labels));
  }

  public async conflictVersions(rootPath: string, pathSpec: string): Promise<GitConflictVersions> {
    return this.requireRepository(rootPath).conflictVersions(pathSpec);
  }

  /** Replays the merge in `diff3` so each conflict carries the base it started from. Read-only: it works on copies of the stages. */
  public async conflictAnalysis(rootPath: string, pathSpec: string): Promise<MergeBlock[]> {
    return this.requireRepository(rootPath).conflictAnalysis(pathSpec);
  }

  public async applyConflictResult(rootPath: string, pathSpec: string, content: string, deleted = false): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).applyConflictResult(pathSpec, content, deleted));
  }

  public async markResolved(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).markResolved(paths));
  }

  public async fetch(rootPath?: string, signal?: AbortSignal): Promise<void> {
    await this.mutate(rootPath, async () => {
      const targets = rootPath ? [this.requireRepository(rootPath)] : this.repositories;
      const failures: string[] = [];
      for (const repository of targets) {
        try {
          await repository.fetch(signal);
        } catch (error) {
          // A cancellation should stop the loop; one unreachable remote should not.
          if (isGitAbort(error) || targets.length === 1) throw error;
          failures.push(`${path.basename(repository.info.rootPath)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length) {
        throw new Error(vscode.l10n.t("Fetch failed for {0} of {1} repositories. {2}", failures.length, targets.length, failures.join("; ")));
      }
    });
  }

  public async pull(rootPath: string, strategy: GitPullStrategy, signal?: AbortSignal, lease?: RepositoryMutationLease): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).pull(strategy, signal), lease);
  }

  public async push(rootPath: string, forceWithLease = false, signal?: AbortSignal): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).push(forceWithLease, signal));
  }

  public async merge(rootPath: string, ref: string, options?: GitMergeOptions): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).merge(ref, options));
  }

  public async rebase(rootPath: string, ref: string, lease?: RepositoryMutationLease, options?: GitRebaseOptions): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).rebase(ref, options), lease);
  }

  public async commitFixup(rootPath: string, target: string, noVerify = false): Promise<string> {
    return this.mutate(rootPath, () => this.requireRepository(rootPath).commitFixup(target, noVerify));
  }

  public async amendStaged(rootPath: string, expectedHead: string, noVerify = false): Promise<string> {
    return this.mutate(rootPath, () => this.requireRepository(rootPath).amendStaged(expectedHead, noVerify));
  }

  public async reflogSubjects(rootPath: string, limit?: number): Promise<string[]> {
    return this.requireRepository(rootPath).reflogSubjects(limit);
  }

  public async updateBranch(rootPath: string, name: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).updateBranch(name));
  }

  public async recentAuthors(rootPath: string, limit?: number): Promise<string[]> {
    return this.requireRepository(rootPath).recentAuthors(limit);
  }

  public async commentChar(rootPath: string): Promise<string> {
    return this.requireRepository(rootPath).commentChar();
  }

  public async commitTemplate(rootPath: string): Promise<string | undefined> {
    return this.requireRepository(rootPath).commitTemplate();
  }

  public async interactiveRebaseCandidates(rootPath: string, base: string): Promise<GitCommit[]> {
    return this.requireRepository(rootPath).interactiveRebaseCandidates(base);
  }

  public async interactiveRebase(
    rootPath: string,
    base: string,
    steps: readonly RebaseStep[],
    expectation?: InteractiveRebaseExpectation,
    lease?: RepositoryMutationLease,
  ): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).interactiveRebase(base, steps, expectation), lease);
  }

  public async cherryPick(rootPath: string, hash: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).cherryPick(hash));
  }

  public async cherryPickMany(rootPath: string, hashes: readonly string[], signal?: AbortSignal, onApplied?: (count: number) => void): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).cherryPickMany(hashes, signal, onApplied));
  }

  public async revert(rootPath: string, hash: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).revert(hash));
  }

  public async reset(rootPath: string, ref: string, mode: GitResetMode): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).reset(ref, mode));
  }

  public async undoCommit(rootPath: string, expectedHead: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).undoCommit(expectedHead));
  }

  public async rewordHead(rootPath: string, expectedHead: string, message: string): Promise<string> {
    return this.mutate(rootPath, () => this.requireRepository(rootPath).rewordHead(expectedHead, message));
  }

  public async isPushed(rootPath: string, revision: string): Promise<boolean> {
    return this.requireRepository(rootPath).isPushed(revision);
  }

  public async acceptConflictSide(rootPath: string, pathSpec: string, side: "ours" | "theirs"): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).acceptConflictSide(pathSpec, side));
  }

  public async addIgnoreRule(rootPath: string, target: GitIgnoreTarget, line: string): Promise<string> {
    return this.mutate(rootPath, () => this.requireRepository(rootPath).addIgnoreRule(target, line));
  }

  public async checkoutRevision(rootPath: string, ref: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).checkoutRevision(ref));
  }

  public async restoreFileFromRevision(rootPath: string, ref: string, pathSpec: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).restoreFileFromRevision(ref, pathSpec));
  }

  public async continueOperation(rootPath: string, kind: Exclude<GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).continueOperation(kind));
  }

  public async abortOperation(rootPath: string, kind: Exclude<GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).abortOperation(kind));
  }

  public async skipOperation(rootPath: string, kind: "rebase" | "cherry-pick"): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).skipOperation(kind));
  }

  public async bisectStart(rootPath: string, bad: string, good: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).bisectStart(bad, good));
  }

  public async bisectGood(rootPath: string, ref = "HEAD"): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).bisectGood(ref));
  }

  public async bisectBad(rootPath: string, ref = "HEAD"): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).bisectBad(ref));
  }

  public async bisectSkip(rootPath: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).bisectSkip());
  }

  public async bisectReset(rootPath: string, ref?: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).bisectReset(ref));
  }

  public async commit(rootPath: string, message: string, options?: GitCommitOptions): Promise<string> {
    return this.mutate(rootPath, () => this.requireRepository(rootPath).commit(message, options));
  }

  public async commitPaths(
    rootPath: string,
    paths: readonly string[],
    message: string,
    options?: GitCommitOptions,
    hunkSelections?: ReadonlyMap<string, HunkSelection>,
  ): Promise<string> {
    return this.mutate(rootPath, () => this.requireRepository(rootPath).commitPaths(paths, message, options, hunkSelections));
  }

  /** The whole HEAD-to-working-tree diff of one path, which is the unit Changelist ownership is expressed in. */
  public async isTrackedAtHead(rootPath: string, pathSpec: string): Promise<boolean> {
    return this.requireRepository(rootPath).isTrackedAtHead(pathSpec);
  }

  public async diffAgainstHead(rootPath: string, pathSpec: string): Promise<{ output: string; hunks: GitDiffHunk[] }> {
    return this.requireRepository(rootPath).diffAgainstHead(pathSpec);
  }

  public async createBranch(rootPath: string, name: string, startPoint?: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).createBranch(name, startPoint));
  }

  public async renameBranch(rootPath: string, oldName: string, newName: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).renameBranch(oldName, newName));
  }

  public async deleteBranch(rootPath: string, name: string, force = false): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).deleteBranch(name, force));
  }

  public async createTag(rootPath: string, name: string, ref = "HEAD"): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).createTag(name, ref));
  }

  public async deleteTag(rootPath: string, name: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).deleteTag(name));
  }

  public async remotes(rootPath: string): Promise<GitRemote[]> {
    return this.requireRepository(rootPath).remotes();
  }

  public async addRemote(rootPath: string, name: string, url: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).addRemote(name, url));
  }

  public async removeRemote(rootPath: string, name: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).removeRemote(name));
  }

  public async setRemoteUrl(rootPath: string, name: string, url: string, push = false): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).setRemoteUrl(name, url, push));
  }

  public async fetchRemote(rootPath: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).fetchRemote(name, true, signal));
  }

  public async pushRemote(rootPath: string, name: string, refspec?: string, forceWithLease = false, signal?: AbortSignal, setUpstream = false): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).pushRemote(name, refspec, forceWithLease, signal, setUpstream));
  }

  public async worktrees(rootPath: string): Promise<GitWorktree[]> {
    return this.requireRepository(rootPath).worktrees();
  }

  public async addWorktree(rootPath: string, worktreePath: string, ref?: string, newBranch?: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).addWorktree(worktreePath, ref, newBranch));
  }

  public async removeWorktree(rootPath: string, worktreePath: string, force = false): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).removeWorktree(worktreePath, force));
  }

  public async pruneWorktrees(rootPath: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).pruneWorktrees());
  }

  public async submodules(rootPath: string): Promise<GitSubmodule[]> {
    return this.requireRepository(rootPath).submodules();
  }

  public async updateSubmodules(rootPath: string, paths: readonly string[] = []): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).updateSubmodules(true, true, paths));
  }

  public async clone(source: string, destination: string, bare = false, cwd?: string, signal?: AbortSignal): Promise<void> {
    const cloneRoot = cwd ?? this.workspacePaths()[0] ?? ".";
    try {
      await this.runner.run(["clone", ...(bare ? ["--bare"] : []), "--", source, destination], { cwd: cloneRoot, signal });
    } finally {
      await this.discoverAndRefresh();
    }
  }

  public async stash(rootPath: string, message?: string, includeUntracked = false, keepIndex = false, lease?: RepositoryMutationLease): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).stash(message, includeUntracked, keepIndex), lease);
  }

  public async stashes(rootPath: string): Promise<GitStashEntry[]> {
    return this.requireRepository(rootPath).stashes();
  }

  public async applyStash(rootPath: string, ref: string, pop = false, oid?: string, reinstateIndex = false, lease?: RepositoryMutationLease): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).applyStash(ref, pop, oid, reinstateIndex), lease);
  }

  public async dropStash(rootPath: string, ref: string, oid?: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).dropStash(ref, oid));
  }

  public async checkout(rootPath: string, branch: string, kind?: GitBranch["kind"], fullRef?: string, lease?: RepositoryMutationLease): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).checkout(branch, kind, fullRef), lease);
  }

  /** Runs several mutations without allowing another extension operation to interleave. */
  public async withExclusive<T>(rootPath: string, operation: (lease: RepositoryMutationLease) => Promise<T>): Promise<T> {
    return this.enqueueMutation(rootPath, async () => {
      const lease: RepositoryMutationLease = { rootPath, token: Symbol("jb-git-mutation") };
      this.activeLeases.set(rootPath, lease);
      try {
        return await operation(lease);
      } finally {
        if (this.activeLeases.get(rootPath) === lease) this.activeLeases.delete(rootPath);
        await this.refresh(rootPath).catch(() => undefined);
      }
    });
  }

  /**
   * Runs a mutation and refreshes afterwards even when it fails: an
   * interrupted Git command may still have moved repository state.
   */
  private async mutate<T>(rootPath: string | undefined, operation: () => Promise<T>, lease?: RepositoryMutationLease): Promise<T> {
    if (rootPath && lease !== undefined && this.activeLeases.get(rootPath) === lease) {
      try {
        return await operation();
      } finally {
        // Keep snapshots truthful for the next step in the compound workflow
        // while the lease still prevents another mutation from interleaving.
        await this.refresh(rootPath).catch(() => undefined);
      }
    }
    const key = rootPath ?? "<all>";
    return this.enqueueMutation(key, async () => {
      try {
        return await operation();
      } finally {
        // Never let the follow-up refresh replace the operation's own outcome.
        await this.refresh(rootPath).catch(() => undefined);
      }
    });
  }

  private async enqueueMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.mutationQueues.set(key, gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationQueues.get(key) === gate) this.mutationQueues.delete(key);
    }
  }

  private async readSnapshot(repository: GitRepository): Promise<RepositorySnapshot> {
    try {
      if (repository.info.isBare) {
        return {
          repository,
          status: null,
          branches: await repository.branches(),
          operation: { kind: "none", canContinue: false, canAbort: false },
          error: "Bare repository: working-tree operations are unavailable.",
        };
      }
      const [status, branches, operation] = await Promise.all([repository.status(), repository.branches(), repository.operationState()]);
      return { repository, status, branches, operation };
    } catch (error) {
      return {
        repository,
        status: null,
        branches: [],
        operation: { kind: "none", canContinue: false, canAbort: false },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private enqueueRefresh(operation: () => Promise<void>): Promise<void> {
    const guarded = async (): Promise<void> => {
      if (this.disposed) return;
      await operation();
    };
    const next = this.refreshQueue.then(guarded, guarded);
    this.refreshQueue = next.catch(() => undefined);
    return next;
  }

  private snapshotKeys(): Map<string, string> {
    return new Map([...this.snapshots].map(([root, snapshot]) => [root, snapshotKey(snapshot)]));
  }

  private snapshotsChanged(previous: ReadonlyMap<string, string>): boolean {
    if (previous.size !== this.snapshots.size) return true;
    for (const [root, snapshot] of this.snapshots) {
      if (previous.get(root) !== snapshotKey(snapshot)) return true;
    }
    return false;
  }

  private requireRepository(rootPath: string): GitRepository {
    const repository = this.repository(rootPath);
    if (!repository) throw new Error(vscode.l10n.t("Repository not found: {0}", rootPath));
    return repository;
  }

  private async updateContextKeys(): Promise<void> {
    const hasWorkspace = this.workspacePaths().length > 0;
    const hasRepository = this.hasRepositories;
    const hasChanges = this.all.some((snapshot) => Boolean(snapshot.status?.changes.length));
    const operation = this.all.find((snapshot) => snapshot.operation.kind !== "none")?.operation
      ?? { kind: "none" as const, canContinue: false, canAbort: false };
    const canSkip = operation.kind === "rebase" || operation.kind === "cherry-pick";
    const updates: Thenable<unknown>[] = [];
    if (this.contextWorkspace !== hasWorkspace) {
      this.contextWorkspace = hasWorkspace;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.hasWorkspace", hasWorkspace));
    }
    if (this.contextRepository !== hasRepository) {
      this.contextRepository = hasRepository;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.hasRepository", hasRepository));
    }
    if (this.contextHasChanges !== hasChanges) {
      this.contextHasChanges = hasChanges;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.hasChanges", hasChanges));
    }
    if (this.contextOperationKind !== operation.kind) {
      this.contextOperationKind = operation.kind;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.operationKind", operation.kind));
    }
    if (this.contextCanContinue !== operation.canContinue) {
      this.contextCanContinue = operation.canContinue;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.canContinueOperation", operation.canContinue));
    }
    if (this.contextCanAbort !== operation.canAbort) {
      this.contextCanAbort = operation.canAbort;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.canAbortOperation", operation.canAbort));
    }
    if (this.contextCanSkip !== canSkip) {
      this.contextCanSkip = canSkip;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.canSkipOperation", canSkip));
    }
    await Promise.all(updates);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.changeEmitter.dispose();
  }
}

/** A stable UI-facing snapshot identity. Status timestamps are deliberately ignored. */
export function snapshotKey(snapshot: RepositorySnapshot): string {
  return JSON.stringify({
    repository: snapshot.repository.info,
    status: snapshot.status ? { branch: snapshot.status.branch, changes: snapshot.status.changes } : null,
    branches: snapshot.branches,
    operation: snapshot.operation,
    error: snapshot.error,
  });
}

function sameRepositoryIdentity(left: GitRepository, right: GitRepository): boolean {
  return left.info.rootPath === right.info.rootPath
    && left.info.gitDir === right.info.gitDir
    && left.info.commonGitDir === right.info.commonGitDir
    && left.info.isBare === right.info.isBare;
}
