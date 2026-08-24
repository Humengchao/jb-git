import * as vscode from "vscode";
import { ChangeNode } from "./nodes";
import { RepositoryManager } from "../repositoryManager";

/**
 * Serves Git revisions as a read-only file system.
 *
 * A `TextDocumentContentProvider` looks read-only but still accepts edits, so its documents
 * go dirty and VS Code asks to save a diff the user only wanted to read. Registering a file
 * system with `isReadonly` makes the editor refuse edits outright.
 */
export class DiffContentProvider implements vscode.FileSystemProvider, vscode.Disposable {
  public static readonly scheme = "jb-git-diff";
  private readonly contents = new Map<string, Uint8Array>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this.emitter.event;
  private sequence = 0;
  private readonly closeRegistration = vscode.workspace.onDidCloseTextDocument((document) => {
    if (document.uri.scheme === this.scheme) this.contents.delete(document.uri.toString());
  });

  /** The scheme is injectable so tests can register a probe alongside the activated extension. */
  public constructor(private readonly scheme: string = DiffContentProvider.scheme) {}

  public registerFile(repositoryRoot: string, label: string, filePath: string, content: string | Buffer): vscode.Uri {
    const id = ++this.sequence;
    const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\/+/, "");
    const uri = vscode.Uri.from({
      scheme: this.scheme,
      authority: "revision",
      path: `/${id}/${normalizedPath}`,
      query: `repository=${encodeURIComponent(repositoryRoot)}&label=${encodeURIComponent(label)}`,
    });
    this.remember(uri, content);
    return uri;
  }

  private remember(uri: vscode.Uri, content: string | Buffer): void {
    this.contents.set(uri.toString(), typeof content === "string" ? Buffer.from(content, "utf8") : content);
    while (this.contents.size > 100) {
      const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
      const oldest = [...this.contents.keys()].find((key) => !open.has(key));
      if (!oldest) break;
      this.contents.delete(oldest);
    }
  }

  public stat(uri: vscode.Uri): vscode.FileStat {
    const content = this.contents.get(uri.toString());
    if (content) {
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.byteLength, permissions: vscode.FilePermission.Readonly };
    }
    const prefix = `${uri.toString()}/`;
    if ([...this.contents.keys()].some((key) => key.startsWith(prefix))) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0, permissions: vscode.FilePermission.Readonly };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  public readFile(uri: vscode.Uri): Uint8Array {
    const content = this.contents.get(uri.toString());
    if (!content) throw vscode.FileSystemError.FileNotFound(uri);
    return content;
  }

  public readDirectory(uri: vscode.Uri): Array<[string, vscode.FileType]> {
    const prefix = `${uri.toString()}/`;
    const entries = new Map<string, vscode.FileType>();
    for (const key of this.contents.keys()) {
      if (!key.startsWith(prefix)) continue;
      const [segment, ...rest] = key.slice(prefix.length).split("/");
      entries.set(segment, rest.length ? vscode.FileType.Directory : vscode.FileType.File);
    }
    return [...entries];
  }

  public watch(): vscode.Disposable {
    // Revisions are immutable snapshots, so there is nothing to watch.
    return new vscode.Disposable(() => undefined);
  }

  public createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public dispose(): void {
    this.closeRegistration.dispose();
    this.emitter.dispose();
    this.contents.clear();
  }
}

export async function openChangeDiff(
  manager: RepositoryManager,
  provider: DiffContentProvider,
  node: ChangeNode,
  signal?: AbortSignal,
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
    repository.fileContent(oldPath, leftRevision, signal),
    repository.fileContent(path, rightRevision, signal),
  ]);
  const label = `${path} (${staged ? "Index" : "Working Tree"})`;
  const leftUri = diffSide(provider, node.repositoryRoot, `${label}:left`, oldPath, left);
  const rightUri = diffSide(provider, node.repositoryRoot, `${label}:right`, path, right);
  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, label, { preview: true });
}

/**
 * Registers one side of a diff, keeping binary content as bytes.
 *
 * Reporting "this file is binary" in a notification was worse than useless: it
 * left nothing on screen to look at, and shown from inside a progress task it
 * held that progress open until the notification was dismissed, so the diff
 * appeared to load forever behind a spinner with no cancel button. Handing the
 * editor the real bytes is what VS Code's own Git view and IDEA do — an image
 * gets an image diff, and anything else gets the editor's own notice.
 */
export function diffSide(
  provider: DiffContentProvider,
  repositoryRoot: string,
  label: string,
  filePath: string,
  content: Buffer,
): vscode.Uri {
  return provider.registerFile(repositoryRoot, label, filePath, isBinaryContent(content) ? content : content.toString("utf8"));
}

export function isBinaryContent(content: Buffer): boolean {
  return content.includes(0);
}
