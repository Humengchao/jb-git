import * as vscode from "vscode";
import { GitRemote } from "../git/types";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";

export class RemoteRootNode extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    super(snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = snapshot.status?.branch.head ?? "detached HEAD";
    this.contextValue = "jbGit.remoteRoot";
    this.iconPath = new vscode.ThemeIcon("cloud");
  }
}

export class RemoteNode extends vscode.TreeItem {
  public constructor(public readonly repositoryRoot: string, public readonly remote: GitRemote) {
    super(remote.name, vscode.TreeItemCollapsibleState.None);
    this.description = remote.fetchUrl === remote.pushUrl ? remote.fetchUrl : `fetch ${remote.fetchUrl} · push ${remote.pushUrl}`;
    this.tooltip = `Fetch: ${remote.fetchUrl}\nPush: ${remote.pushUrl}`;
    this.contextValue = "jbGit.remote";
    this.iconPath = new vscode.ThemeIcon("cloud-upload");
    this.command = {
      command: "jbGit.fetchRemote",
      title: "Fetch Remote",
      arguments: [this],
    };
  }
}

export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteRootNode | RemoteNode> {
  private readonly changedEmitter = new vscode.EventEmitter<RemoteRootNode | RemoteNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager) {
    manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: RemoteRootNode | RemoteNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: RemoteRootNode | RemoteNode): Promise<(RemoteRootNode | RemoteNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new RemoteRootNode(snapshot));
    if (element instanceof RemoteRootNode) {
      try {
        const remotes = await this.manager.remotes(element.snapshot.repository.info.rootPath);
        return remotes.map((remote) => new RemoteNode(element.snapshot.repository.info.rootPath, remote));
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
