import * as vscode from "vscode";
import { GitStashEntry } from "../git/types";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { ErrorNode } from "./errorNode";

export class StashRootNode extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    super(snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = snapshot.status?.branch.head ?? "detached HEAD";
    this.contextValue = "jbGit.stashRoot";
    this.iconPath = new vscode.ThemeIcon("archive");
  }
}

export class StashNode extends vscode.TreeItem {
  public constructor(public readonly repositoryRoot: string, public readonly entry: GitStashEntry) {
    super(entry.ref, vscode.TreeItemCollapsibleState.None);
    this.description = entry.message;
    this.tooltip = `${entry.ref}\n${entry.message}`;
    this.contextValue = "jbGit.stash";
    this.iconPath = new vscode.ThemeIcon("archive");
    this.command = {
      command: "jbGit.applyStash",
      title: "Apply Stash",
      arguments: [this],
    };
  }
}

export class StashTreeProvider implements vscode.TreeDataProvider<StashRootNode | StashNode | ErrorNode> {
  private readonly changedEmitter = new vscode.EventEmitter<StashRootNode | StashNode | ErrorNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager) {
    manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: StashRootNode | StashNode | ErrorNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: StashRootNode | StashNode | ErrorNode): Promise<(StashRootNode | StashNode | ErrorNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new StashRootNode(snapshot));
    if (element instanceof StashRootNode) {
      try {
        const entries = await this.manager.stashes(element.snapshot.repository.info.rootPath);
        return entries.map((entry) => new StashNode(element.snapshot.repository.info.rootPath, entry));
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
