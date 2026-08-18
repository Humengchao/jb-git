import * as vscode from "vscode";
import { GitSubmodule } from "../git/types";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { ErrorNode } from "./errorNode";
import { redactGitText } from "../git/runner";

export class SubmoduleRootNode extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    super(snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = snapshot.status?.branch.head ?? "detached HEAD";
    this.contextValue = "jbGit.submoduleRoot";
    this.iconPath = new vscode.ThemeIcon("repo");
  }
}

export class SubmoduleNode extends vscode.TreeItem {
  public constructor(public readonly repositoryRoot: string, public readonly submodule: GitSubmodule) {
    const state = submodule.status === "-" ? "uninitialized" : submodule.status === "+" ? "out of date" : submodule.status === "U" ? "conflict" : "ready";
    super(submodule.path, vscode.TreeItemCollapsibleState.None);
    this.description = state;
    this.tooltip = `${submodule.oid || "no object"}${submodule.url ? `\n${redactGitText(submodule.url)}` : ""}`;
    this.contextValue = "jbGit.submodule";
    this.iconPath = new vscode.ThemeIcon(submodule.status === "U" ? "warning" : "repo");
    this.command = {
      command: "jbGit.updateSubmodule",
      title: "Update Submodule",
      arguments: [this],
    };
  }
}

export class SubmoduleTreeProvider implements vscode.TreeDataProvider<SubmoduleRootNode | SubmoduleNode | ErrorNode> {
  private readonly changedEmitter = new vscode.EventEmitter<SubmoduleRootNode | SubmoduleNode | ErrorNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager) {
    manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: SubmoduleRootNode | SubmoduleNode | ErrorNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: SubmoduleRootNode | SubmoduleNode | ErrorNode): Promise<(SubmoduleRootNode | SubmoduleNode | ErrorNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new SubmoduleRootNode(snapshot));
    if (element instanceof SubmoduleRootNode) {
      try {
        const submodules = await this.manager.submodules(element.snapshot.repository.info.rootPath);
        return submodules.map((submodule) => new SubmoduleNode(element.snapshot.repository.info.rootPath, submodule));
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
