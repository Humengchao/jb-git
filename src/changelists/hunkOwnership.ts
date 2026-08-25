import { createHash } from "node:crypto";
import { GitDiffHunk } from "../git/types";

/**
 * Ownership of individual changes inside one file.
 *
 * IDEA lets two unrelated edits to the same file belong to different
 * Changelists, and commits only one of them. Git has no such concept, so the
 * mapping is kept here: a file has one home Changelist, and individual hunks
 * can be claimed away from it by another.
 *
 * The hard part is naming a hunk. Line numbers move whenever anything above
 * changes, and the surrounding context moves whenever anything nearby changes,
 * so neither can identify a change the user already assigned. What does not
 * move is the change itself.
 */

/**
 * A stable name for each hunk, in the order the hunks appear.
 *
 * Only the added and removed lines go into the name: context and line numbers
 * shift for reasons that have nothing to do with this change. Two hunks that
 * make byte-identical edits to one file are indistinguishable by content, so
 * they are told apart by which one comes first — the only thing left.
 */
export function hunkKeys(hunks: readonly GitDiffHunk[]): string[] {
  const seen = new Map<string, number>();
  return hunks.map((hunk) => {
    const digest = createHash("sha1").update(changedLines(hunk).join("\n"), "utf8").digest("hex").slice(0, 16);
    const ordinal = seen.get(digest) ?? 0;
    seen.set(digest, ordinal + 1);
    return `${digest}:${ordinal}`;
  });
}

function changedLines(hunk: GitDiffHunk): string[] {
  // "\ No newline at end of file" is part of what the change does, so it stays.
  return hunk.lines.filter((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("\\"));
}

/**
 * Drops claims whose hunk is no longer in the file.
 *
 * A claim outlives an editing session on purpose — the hunk it names comes back
 * when the user reapplies the same edit — but once the change is gone from the
 * file, keeping the claim would silently re-capture an unrelated hunk that
 * later happens to hash the same.
 */
export function reconcileClaims(claims: readonly string[], currentKeys: readonly string[]): string[] {
  const present = new Set(currentKeys);
  return claims.filter((claim) => present.has(claim));
}

/**
 * Which hunks of one path a partial commit takes.
 *
 * The two Changelist cases cannot share a single set of names. A list that
 * claimed hunks out of another list's file commits exactly those, so it is
 * described by what to include; the list the file belongs to commits whatever
 * the others did not claim, so it is described by what to leave out and a hunk
 * that appeared since is still its own.
 */
export type HunkSelection =
  | { readonly mode: "only"; readonly keys: readonly string[] }
  | { readonly mode: "except"; readonly keys: readonly string[] };

/**
 * What one Changelist commits of one file.
 *
 * `"whole"` is the ordinary case and stays the ordinary case: a file nobody
 * split is committed complete, exactly as before per-hunk ownership existed.
 */
export function commitSelectionFor(
  listId: string,
  homeListId: string,
  claimsByList: ReadonlyMap<string, readonly string[]>,
): HunkSelection | "whole" | "none" {
  if (listId === homeListId) {
    const claimedAway = [...claimsByList].filter(([owner]) => owner !== homeListId).flatMap(([, keys]) => keys);
    return claimedAway.length === 0 ? "whole" : { mode: "except", keys: [...new Set(claimedAway)] };
  }
  const claimed = claimsByList.get(listId) ?? [];
  return claimed.length === 0 ? "none" : { mode: "only", keys: [...claimed] };
}

/** Which list each hunk of a file belongs to, by index into the hunk list. */
export interface HunkPartition {
  /** listId → indices of the hunks that list commits. Always covers every hunk exactly once. */
  readonly byList: ReadonlyMap<string, number[]>;
  /** True when more than one list has a share, which is what makes the commit partial. */
  readonly split: boolean;
}

/**
 * Splits a file's hunks between its home list and the lists that claimed some.
 *
 * A hunk nobody claimed belongs to the home list, which is what makes a new
 * edit behave the way it does everywhere else: it joins the list the file is
 * already in, without anyone having to assign it.
 *
 * A key claimed by more than one list is awarded to the first claimant in
 * iteration order; the store never creates that state, and resolving it here
 * means a corrupted assignment cannot make a hunk vanish from every list and
 * be silently dropped from the commit.
 */
export function partitionHunks(
  keys: readonly string[],
  claimsByList: ReadonlyMap<string, readonly string[]>,
  homeListId: string,
): HunkPartition {
  const owner = new Map<number, string>();
  for (const [listId, claims] of claimsByList) {
    if (listId === homeListId) continue;
    const wanted = new Set(claims);
    keys.forEach((key, index) => {
      if (wanted.has(key) && !owner.has(index)) owner.set(index, listId);
    });
  }
  const byList = new Map<string, number[]>();
  keys.forEach((_key, index) => {
    const listId = owner.get(index) ?? homeListId;
    const bucket = byList.get(listId);
    if (bucket) bucket.push(index);
    else byList.set(listId, [index]);
  });
  return { byList, split: byList.size > 1 };
}
