import * as vscode from "vscode";
import { ChangeNode } from "./nodes";
import { RepositoryManager } from "../repositoryManager";

export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private sequence = 0;
  private readonly closeRegistration = vscode.workspace.onDidCloseTextDocument((document) => {
    if (document.uri.scheme === "jb-git-diff") this.contents.delete(document.uri.toString());
  });

  public registerFile(repositoryRoot: string, label: string, filePath: string, content: string): vscode.Uri {
    const id = ++this.sequence;
    const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\/+/, "");
    const uri = vscode.Uri.from({
      scheme: "jb-git-diff",
      authority: "revision",
      path: `/${id}/${normalizedPath}`,
      query: `repository=${encodeURIComponent(repositoryRoot)}&label=${encodeURIComponent(label)}`,
    });
    this.remember(uri, content);
    return uri;
  }

  private remember(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    while (this.contents.size > 100) {
      const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
      const oldest = [...this.contents.keys()].find((key) => !open.has(key));
      if (!oldest) break;
      this.contents.delete(oldest);
    }
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  public dispose(): void {
    this.closeRegistration.dispose();
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
  if (isBinaryContent(left) || isBinaryContent(right)) {
    await vscode.window.showInformationMessage(`${path} is binary and cannot be shown in the text diff editor.`);
    return;
  }
  const label = `${path} (${staged ? "Index" : "Working Tree"})`;
  const leftUri = provider.registerFile(node.repositoryRoot, `${label}:left`, oldPath, left.toString("utf8"));
  const rightUri = provider.registerFile(node.repositoryRoot, `${label}:right`, path, right.toString("utf8"));
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
}

export function isBinaryContent(content: Buffer): boolean {
  return content.includes(0);
}
