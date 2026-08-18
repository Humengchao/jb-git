import * as vscode from "vscode";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { GitBranch } from "../git/types";

export class RepositoryNode extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    const status = snapshot.status;
    const branch = status?.branch.head ?? "detached HEAD";
    const changeCount = status?.changes.length ?? 0;
    super(snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${branch}${changeCount ? ` · ${changeCount} change${changeCount === 1 ? "" : "s"}` : ""}`;
    this.tooltip = snapshot.error ?? snapshot.repository.info.rootPath;
    this.contextValue = "jbGit.repository";
    this.iconPath = new vscode.ThemeIcon("repo");
  }
}

export class BranchNode extends vscode.TreeItem {
  public constructor(public readonly repositoryRoot: string, public readonly branch: GitBranch) {
    super(branch.name, vscode.TreeItemCollapsibleState.None);
    this.description = branch.tracking ?? branch.kind;
    this.contextValue = "jbGit.branch";
    this.iconPath = new vscode.ThemeIcon(branch.kind === "tag" ? "tag" : "git-branch");
    this.command = {
      command: "jbGit.checkoutBranch",
      title: "Checkout Branch",
      arguments: [this],
    };
  }
}

export class RepositoryTreeProvider implements vscode.TreeDataProvider<RepositoryNode | BranchNode> {
  private readonly changedEmitter = new vscode.EventEmitter<RepositoryNode | BranchNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager) {
    manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: RepositoryNode | BranchNode): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: RepositoryNode | BranchNode): vscode.ProviderResult<(RepositoryNode | BranchNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new RepositoryNode(snapshot));
    if (element instanceof RepositoryNode) {
      return element.snapshot.branches
        .filter((branch) => branch.kind === "local" || branch.kind === "tag")
        .slice(0, 100)
        .map((branch) => new BranchNode(element.snapshot.repository.info.rootPath, branch));
    }
    return [];
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }
}

