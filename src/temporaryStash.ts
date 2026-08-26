import * as vscode from "vscode";
import { RepositoryManager } from "./repositoryManager";

/** A stash this extension created to get the working tree out of an operation's way. */
export interface TemporaryStash {
  readonly ref: string;
  /** The immutable object ID. A stash is otherwise addressed by position, which every push, pop and drop renumbers. */
  readonly oid: string;
}

export interface TemporaryStashOptions {
  /**
   * Whether untracked files are parked too.
   *
   * Checkout can be blocked by an untracked file it would overwrite, so it
   * takes them; rebase is not, so it leaves the user's scratch files where they
   * are rather than making them disappear and come back.
   */
  readonly includeUntracked: boolean;
}

/**
 * Parks local changes in a stash this extension can still find afterwards.
 *
 * The entry is identified by the object ID that appeared rather than by where
 * it landed, so a stash pushed or dropped in between cannot make the recovery
 * act on somebody else's work.
 */
export async function stashLocalChanges(
  manager: RepositoryManager,
  rootPath: string,
  message: string,
  options: TemporaryStashOptions,
): Promise<TemporaryStash> {
  const before = new Set((await manager.stashes(rootPath)).map((entry) => entry.oid));
  await manager.stash(rootPath, message, options.includeUntracked, false);
  const created = (await manager.stashes(rootPath)).find((entry) => !before.has(entry.oid));
  if (!created) throw new Error(vscode.l10n.t("Git created no recoverable stash entry, so the operation was stopped."));
  return { ref: created.ref, oid: created.oid };
}

/** Which of the three states the repository ended up in. */
export type StashRestoreOutcome = "restored" | "conflicted" | "kept";

/**
 * Puts a parked change set back, working tree and Index together.
 *
 * Deliberately does not throw. The caller is in the middle of recovering from
 * whatever the stash was made for, and what it needs is which state the
 * repository is now in — in every failing case the stash entry survives, which
 * is what makes it recoverable by hand.
 */
export async function restoreTemporaryStash(
  manager: RepositoryManager,
  rootPath: string,
  stash: TemporaryStash,
): Promise<{ outcome: StashRestoreOutcome; error?: unknown }> {
  try {
    await manager.applyStash(rootPath, stash.ref, true, stash.oid, true);
    return { outcome: "restored" };
  } catch (error) {
    const conflicted = manager.snapshot(rootPath)?.status?.changes.some((change) => change.conflicted) ?? false;
    return { outcome: conflicted ? "conflicted" : "kept", error };
  }
}
