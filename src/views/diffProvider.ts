import * as vscode from "vscode";
import { ChangeNode } from "./changesTree";
import { RepositoryManager } from "../repositoryManager";

export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private sequence = 0;

  public register(repositoryRoot: string, label: string, content: string): vscode.Uri {
    const id = ++this.sequence;
    const uri = vscode.Uri.parse(`jb-git-diff:${encodeURIComponent(label)}?repository=${encodeURIComponent(repositoryRoot)}&version=${id}`);
    this.contents.set(uri.toString(), content);
    while (this.contents.size > 100) {
      const oldest = this.contents.keys().next().value as string | undefined;
      if (!oldest) break;
      this.contents.delete(oldest);
    }
    return uri;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  public dispose(): void {
    this.contents.clear();
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
  const staged = node.mode === "staged";
  const leftRevision = staged ? "HEAD" : change.indexStatus !== " " ? "INDEX" : "HEAD";
  const rightRevision = staged ? "INDEX" : undefined;
  const [left, right] = await Promise.all([
    repository.fileContent(oldPath, leftRevision),
    repository.fileContent(path, rightRevision),
  ]);
  const label = `${path} (${staged ? "Index" : "Working Tree"})`;
  const leftUri = provider.register(node.repositoryRoot, `${label}:left`, left.toString("utf8"));
  const rightUri = provider.register(node.repositoryRoot, `${label}:right`, right.toString("utf8"));
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
}
