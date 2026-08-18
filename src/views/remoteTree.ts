import * as vscode from "vscode";
import { GitRemote } from "../git/types";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { redactGitText } from "../git/runner";
import { ErrorNode } from "./errorNode";

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
    const fetchUrl = redactGitText(remote.fetchUrl);
    const pushUrl = redactGitText(remote.pushUrl);
    this.description = fetchUrl === pushUrl ? fetchUrl : `fetch ${fetchUrl} · push ${pushUrl}`;
    this.tooltip = `Fetch: ${fetchUrl}\nPush: ${pushUrl}`;
    this.contextValue = "jbGit.remote";
    this.iconPath = new vscode.ThemeIcon("cloud-upload");
    this.command = {
      command: "jbGit.fetchRemote",
      title: "Fetch Remote",
      arguments: [this],
    };
  }
}

export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteRootNode | RemoteNode | ErrorNode> {
  private readonly changedEmitter = new vscode.EventEmitter<RemoteRootNode | RemoteNode | ErrorNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager) {
    manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: RemoteRootNode | RemoteNode | ErrorNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: RemoteRootNode | RemoteNode | ErrorNode): Promise<(RemoteRootNode | RemoteNode | ErrorNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new RemoteRootNode(snapshot));
    if (element instanceof RemoteRootNode) {
      try {
        const remotes = await this.manager.remotes(element.snapshot.repository.info.rootPath);
        return remotes.map((remote) => new RemoteNode(element.snapshot.repository.info.rootPath, remote));
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
