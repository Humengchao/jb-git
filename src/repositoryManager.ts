import * as vscode from "vscode";
import { discoverRepositories, GitRepository } from "./git/repository";
import { GitRunner } from "./git/runner";
import { GitBlameEntry, GitBranch, GitCommitOptions, GitDiffHunk, GitOperationKind, GitOperationState, GitPullStrategy, GitRemote, GitStashEntry, GitStatusSnapshot, GitSubmodule, GitWorktree } from "./git/types";

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

  public async discoverAndRefresh(): Promise<void> {
    await this.enqueueRefresh(async () => {
      this.repositories = await discoverRepositories(this.workspacePaths(), this.runner);
      const next = new Map<string, RepositorySnapshot>();
      const snapshots = await Promise.all(this.repositories.map((repository) => this.readSnapshot(repository)));
      this.snapshots.clear();
      for (const snapshot of snapshots) next.set(snapshot.repository.info.rootPath, snapshot);
      for (const [root, snapshot] of next) this.snapshots.set(root, snapshot);
      await this.updateContextKeys();
      this.changeEmitter.fire();
    });
  }

  public async refresh(rootPath?: string): Promise<void> {
    await this.enqueueRefresh(async () => {
      const targets = rootPath ? this.repositories.filter((repo) => repo.info.rootPath === rootPath) : this.repositories;
      await Promise.all(
        targets.map(async (repository) => {
          this.snapshots.set(repository.info.rootPath, await this.readSnapshot(repository));
        }),
      );
      await this.updateContextKeys();
      this.changeEmitter.fire();
    });
  }

  public snapshot(rootPath: string): RepositorySnapshot | undefined {
    return this.snapshots.get(rootPath);
  }

  public async initializeRepository(rootPath: string): Promise<void> {
    const repository = this.repository(rootPath);
    if (repository) {
      await repository.init();
    } else {
      await this.runner.run(["init"], { cwd: rootPath });
    }
    await this.discoverAndRefresh();
  }

  public async stage(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.requireRepository(rootPath).stage(paths);
    await this.refresh(rootPath);
  }

  public async unstage(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.requireRepository(rootPath).unstage(paths);
    await this.refresh(rootPath);
  }

  public async diffHunks(rootPath: string, pathSpec: string, staged = false): Promise<GitDiffHunk[]> {
    return this.requireRepository(rootPath).diffHunks(pathSpec, staged);
  }

  public async blame(rootPath: string, pathSpec: string, revision?: string): Promise<GitBlameEntry[]> {
    return this.requireRepository(rootPath).blame(pathSpec, revision);
  }

  public async stageHunk(rootPath: string, pathSpec: string, hunk: GitDiffHunk): Promise<void> {
    await this.requireRepository(rootPath).stageHunk(pathSpec, hunk);
    await this.refresh(rootPath);
  }

  public async unstageHunk(rootPath: string, pathSpec: string, hunk: GitDiffHunk): Promise<void> {
    await this.requireRepository(rootPath).unstageHunk(pathSpec, hunk);
    await this.refresh(rootPath);
  }

  public async discard(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.requireRepository(rootPath).discard(paths);
    await this.refresh(rootPath);
  }

  public async cleanUntracked(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.requireRepository(rootPath).cleanUntracked(paths);
    await this.refresh(rootPath);
  }

  public async applyPatch(rootPath: string, patchFile: string): Promise<void> {
    await this.requireRepository(rootPath).applyPatchFile(patchFile);
    await this.refresh(rootPath);
  }

  public async sparseCheckoutSet(rootPath: string, paths: readonly string[], cone = true): Promise<void> {
    await this.requireRepository(rootPath).sparseCheckoutSet(paths, cone);
    await this.refresh(rootPath);
  }

  public async sparseCheckoutDisable(rootPath: string): Promise<void> {
    await this.requireRepository(rootPath).sparseCheckoutDisable();
    await this.refresh(rootPath);
  }

  public async lfsPull(rootPath: string): Promise<void> {
    await this.requireRepository(rootPath).lfsPull();
    await this.refresh(rootPath);
  }

  public async resolveConflict(rootPath: string, pathSpec: string, side: "ours" | "theirs"): Promise<void> {
    await this.requireRepository(rootPath).resolveConflict(pathSpec, side);
    await this.refresh(rootPath);
  }

  public async markResolved(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.requireRepository(rootPath).markResolved(paths);
    await this.refresh(rootPath);
  }

  public async fetch(rootPath?: string): Promise<void> {
    const targets = rootPath ? [this.requireRepository(rootPath)] : this.repositories;
    for (const repository of targets) await repository.fetch();
    await this.refresh(rootPath);
  }

  public async pull(rootPath: string, strategy: GitPullStrategy): Promise<void> {
    try {
      await this.requireRepository(rootPath).pull(strategy);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async push(rootPath: string, forceWithLease = false): Promise<void> {
    await this.requireRepository(rootPath).push(forceWithLease);
    await this.refresh(rootPath);
  }

  public async merge(rootPath: string, ref: string): Promise<void> {
    try {
      await this.requireRepository(rootPath).merge(ref);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async rebase(rootPath: string, ref: string): Promise<void> {
    try {
      await this.requireRepository(rootPath).rebase(ref);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async cherryPick(rootPath: string, hash: string): Promise<void> {
    try {
      await this.requireRepository(rootPath).cherryPick(hash);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async revert(rootPath: string, hash: string): Promise<void> {
    try {
      await this.requireRepository(rootPath).revert(hash);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async reset(rootPath: string, ref: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
    await this.requireRepository(rootPath).reset(ref, mode);
    await this.refresh(rootPath);
  }

  public async continueOperation(rootPath: string, kind: Exclude<GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    try {
      await this.requireRepository(rootPath).continueOperation(kind);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async abortOperation(rootPath: string, kind: Exclude<GitOperationKind, "none" | "bisect" | "sequencer">): Promise<void> {
    try {
      await this.requireRepository(rootPath).abortOperation(kind);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async skipOperation(rootPath: string, kind: "rebase" | "cherry-pick"): Promise<void> {
    try {
      await this.requireRepository(rootPath).skipOperation(kind);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async bisectStart(rootPath: string, bad: string, good: string): Promise<void> {
    try {
      await this.requireRepository(rootPath).bisectStart(bad, good);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async bisectGood(rootPath: string, ref = "HEAD"): Promise<void> {
    try {
      await this.requireRepository(rootPath).bisectGood(ref);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async bisectBad(rootPath: string, ref = "HEAD"): Promise<void> {
    try {
      await this.requireRepository(rootPath).bisectBad(ref);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async bisectSkip(rootPath: string): Promise<void> {
    try {
      await this.requireRepository(rootPath).bisectSkip();
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async bisectReset(rootPath: string, ref?: string): Promise<void> {
    try {
      await this.requireRepository(rootPath).bisectReset(ref);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async commit(rootPath: string, message: string, options?: GitCommitOptions): Promise<string> {
    const revision = await this.requireRepository(rootPath).commit(message, options);
    await this.refresh(rootPath);
    return revision;
  }

  public async commitPaths(rootPath: string, paths: readonly string[], message: string, options?: GitCommitOptions): Promise<string> {
    try {
      return await this.requireRepository(rootPath).commitPaths(paths, message, options);
    } finally {
      await this.refresh(rootPath);
    }
  }

  public async createBranch(rootPath: string, name: string, startPoint?: string): Promise<void> {
    await this.requireRepository(rootPath).createBranch(name, startPoint);
    await this.refresh(rootPath);
  }

  public async renameBranch(rootPath: string, oldName: string, newName: string): Promise<void> {
    await this.requireRepository(rootPath).renameBranch(oldName, newName);
    await this.refresh(rootPath);
  }

  public async deleteBranch(rootPath: string, name: string, force = false): Promise<void> {
    await this.requireRepository(rootPath).deleteBranch(name, force);
    await this.refresh(rootPath);
  }

  public async createTag(rootPath: string, name: string, ref = "HEAD"): Promise<void> {
    await this.requireRepository(rootPath).createTag(name, ref);
    await this.refresh(rootPath);
  }

  public async deleteTag(rootPath: string, name: string): Promise<void> {
    await this.requireRepository(rootPath).deleteTag(name);
    await this.refresh(rootPath);
  }

  public async remotes(rootPath: string): Promise<GitRemote[]> {
    return this.requireRepository(rootPath).remotes();
  }

  public async addRemote(rootPath: string, name: string, url: string): Promise<void> {
    await this.requireRepository(rootPath).addRemote(name, url);
    await this.refresh(rootPath);
  }

  public async removeRemote(rootPath: string, name: string): Promise<void> {
    await this.requireRepository(rootPath).removeRemote(name);
    await this.refresh(rootPath);
  }

  public async setRemoteUrl(rootPath: string, name: string, url: string, push = false): Promise<void> {
    await this.requireRepository(rootPath).setRemoteUrl(name, url, push);
    await this.refresh(rootPath);
  }

  public async fetchRemote(rootPath: string, name: string): Promise<void> {
    await this.requireRepository(rootPath).fetchRemote(name);
    await this.refresh(rootPath);
  }

  public async pushRemote(rootPath: string, name: string, branch?: string, forceWithLease = false): Promise<void> {
    await this.requireRepository(rootPath).pushRemote(name, branch, forceWithLease);
    await this.refresh(rootPath);
  }

  public async worktrees(rootPath: string): Promise<GitWorktree[]> {
    return this.requireRepository(rootPath).worktrees();
  }

  public async addWorktree(rootPath: string, worktreePath: string, ref?: string, newBranch?: string): Promise<void> {
    await this.requireRepository(rootPath).addWorktree(worktreePath, ref, newBranch);
    await this.refresh(rootPath);
  }

  public async removeWorktree(rootPath: string, worktreePath: string, force = false): Promise<void> {
    await this.requireRepository(rootPath).removeWorktree(worktreePath, force);
    await this.refresh(rootPath);
  }

  public async pruneWorktrees(rootPath: string): Promise<void> {
    await this.requireRepository(rootPath).pruneWorktrees();
    await this.refresh(rootPath);
  }

  public async submodules(rootPath: string): Promise<GitSubmodule[]> {
    return this.requireRepository(rootPath).submodules();
  }

  public async updateSubmodules(rootPath: string, paths: readonly string[] = []): Promise<void> {
    await this.requireRepository(rootPath).updateSubmodules(true, true, paths);
    await this.refresh(rootPath);
  }

  public async clone(source: string, destination: string, bare = false): Promise<void> {
    const cwd = this.workspacePaths()[0] ?? ".";
    await this.runner.run(["clone", ...(bare ? ["--bare"] : []), source, destination], { cwd });
    await this.discoverAndRefresh();
  }

  public async stash(rootPath: string, message?: string, includeUntracked = false, keepIndex = false): Promise<void> {
    await this.requireRepository(rootPath).stash(message, includeUntracked, keepIndex);
    await this.refresh(rootPath);
  }

  public async stashes(rootPath: string): Promise<GitStashEntry[]> {
    return this.requireRepository(rootPath).stashes();
  }

  public async applyStash(rootPath: string, ref: string, pop = false): Promise<void> {
    await this.requireRepository(rootPath).applyStash(ref, pop);
    await this.refresh(rootPath);
  }

  public async dropStash(rootPath: string, ref: string): Promise<void> {
    await this.requireRepository(rootPath).dropStash(ref);
    await this.refresh(rootPath);
  }

  public async checkout(rootPath: string, branch: string, kind?: GitBranch["kind"]): Promise<void> {
    await this.requireRepository(rootPath).checkout(branch, kind);
    await this.refresh(rootPath);
  }

  private async readSnapshot(repository: GitRepository): Promise<RepositorySnapshot> {
    try {
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

  private requireRepository(rootPath: string): GitRepository {
    const repository = this.repository(rootPath);
    if (!repository) throw new Error(`Repository not found: ${rootPath}`);
    return repository;
  }

  private async updateContextKeys(): Promise<void> {
    await vscode.commands.executeCommand("setContext", "jbGit.hasWorkspace", this.workspacePaths().length > 0);
    await vscode.commands.executeCommand("setContext", "jbGit.hasRepository", this.hasRepositories);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.changeEmitter.dispose();
  }
}
