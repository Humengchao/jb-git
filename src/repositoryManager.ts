import * as vscode from "vscode";
import { discoverRepositories, GitRepository } from "./git/repository";
import { GitRunner } from "./git/runner";
import { GitBranch, GitCommitOptions, GitOperationState, GitPullStrategy, GitStashEntry, GitStatusSnapshot } from "./git/types";

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
    this.repositories = await discoverRepositories(this.workspacePaths(), this.runner);
    const next = new Map<string, RepositorySnapshot>();
    await Promise.all(
      this.repositories.map(async (repository) => {
        const snapshot = await this.readSnapshot(repository);
        next.set(repository.info.rootPath, snapshot);
      }),
    );
    this.snapshots.clear();
    for (const [root, snapshot] of next) this.snapshots.set(root, snapshot);
    await this.updateContextKeys();
    this.changeEmitter.fire();
  }

  public async refresh(rootPath?: string): Promise<void> {
    const targets = rootPath ? this.repositories.filter((repo) => repo.info.rootPath === rootPath) : this.repositories;
    await Promise.all(
      targets.map(async (repository) => {
        this.snapshots.set(repository.info.rootPath, await this.readSnapshot(repository));
      }),
    );
    await this.updateContextKeys();
    this.changeEmitter.fire();
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

  public async discard(rootPath: string, paths: readonly string[]): Promise<void> {
    await this.requireRepository(rootPath).discard(paths);
    await this.refresh(rootPath);
  }

  public async fetch(rootPath?: string): Promise<void> {
    const targets = rootPath ? [this.requireRepository(rootPath)] : this.repositories;
    for (const repository of targets) await repository.fetch();
    await this.refresh(rootPath);
  }

  public async pull(rootPath: string, strategy: GitPullStrategy): Promise<void> {
    await this.requireRepository(rootPath).pull(strategy);
    await this.refresh(rootPath);
  }

  public async push(rootPath: string, forceWithLease = false): Promise<void> {
    await this.requireRepository(rootPath).push(forceWithLease);
    await this.refresh(rootPath);
  }

  public async commit(rootPath: string, message: string, options?: GitCommitOptions): Promise<string> {
    const revision = await this.requireRepository(rootPath).commit(message, options);
    await this.refresh(rootPath);
    return revision;
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

  public async checkout(rootPath: string, branch: string): Promise<void> {
    await this.requireRepository(rootPath).checkout(branch);
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
