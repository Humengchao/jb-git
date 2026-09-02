import * as vscode from "vscode";
import { GitBranch } from "./git/types";
import { RepositoryManager } from "./repositoryManager";
import { RepositoryMutationLease } from "./repositoryManager";
import { restoreTemporaryStash, stashLocalChanges } from "./temporaryStash";

export interface SmartCheckoutOptions {
  /**
   * Work to do on the freshly checked-out branch before the parked changes
   * come back — IDEA's Checkout and Rebase onto Current runs its rebase here.
   * If it leaves a Git operation paused (a conflict), the stash is kept
   * rather than replayed on top of it; any other failure restores the changes
   * and is rethrown.
   */
  readonly afterCheckout?: (lease?: RepositoryMutationLease) => Promise<void>;
}

/**
 * Preserves a dirty worktree and Index around checkout, mirroring IDEA's Smart
 * Checkout safety loop. The temporary stash is addressed by immutable OID so
 * another stash operation cannot make us pop the wrong entry.
 */
export async function checkoutWithLocalChanges(
  manager: RepositoryManager,
  rootPath: string,
  branch: Pick<GitBranch, "name" | "kind" | "fullName">,
  options: SmartCheckoutOptions = {},
): Promise<boolean> {
  const snapshot = manager.snapshot(rootPath);
  if (!snapshot?.status) return false;
  if (snapshot.operation.kind !== "none") {
    // Never await a toast in here: this runs inside a non-cancellable
    // "Checking out …" progress, and a notification only settles once it is
    // dismissed, which leaves a spinner on screen with no way to close it.
    void vscode.window.showWarningMessage(vscode.l10n.t("Finish or abort the active {0} before checking out another branch.", snapshot.operation.kind));
    return false;
  }
  if (!snapshot.status.changes.length) {
    if (!options.afterCheckout) {
      await manager.checkout(rootPath, branch.name, branch.kind, branch.fullName);
      return true;
    }
    await manager.withExclusive(rootPath, async (lease) => {
      await manager.checkout(rootPath, branch.name, branch.kind, branch.fullName, lease);
      await options.afterCheckout?.(lease);
    });
    return true;
  }

  const smartLabel = vscode.l10n.t("Smart Checkout");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("{0} local change(s) could block checkout of {1}.", snapshot.status.changes.length, branch.name),
    { modal: true, detail: vscode.l10n.t("Smart Checkout temporarily stashes tracked, staged, and untracked changes, checks out the target, then restores both the working tree and Index.") },
    smartLabel,
  );
  if (choice !== smartLabel) return false;

  return manager.withExclusive(rootPath, async (lease) => {
    // Checkout can be blocked by an untracked file it would overwrite, so those
    // are parked too. The lease covers stash, checkout and restore as one flow.
    const temporary = await stashLocalChanges(manager, rootPath, `JB Git Smart Checkout → ${branch.name}`, { includeUntracked: true }, lease);

    try {
      await manager.checkout(rootPath, branch.name, branch.kind, branch.fullName, lease);
    } catch (error) {
      // Checkout normally leaves the original branch untouched on failure. Put
      // the user's changes back there; if this also fails, the immutable stash
      // remains available in the Stash command.
      const recovery = await restoreTemporaryStash(manager, rootPath, temporary, lease);
      if (recovery.outcome !== "restored") {
        void vscode.window.showWarningMessage(vscode.l10n.t("Checkout failed. Local changes remain safely stored in {0}.", temporary.ref));
      }
      throw error;
    }

    if (options.afterCheckout) {
      try {
        await options.afterCheckout(lease);
      } catch (error) {
        if (manager.snapshot(rootPath)?.operation.kind !== "none") {
          // Replaying the parked changes onto a live conflict would mix them
          // into the resolution, so they wait in the stash instead.
          void vscode.window.showWarningMessage(vscode.l10n.t("Checked out {0}, but the follow-up stopped on a conflict. Your local changes are kept in {1}; apply it from Manage Stashes once the operation is finished or aborted.", branch.name, temporary.ref));
          throw error;
        }
        const recovery = await restoreTemporaryStash(manager, rootPath, temporary, lease);
        if (recovery.outcome !== "restored") {
          void vscode.window.showWarningMessage(vscode.l10n.t("Checked out {0}. Automatic restore failed and {1} was kept: {2}", branch.name, temporary.ref, recovery.error instanceof Error ? recovery.error.message : String(recovery.error)));
        }
        throw error;
      }
    }

    const restore = await restoreTemporaryStash(manager, rootPath, temporary, lease);
    if (restore.outcome === "restored") {
      void vscode.window.showInformationMessage(vscode.l10n.t("Checked out {0} and restored local changes.", branch.name));
      return true;
    }
    if (restore.outcome === "conflicted") {
      void vscode.window.showWarningMessage(vscode.l10n.t("Checked out {0}, but restoring local changes caused conflicts. The stash was kept; resolve the files in Local Changes.", branch.name));
      return true;
    }
    void vscode.window.showWarningMessage(vscode.l10n.t("Checked out {0}. Automatic restore failed and {1} was kept: {2}", branch.name, temporary.ref, restore.error instanceof Error ? restore.error.message : String(restore.error)));
    return true;
  });
}
