import * as vscode from "vscode";
import { ChangeNode } from "./changesTree";
import { RepositoryManager } from "../repositoryManager";

export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly changedEmitter = new vscode.EventEmitter<vscode.Uri>();

  public readonly onDidChange = this.changedEmitter.event;

  public register(label: string, content: string): vscode.Uri {
    const uri = vscode.Uri.parse(`jb-git-diff:${encodeURIComponent(label)}`);
    this.contents.set(uri.toString(), content);
    return uri;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  public dispose(): void {
    this.contents.clear();
    this.changedEmitter.dispose();
  }
}

export async function openChangeDiff(
  manager: RepositoryManager,
  provider: DiffContentProvider,
  node: ChangeNode,
): Promise<void> {
  const snapshot = manager.snapshot(node.repositoryRoot);
  const repository = snapshot?.repository;
  if (!repository) return;

  const change = node.change;
  const path = change.path;
  const oldPath = change.originalPath ?? path;
  const leftRevision = change.staged ? "HEAD" : change.indexStatus !== " " ? "INDEX" : "HEAD";
  const rightRevision = change.staged ? "INDEX" : undefined;
  const [left, right] = await Promise.all([
    repository.fileContent(oldPath, leftRevision),
    repository.fileContent(path, rightRevision),
  ]);
  const label = `${path} (${change.staged ? "Index" : "Working Tree"})`;
  const leftUri = provider.register(`${label}:left`, left.toString("utf8"));
  const rightUri = provider.register(`${label}:right`, right.toString("utf8"));
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
}

