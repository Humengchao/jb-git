import * as vscode from "vscode";
import { GitBranch } from "./git/types";
import { RepositoryManager } from "./repositoryManager";

/**
 * Preserves a dirty worktree and Index around checkout, mirroring IDEA's Smart
 * Checkout safety loop. The temporary stash is addressed by immutable OID so
 * another stash operation cannot make us pop the wrong entry.
 */
export async function checkoutWithLocalChanges(
  manager: RepositoryManager,
  rootPath: string,
  branch: Pick<GitBranch, "name" | "kind" | "fullName">,
): Promise<boolean> {
  const snapshot = manager.snapshot(rootPath);
  if (!snapshot?.status) return false;
  if (snapshot.operation.kind !== "none") {
    // Never await a toast in here: this runs inside a non-cancellable
    // "Checking out …" progress, and a notification only settles once it is
    // dismissed, which leaves a spinner on screen with no way to close it.
    void vscode.window.showWarningMessage(`Finish or abort the active ${snapshot.operation.kind} before checking out another branch.`);
    return false;
  }
  if (!snapshot.status.changes.length) {
    await manager.checkout(rootPath, branch.name, branch.kind, branch.fullName);
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    `${snapshot.status.changes.length} local change(s) could block checkout of ${branch.name}.`,
    { modal: true, detail: "Smart Checkout temporarily stashes tracked, staged, and untracked changes, checks out the target, then restores both the working tree and Index." },
    "Smart Checkout",
  );
  if (choice !== "Smart Checkout") return false;

  const before = new Set((await manager.stashes(rootPath)).map((entry) => entry.oid));
  await manager.stash(rootPath, `JB Git Smart Checkout → ${branch.name}`, true, false);
  const temporary = (await manager.stashes(rootPath)).find((entry) => !before.has(entry.oid));
  if (!temporary) throw new Error("Smart Checkout created no recoverable stash entry; checkout was stopped.");

  try {
    await manager.checkout(rootPath, branch.name, branch.kind, branch.fullName);
  } catch (error) {
    // Checkout normally leaves the original branch untouched on failure. Put
    // the user's changes back there; if this also fails, the immutable stash
    // remains available in the Stash command.
    try {
      await manager.applyStash(rootPath, temporary.ref, true, temporary.oid, true);
    } catch {
      void vscode.window.showWarningMessage(`Checkout failed. Local changes remain safely stored in ${temporary.ref}.`);
    }
    throw error;
  }

  try {
    await manager.applyStash(rootPath, temporary.ref, true, temporary.oid, true);
    void vscode.window.showInformationMessage(`Checked out ${branch.name} and restored local changes.`);
  } catch (error) {
    const conflicted = manager.snapshot(rootPath)?.status?.changes.some((change) => change.conflicted);
    if (conflicted) {
      void vscode.window.showWarningMessage(`Checked out ${branch.name}, but restoring local changes caused conflicts. The stash was kept; resolve the files in Local Changes.`);
      return true;
    }
    void vscode.window.showWarningMessage(`Checked out ${branch.name}. Automatic restore failed and ${temporary.ref} was kept: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}
