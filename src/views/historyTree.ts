import * as vscode from "vscode";
import { RepositoryManager, RepositorySnapshot } from "../repositoryManager";
import { GitCommit } from "../git/types";
import { ErrorNode } from "./errorNode";

export class HistoryRootNode extends vscode.TreeItem {
  public constructor(public readonly snapshot: RepositorySnapshot) {
    super(snapshot.repository.info.rootPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = snapshot.status?.branch.head ?? "detached HEAD";
    this.tooltip = snapshot.repository.info.rootPath;
    this.contextValue = "jbGit.historyRoot";
    this.iconPath = new vscode.ThemeIcon("history");
  }
}

export class CommitNode extends vscode.TreeItem {
  public constructor(public readonly repositoryRoot: string, public readonly commit: GitCommit, graphPrefix = "") {
    super(`${graphPrefix}${commit.subject || "(no subject)"}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${commit.hash.slice(0, 10)} · ${commit.author} · ${new Date(commit.authoredAt).toLocaleString()}`;
    this.tooltip = `${commit.hash}\n${commit.body || commit.subject}`;
    this.contextValue = "jbGit.commit";
    this.iconPath = new vscode.ThemeIcon(commit.parents.length > 1 ? "git-merge" : "git-commit");
    this.command = {
      command: "jbGit.showCommit",
      title: "Show Commit",
      arguments: [this],
    };
  }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryRootNode | CommitNode | ErrorNode> {
  private readonly changedEmitter = new vscode.EventEmitter<HistoryRootNode | CommitNode | ErrorNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: RepositoryManager) {
    manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: HistoryRootNode | CommitNode | ErrorNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: HistoryRootNode | CommitNode | ErrorNode): Promise<(HistoryRootNode | CommitNode | ErrorNode)[]> {
    if (!element) return this.manager.all.map((snapshot) => new HistoryRootNode(snapshot));
    if (element instanceof HistoryRootNode) {
      try {
        const commits = await element.snapshot.repository.log(100);
        const lanes: string[] = [];
        return commits.map((commit) => {
          let lane = lanes.indexOf(commit.hash);
          if (lane < 0) lane = 0;
          const prefix = `${"│ ".repeat(lane)}${commit.parents.length > 1 ? "┼ " : "● "}`;
          lanes.splice(lane, 1, ...commit.parents);
          return new CommitNode(element.snapshot.repository.info.rootPath, commit, prefix);
        });
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
