import * as vscode from "vscode";
import { GitCommandError } from "./git/runner";
import { RepositoryManager } from "./repositoryManager";
import { restoreTemporaryStash, stashLocalChanges } from "./temporaryStash";
import { openRebaseEditor } from "./webviews/rebaseEditor";

/**
 * The whole interactive-rebase workflow around the sequence editor: the stash
 * offer up front, the editor, and the rebase run under one repository lease
 * with the parked changes restored afterwards — or kept when the rebase stops
 * on a conflict or an `edit` row. Shared by "Interactively Rebase from Commit"
 * (base is the commit's parent) and the Rebase dialog's interactive option
 * (base is the branch being rebased onto).
 *
 * Resolves to true when a plan ran, false when the user backed out.
 */
export async function runInteractiveRebase(manager: RepositoryManager, root: string, base: string, describe: string): Promise<boolean> {
  // Asked before the plan is composed, the way IDEA tells you up front,
  // rather than letting the user build a rebase that cannot run. Untracked
  // files are not counted because they do not block a rebase.
  const blocking = (manager.snapshot(root)?.status?.changes ?? [])
    .filter((change) => change.kind !== "untracked" && change.kind !== "ignored");
  let stashFirst = false;
  if (blocking.length > 0) {
    const stashAndRebase = vscode.l10n.t("Stash and Rebase");
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t("{0} local change(s) would block the interactive rebase.", blocking.length),
      {
        modal: true,
        detail: vscode.l10n.t("JB Git can stash them, run the rebase, and restore the working tree and Index afterwards. If the rebase stops on a conflict the stash is kept instead, so nothing is lost."),
      },
      stashAndRebase,
    );
    if (answer !== stashAndRebase) return false;
    stashFirst = true;
  }

  let stoppedForEdit = false;
  try {
    const started = await openRebaseEditor(manager, root, base, async (steps, expectation) => {
      // Nothing is stashed until the user actually starts the rebase, so
      // closing the sequence editor leaves the working tree alone. Once
      // started, hold the repository lease through stash, rebase and
      // restoration so another extension operation cannot interleave.
      await manager.withExclusive(root, async (lease) => {
        const stillBlocking = (manager.snapshot(root)?.status?.changes ?? [])
          .some((change) => change.kind !== "untracked" && change.kind !== "ignored");
        const parked = stashFirst && stillBlocking
          ? await stashLocalChanges(manager, root, `JB Git interactive rebase onto ${describe}`, { includeUntracked: false }, lease)
          : undefined;
        try {
          // withProgress directly, not a plain notification wrapper: a rebase
          // that stops on a conflict needs the conflict-aware message below.
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Rebasing {0} commit(s)", steps.length) },
            () => manager.interactiveRebase(root, base, steps, expectation, lease),
          );
        } catch (error) {
          // A rebase that stopped mid-plan owns the working tree. Restoring
          // on top of it would mix the parked changes into a conflict the
          // user has not resolved yet, so the stash keeps them instead. If
          // Git rejected the plan before creating a rebase operation, put the
          // stash back immediately; leaving it behind would make a harmless
          // stale-plan error look like data loss.
          const paused = manager.snapshot(root)?.operation.kind === "rebase";
          if (parked && paused) {
            void vscode.window.showWarningMessage(vscode.l10n.t("Your local changes are kept in {0}. Apply it from Manage Stashes once the rebase is finished or aborted.", parked.ref));
          } else if (parked) {
            const restore = await restoreTemporaryStash(manager, root, parked, lease);
            if (restore.outcome !== "restored") {
              void vscode.window.showWarningMessage(vscode.l10n.t("The rebase did not start, and your local changes remain in {0}; restore failed: {1}", parked.ref, describeError(restore.error)));
            }
          }
          throw error;
        }
        // An edit row stops the rebase with exit code 0, so success alone
        // does not mean the plan finished: the sequencer may be parked on the
        // commit the user asked to amend.
        if (manager.snapshot(root)?.operation.kind === "rebase") {
          stoppedForEdit = true;
          if (parked) {
            void vscode.window.showWarningMessage(vscode.l10n.t("Your local changes are kept in {0}. Apply it from Manage Stashes once the rebase is finished or aborted.", parked.ref));
          }
          return;
        }
        if (!parked) return;
        const restore = await restoreTemporaryStash(manager, root, parked, lease);
        if (restore.outcome === "conflicted") {
          void vscode.window.showWarningMessage(vscode.l10n.t("Restoring your local changes caused conflicts. {0} was kept; resolve the files in Local Changes.", parked.ref));
        } else if (restore.outcome === "kept") {
          void vscode.window.showWarningMessage(vscode.l10n.t("Restoring your local changes failed and {0} was kept: {1}", parked.ref, describeError(restore.error)));
        }
      });
    });
    if (started && stoppedForEdit) {
      await vscode.window.showInformationMessage(vscode.l10n.t("Stopped at the commit marked 'edit'. Amend or test it, then run Continue Operation; the rest of the plan resumes from there."));
    } else if (started) {
      await vscode.window.showInformationMessage(vscode.l10n.t("The interactive rebase finished."));
    }
    return started;
  } catch (error) {
    if (manager.snapshot(root)?.operation.kind === "rebase") {
      await vscode.window.showWarningMessage(vscode.l10n.t("The rebase stopped before the end of the plan. Resolve the conflicted files in Local Changes and Continue, or Abort to put the branch back."));
    } else {
      await vscode.window.showErrorMessage(describeError(error));
    }
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof GitCommandError) return error.stderr.trim() || error.stdout.trim() || error.message;
  return error instanceof Error ? error.message : String(error);
}
