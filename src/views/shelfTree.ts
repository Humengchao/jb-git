import * as vscode from "vscode";
import { ShelfEntry, ShelfStore } from "../shelves/store";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { ErrorNode } from "./errorNode";

export class ShelfRootNode extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    super(snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = snapshot.status?.branch.head ?? "detached HEAD";
    this.contextValue = "jbGit.shelfRoot";
    this.iconPath = new vscode.ThemeIcon("archive");
  }
}

export class ShelfNode extends vscode.TreeItem {
  public constructor(public readonly repositoryRoot: string, public readonly entry: ShelfEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.description = new Date(entry.createdAt).toLocaleString();
    this.tooltip = `${entry.paths.length} tracked path(s)\n${entry.patchFile}`;
    this.contextValue = "jbGit.shelf";
    this.iconPath = new vscode.ThemeIcon("archive");
    this.command = {
      command: "jbGit.applyShelf",
      title: "Apply Shelf",
      arguments: [this],
    };
  }
}

export class ShelfTreeProvider implements vscode.TreeDataProvider<ShelfRootNode | ShelfNode | ErrorNode> {
  private readonly changedEmitter = new vscode.EventEmitter<ShelfRootNode | ShelfNode | ErrorNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager, private readonly shelves: ShelfStore) {
    manager.onDidChange(() => this.changedEmitter.fire());
    shelves.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: ShelfRootNode | ShelfNode | ErrorNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ShelfRootNode | ShelfNode | ErrorNode): Promise<(ShelfRootNode | ShelfNode | ErrorNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new ShelfRootNode(snapshot));
    if (element instanceof ShelfRootNode) {
      try {
        const entries = await this.shelves.list(element.snapshot.repository.info.rootPath);
        return entries.map((entry) => new ShelfNode(element.snapshot.repository.info.rootPath, entry));
      } catch (error) {
        return [new ErrorNode(error)];
      }
    }
    return [];
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }
}
