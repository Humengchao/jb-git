import * as vscode from "vscode";
import { GitWorktree } from "../git/types";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";

export class WorktreeRootNode extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    super(snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = snapshot.status?.branch.head ?? "detached HEAD";
    this.contextValue = "jbGit.worktreeRoot";
    this.iconPath = new vscode.ThemeIcon("repo");
  }
}

export class WorktreeNode extends vscode.TreeItem {
  public constructor(public readonly repositoryRoot: string, public readonly worktree: GitWorktree) {
    super(worktree.branch ?? (worktree.detached ? "detached HEAD" : worktree.path), vscode.TreeItemCollapsibleState.None);
    this.description = worktree.path;
    this.tooltip = `${worktree.head ?? "no HEAD"}${worktree.prunable ? " · prunable" : ""}`;
    this.contextValue = worktree.prunable ? "jbGit.worktree.prunable" : "jbGit.worktree";
    this.iconPath = new vscode.ThemeIcon(worktree.bare ? "archive" : "git-branch");
    this.command = {
      command: "vscode.openFolder",
      title: "Open Worktree",
      arguments: [vscode.Uri.file(worktree.path), { forceNewWindow: false }],
    };
  }
}

export class WorktreeTreeProvider implements vscode.TreeDataProvider<WorktreeRootNode | WorktreeNode> {
  private readonly changedEmitter = new vscode.EventEmitter<WorktreeRootNode | WorktreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager) {
    manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: WorktreeRootNode | WorktreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: WorktreeRootNode | WorktreeNode): Promise<(WorktreeRootNode | WorktreeNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new WorktreeRootNode(snapshot));
    if (element instanceof WorktreeRootNode) {
      try {
        return (await this.manager.worktrees(element.snapshot.repository.info.rootPath)).map((worktree) => new WorktreeNode(element.snapshot.repository.info.rootPath, worktree));
      } catch {
        return [];
      }
    }
    return [];
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }
}

