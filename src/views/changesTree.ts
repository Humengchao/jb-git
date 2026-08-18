import * as path from "node:path";
import * as vscode from "vscode";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { GitChange } from "../git/types";

type ChangeGroupKind = "staged" | "unstaged" | "untracked" | "conflicted";

export class ChangeGroupNode extends vscode.TreeItem {
  public constructor(
    public readonly repositoryRoot: string,
    public readonly group: ChangeGroupKind,
    public readonly changes: GitChange[],
  ) {
    const title = group === "staged" ? "Staged Changes" : group === "unstaged" ? "Unstaged Changes" : group === "untracked" ? "Untracked Files" : "Conflicts";
    super(`${title} (${changes.length})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = `jbGit.changeGroup.${group}`;
    this.iconPath = new vscode.ThemeIcon(group === "conflicted" ? "warning" : "diff-modified");
  }
}

export class ChangeNode extends vscode.TreeItem {
  public constructor(public readonly repositoryRoot: string, public readonly change: GitChange) {
    super(change.path, vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(path.join(repositoryRoot, change.path));
    this.description = change.originalPath ? `← ${change.originalPath}` : change.kind;
    this.tooltip = `${change.indexStatus}${change.workTreeStatus} · ${change.path}`;
    this.contextValue = change.conflicted
      ? "jbGit.change.conflicted"
      : change.staged
        ? "jbGit.change.staged"
        : change.kind === "untracked"
          ? "jbGit.change.untracked"
          : "jbGit.change.unstaged";
    this.iconPath = new vscode.ThemeIcon(
      change.conflicted ? "warning" : change.kind === "deleted" ? "trash" : change.kind === "added" ? "diff-added" : "diff-modified",
    );
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [this.resourceUri],
    };
  }
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeGroupNode | ChangeNode | RepositoryChangeRoot | EmptyChangesNode> {
  private readonly changedEmitter = new vscode.EventEmitter<ChangeGroupNode | ChangeNode | RepositoryChangeRoot | EmptyChangesNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager) {
    manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: ChangeGroupNode | ChangeNode | RepositoryChangeRoot | EmptyChangesNode): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ChangeGroupNode | ChangeNode | RepositoryChangeRoot | EmptyChangesNode): vscode.ProviderResult<(ChangeGroupNode | ChangeNode | RepositoryChangeRoot | EmptyChangesNode)[]> {
    if (!element) {
      return this.manager.all.map((snapshot) => new RepositoryChangeRoot(snapshot));
    }
    if (element instanceof RepositoryChangeRoot) {
      const snapshot = element.snapshot;
      if (!snapshot.status) return [new EmptyChangesNode(snapshot.error ?? "Unable to read repository status")];
      const changes = snapshot.status.changes;
      if (changes.length === 0) return [new EmptyChangesNode("No local changes")];
      const groups: ChangeGroupNode[] = [];
      const staged = changes.filter((change) => change.staged && !change.conflicted);
      const unstaged = changes.filter((change) => change.unstaged && !change.conflicted);
      const untracked = changes.filter((change) => change.kind === "untracked");
      const conflicted = changes.filter((change) => change.conflicted);
      if (staged.length) groups.push(new ChangeGroupNode(snapshot.repository.info.rootPath, "staged", staged));
      if (unstaged.length) groups.push(new ChangeGroupNode(snapshot.repository.info.rootPath, "unstaged", unstaged));
      if (untracked.length) groups.push(new ChangeGroupNode(snapshot.repository.info.rootPath, "untracked", untracked));
      if (conflicted.length) groups.push(new ChangeGroupNode(snapshot.repository.info.rootPath, "conflicted", conflicted));
      return groups;
    }
    if (element instanceof ChangeGroupNode) {
      return element.changes.map((change) => new ChangeNode(element.repositoryRoot, change));
    }
    return [];
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }
}

export class RepositoryChangeRoot extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    const branch = snapshot.status?.branch.head ?? "detached HEAD";
    super(path.basename(snapshot.repository.info.rootPath) || snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = branch;
    this.tooltip = snapshot.repository.info.rootPath;
    this.contextValue = "jbGit.changesRoot";
    this.iconPath = new vscode.ThemeIcon("repo");
  }
}

export class EmptyChangesNode extends vscode.TreeItem {
  public constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "jbGit.empty";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}
