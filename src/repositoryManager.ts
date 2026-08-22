import * as vscode from "vscode";
import { discoverRepositories, discoverRepository, GitRepository } from "./git/repository";
import { GitRunner } from "./git/runner";
import { GitBlameEntry, GitBranch, GitCommitFile, GitCommitOptions, GitConflictVersions, GitDiffHunk, GitOperationKind, GitOperationState, GitPullStrategy, GitRemote, GitStashEntry, GitStatusSnapshot, GitSubmodule, GitWorktree } from "./git/types";

export interface RepositorySnapshot {
  repository: GitRepository;
  status: GitStatusSnapshot | null;
  branches: GitBranch[];
  operation: GitOperationState;
  error?: string;
}

export class RepositoryManager implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private repositories: GitRepository[] = [];
  private disposed = false;
  private refreshQueue: Promise<void> = Promise.resolve();
  private contextWorkspace?: boolean;
  private contextRepository?: boolean;

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
      this.repositories = await discoverRepositories(this.workspacePaths(), this.runner, undefined, scanNested);
      const next = new Map<string, RepositorySnapshot>();
      const snapshots = await Promise.all(this.repositories.map((repository) => this.readSnapshot(repository)));
      this.snapshots.clear();
      for (const snapshot of snapshots) next.set(snapshot.repository.info.rootPath, snapshot);
      for (const [root, snapshot] of next) this.snapshots.set(root, snapshot);
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

  public async blame(rootPath: string, pathSpec: string, revision?: string): Promise<GitBlameEntry[]> {
    return this.requireRepository(rootPath).blame(pathSpec, revision);
  }

  public async commitFiles(rootPath: string, hash: string): Promise<GitCommitFile[]> {
    return this.requireRepository(rootPath).commitFiles(hash);
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

  public async conflictVersions(rootPath: string, pathSpec: string): Promise<GitConflictVersions> {
    return this.requireRepository(rootPath).conflictVersions(pathSpec);
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
      for (const repository of targets) await repository.fetch(signal);
    });
  }

  public async pull(rootPath: string, strategy: GitPullStrategy, signal?: AbortSignal): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).pull(strategy, signal));
  }

  public async push(rootPath: string, forceWithLease = false, signal?: AbortSignal): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).push(forceWithLease, signal));
  }

  public async merge(rootPath: string, ref: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).merge(ref));
  }

  public async rebase(rootPath: string, ref: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).rebase(ref));
  }

  public async cherryPick(rootPath: string, hash: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).cherryPick(hash));
  }

  public async revert(rootPath: string, hash: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).revert(hash));
  }

  public async reset(rootPath: string, ref: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).reset(ref, mode));
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

  public async commitPaths(rootPath: string, paths: readonly string[], message: string, options?: GitCommitOptions): Promise<string> {
    return this.mutate(rootPath, () => this.requireRepository(rootPath).commitPaths(paths, message, options));
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

  public async pushRemote(rootPath: string, name: string, branch?: string, forceWithLease = false, signal?: AbortSignal, setUpstream = false): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).pushRemote(name, branch, forceWithLease, signal, setUpstream));
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

  public async stash(rootPath: string, message?: string, includeUntracked = false, keepIndex = false): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).stash(message, includeUntracked, keepIndex));
  }

  public async stashes(rootPath: string): Promise<GitStashEntry[]> {
    return this.requireRepository(rootPath).stashes();
  }

  public async applyStash(rootPath: string, ref: string, pop = false): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).applyStash(ref, pop));
  }

  public async dropStash(rootPath: string, ref: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).dropStash(ref));
  }

  public async checkout(rootPath: string, branch: string, kind?: GitBranch["kind"], fullRef?: string): Promise<void> {
    await this.mutate(rootPath, () => this.requireRepository(rootPath).checkout(branch, kind, fullRef));
  }

  /**
   * Runs a mutation and refreshes afterwards even when it fails: an
   * interrupted Git command may still have moved repository state.
   */
  private async mutate<T>(rootPath: string | undefined, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      await this.refresh(rootPath);
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
    const next = this.refreshQueue.then(operation, operation);
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
    if (!repository) throw new Error(`Repository not found: ${rootPath}`);
    return repository;
  }

  private async updateContextKeys(): Promise<void> {
    const hasWorkspace = this.workspacePaths().length > 0;
    const hasRepository = this.hasRepositories;
    const updates: Thenable<unknown>[] = [];
    if (this.contextWorkspace !== hasWorkspace) {
      this.contextWorkspace = hasWorkspace;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.hasWorkspace", hasWorkspace));
    }
    if (this.contextRepository !== hasRepository) {
      this.contextRepository = hasRepository;
      updates.push(vscode.commands.executeCommand("setContext", "jbGit.hasRepository", hasRepository));
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
    root: snapshot.repository.info.rootPath,
    status: snapshot.status ? { branch: snapshot.status.branch, changes: snapshot.status.changes } : null,
    branches: snapshot.branches,
    operation: snapshot.operation,
    error: snapshot.error,
  });
}
