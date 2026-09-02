import * as vscode from "vscode";
import { GitOperationKind, GitPullStrategy, GitRebaseOptions } from "./git/types";
import { RepositoryManager, RepositoryMutationLease } from "./repositoryManager";
import { restoreTemporaryStash, stashLocalChanges } from "./temporaryStash";

/** An operation Git refuses, or makes a mess of, on a dirty worktree, run the way IDEA runs it. */
export interface ParkedOperation {
  /** The progress notification's title. */
  readonly title: string;
  /** Names the stash entry, so a kept one can be recognised in Manage Stashes. */
  readonly stashDescription: string;
  /** The modal question asked when tracked changes are present. */
  readonly question: string;
  /** The button that parks the changes first. */
  readonly stashButton: string;
  /**
   * An optional second button that runs the operation on the dirty worktree,
   * for operations Git can often complete anyway (a merge that touches other
   * files). Absent means the stash is the only way forward.
   */
  readonly proceedButton?: string;
  /** Operation kinds that mean "stopped on a conflict", where the stash must stay parked. */
  readonly pausedKinds: readonly GitOperationKind[];
  /** Offer a cancel button on the progress; the signal aborts the Git command. */
  readonly cancellable?: boolean;
  readonly run: (lease: RepositoryMutationLease, signal: AbortSignal) => Promise<void>;
}

/**
 * IDEA's handling of local changes around an operation: a dirty worktree is
 * offered a stash instead of Git's refusal, the changes come back once the
 * operation is through, and one that stops on a conflict keeps them parked
 * rather than replaying them onto the conflict. Untracked files are not
 * counted, since Git works over them.
 *
 * Resolves to true when the operation ran to the end, false when the user
 * backed out; an operation that stopped rethrows Git's message after the
 * stash has been dealt with.
 */
export async function runWithParkedChanges(manager: RepositoryManager, rootPath: string, spec: ParkedOperation): Promise<boolean> {
  const blocking = (manager.snapshot(rootPath)?.status?.changes ?? [])
    .filter((change) => change.kind !== "untracked" && change.kind !== "ignored");
  let park = false;
  if (blocking.length > 0) {
    const answer = await vscode.window.showWarningMessage(
      spec.question,
      {
        modal: true,
        detail: vscode.l10n.t("JB Git can stash them, run the operation, and restore the working tree and Index afterwards. If it stops on a conflict the stash is kept instead, so nothing is lost."),
      },
      spec.stashButton,
      ...(spec.proceedButton ? [spec.proceedButton] : []),
    );
    if (answer !== spec.stashButton && answer !== spec.proceedButton) return false;
    park = answer === spec.stashButton;
  }
  await manager.withExclusive(rootPath, async (lease) => {
    const stillBlocking = (manager.snapshot(rootPath)?.status?.changes ?? [])
      .some((change) => change.kind !== "untracked" && change.kind !== "ignored");
    const parked = park && stillBlocking
      ? await stashLocalChanges(manager, rootPath, `JB Git ${spec.stashDescription}`, { includeUntracked: false }, lease)
      : undefined;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: spec.title, cancellable: spec.cancellable ?? false },
        async (_progress, token) => {
          const controller = new AbortController();
          const registration = token.onCancellationRequested(() => controller.abort());
          try {
            await spec.run(lease, controller.signal);
          } finally {
            registration.dispose();
          }
        },
      );
    } catch (error) {
      const paused = spec.pausedKinds.includes(manager.snapshot(rootPath)?.operation.kind ?? "none");
      if (parked && paused) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Your local changes are kept in {0}. Apply it from Manage Stashes once the operation is finished or aborted.", parked.ref));
      } else if (parked) {
        // Git rejected the operation before starting one, or it was cancelled;
        // give the changes back rather than leaving a stash nobody asked to keep.
        const restore = await restoreTemporaryStash(manager, rootPath, parked, lease);
        if (restore.outcome !== "restored") {
          void vscode.window.showWarningMessage(vscode.l10n.t("The operation did not complete, and your local changes remain in {0}; restore failed: {1}", parked.ref, describeError(restore.error)));
        }
      }
      throw error;
    }
    if (!parked) return;
    const restore = await restoreTemporaryStash(manager, rootPath, parked, lease);
    if (restore.outcome === "conflicted") {
      void vscode.window.showWarningMessage(vscode.l10n.t("Restoring your local changes caused conflicts. {0} was kept; resolve the files in Local Changes.", parked.ref));
    } else if (restore.outcome === "kept") {
      void vscode.window.showWarningMessage(vscode.l10n.t("Restoring your local changes failed and {0} was kept: {1}", parked.ref, describeError(restore.error)));
    }
  });
  return true;
}

/** A plain `git rebase` with the stash choreography; `describe` names the target for the user. */
export function rebaseWithLocalChanges(
  manager: RepositoryManager,
  rootPath: string,
  upstream: string,
  describe: string,
  options: GitRebaseOptions = {},
): Promise<boolean> {
  const blocking = (manager.snapshot(rootPath)?.status?.changes ?? [])
    .filter((change) => change.kind !== "untracked" && change.kind !== "ignored").length;
  return runWithParkedChanges(manager, rootPath, {
    title: vscode.l10n.t("Rebasing onto {0}", describe),
    stashDescription: `rebase onto ${describe}`,
    question: vscode.l10n.t("{0} local change(s) would block the rebase.", blocking),
    stashButton: vscode.l10n.t("Stash and Rebase"),
    pausedKinds: ["rebase"],
    run: (lease) => manager.rebase(rootPath, upstream, lease, options),
  });
}

/**
 * IDEA's Update Project: pull with the chosen strategy, parking local changes
 * first when asked. A merge can often integrate around them, so that stays a
 * choice; a rebase cannot, but Git says so itself if the user insists.
 */
export function pullWithLocalChanges(manager: RepositoryManager, rootPath: string, strategy: GitPullStrategy, describe: string): Promise<boolean> {
  const blocking = (manager.snapshot(rootPath)?.status?.changes ?? [])
    .filter((change) => change.kind !== "untracked" && change.kind !== "ignored").length;
  return runWithParkedChanges(manager, rootPath, {
    title: vscode.l10n.t("Pulling with {0}", describe),
    stashDescription: `update (${strategy})`,
    question: vscode.l10n.t("{0} local change(s) may block or complicate the update.", blocking),
    stashButton: vscode.l10n.t("Stash and Update"),
    proceedButton: vscode.l10n.t("Update Anyway"),
    pausedKinds: ["rebase", "merge"],
    cancellable: true,
    run: (lease, signal) => manager.pull(rootPath, strategy, signal, lease),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
