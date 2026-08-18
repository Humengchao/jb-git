import * as vscode from "vscode";
import { Changelist, ChangelistStore } from "../changelists/store";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { ChangeNode } from "./changesTree";

export class ChangelistRootNode extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    super(snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = snapshot.status?.branch.head ?? "detached HEAD";
    this.contextValue = "jbGit.changelistRoot";
    this.iconPath = new vscode.ThemeIcon("repo");
  }
}

export class ChangelistNode extends vscode.TreeItem {
  public constructor(
    public readonly repositoryRoot: string,
    public readonly changelist: Changelist,
    public readonly isActive: boolean,
  ) {
    super(changelist.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = isActive ? "active" : `${changelist.files.length} assigned`;
    this.contextValue = isActive ? "jbGit.changelist.active" : "jbGit.changelist";
    this.iconPath = new vscode.ThemeIcon(isActive ? "check" : "list-unordered");
  }
}

export class ChangelistChangeNode extends ChangeNode {
  public constructor(
    repositoryRoot: string,
    change: import("../git/types").GitChange,
    public readonly changelistId: string,
  ) {
    super(repositoryRoot, change);
    this.contextValue = "jbGit.changelist.change";
  }
}

export class ChangelistTreeProvider implements vscode.TreeDataProvider<ChangelistRootNode | ChangelistNode | ChangelistChangeNode> {
  private readonly changedEmitter = new vscode.EventEmitter<ChangelistRootNode | ChangelistNode | ChangelistChangeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly store: ChangelistStore,
  ) {
    manager.onDidChange(() => this.changedEmitter.fire());
    store.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: ChangelistRootNode | ChangelistNode | ChangelistChangeNode): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ChangelistRootNode | ChangelistNode | ChangelistChangeNode): vscode.ProviderResult<(ChangelistRootNode | ChangelistNode | ChangelistChangeNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new ChangelistRootNode(snapshot));
    if (element instanceof ChangelistRootNode) {
      return this.store.lists(element.snapshot.repository.info.rootPath).map((list) => new ChangelistNode(
        element.snapshot.repository.info.rootPath,
        list,
        list.id === this.store.activeId(element.snapshot.repository.info.rootPath),
      ));
    }
    if (element instanceof ChangelistNode) {
      const snapshot = this.manager.snapshot(element.repositoryRoot);
      return (snapshot?.status?.changes ?? [])
        .filter((change) => this.store.listForFile(element.repositoryRoot, change.path).id === element.changelist.id)
        .map((change) => new ChangelistChangeNode(element.repositoryRoot, change, element.changelist.id));
    }
    return [];
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }
}
