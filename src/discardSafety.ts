import * as path from "node:path";
import * as vscode from "vscode";

/** Resolves a Git-reported relative path without allowing it to escape its repository. */
export function safeWorktreeUri(rootPath: string, pathSpec: string): vscode.Uri {
  if (!pathSpec || path.isAbsolute(pathSpec) || /[\r\n\0]/.test(pathSpec)) {
    throw new Error("The change path is not a safe repository-relative path.");
  }
  const target = path.resolve(rootPath, pathSpec);
  const relative = path.relative(rootPath, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The change path is outside the repository.");
  }
  return vscode.Uri.file(target);
}

/**
 * Untracked files have no Git object to restore. Use the platform trash rather
 * than `git clean`, so an accidental deletion remains recoverable.
 */
export async function moveUntrackedToTrash(rootPath: string, pathSpec: string): Promise<void> {
  await vscode.workspace.fs.delete(safeWorktreeUri(rootPath, pathSpec), {
    recursive: true,
    useTrash: true,
  });
}
