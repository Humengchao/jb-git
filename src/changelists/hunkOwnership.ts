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
 * A stable name for each changed line, per hunk in the order they appear.
 *
 * The same naming rule as `hunkKeys`, one level down: the line itself, with
 * its sign and any "\ No newline" marker it carries, goes into the name —
 * losing the trailing newline is a different change from the same text that
 * keeps it. Two byte-identical changed lines in one file are told apart by
 * their order, the only thing left. Neither line numbers nor the enclosing
 * hunk go into the name, so it does not move when the file shifts around the
 * change or when Git splits the hunk differently. Adding an identical line
 * above a claimed one shifts the ordinals, and the claim is then dropped at
 * the next reconcile rather than re-pointed at a change it did not name.
 */
export function lineKeys(hunks: readonly GitDiffHunk[]): string[][] {
  const seen = new Map<string, number>();
  return hunks.map((hunk) => {
    const keys: string[] = [];
    for (let index = 0; index < hunk.lines.length; index += 1) {
      const line = hunk.lines[index];
      if (!line.startsWith("+") && !line.startsWith("-")) continue;
      const marker = hunk.lines[index + 1]?.startsWith("\\") ? `\n${hunk.lines[index + 1]}` : "";
      const digest = createHash("sha1").update(line + marker, "utf8").digest("hex").slice(0, 16);
      const ordinal = seen.get(digest) ?? 0;
      seen.set(digest, ordinal + 1);
      keys.push(`${digest}:${ordinal}`);
    }
    return keys;
  });
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
 *
 * `lineKeys` names individual changed lines inside those hunks and is absent
 * when the file was only ever split at hunk level, so a hunk-level selection
 * runs exactly the code path it always did.
 */
export type HunkSelection =
  | { readonly mode: "only"; readonly keys: readonly string[]; readonly lineKeys?: readonly string[] }
  | { readonly mode: "except"; readonly keys: readonly string[]; readonly lineKeys?: readonly string[] };

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
  lineClaimsByList: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>(),
): HunkSelection | "whole" | "none" {
  if (listId === homeListId) {
    const claimedAway = [...claimsByList].filter(([owner]) => owner !== homeListId).flatMap(([, keys]) => keys);
    const linesAway = [...lineClaimsByList].filter(([owner]) => owner !== homeListId).flatMap(([, keys]) => keys);
    if (claimedAway.length === 0 && linesAway.length === 0) return "whole";
    return {
      mode: "except",
      keys: [...new Set(claimedAway)],
      ...(linesAway.length ? { lineKeys: [...new Set(linesAway)] } : {}),
    };
  }
  const claimed = claimsByList.get(listId) ?? [];
  const claimedLines = lineClaimsByList.get(listId) ?? [];
  if (claimed.length === 0 && claimedLines.length === 0) return "none";
  return {
    mode: "only",
    keys: [...claimed],
    ...(claimedLines.length ? { lineKeys: [...claimedLines] } : {}),
  };
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

/**
 * Which list each changed line of a file belongs to, per hunk in file order.
 *
 * The more specific decision wins: a line claimed directly goes to its
 * claimant, a line nobody claimed follows its hunk's claim, and whatever is
 * left is the home list's. The first claimant in iteration order takes a line
 * named twice, so a corrupted assignment cannot make a line vanish from every
 * list. The result always covers every changed line exactly once.
 */
export function partitionLines(
  hunks: readonly GitDiffHunk[],
  hunkClaimsByList: ReadonlyMap<string, readonly string[]>,
  lineClaimsByList: ReadonlyMap<string, readonly string[]>,
  homeListId: string,
): string[][] {
  const keys = hunkKeys(hunks);
  const hunkOwner = new Map<number, string>();
  for (const [listId, claims] of hunkClaimsByList) {
    if (listId === homeListId) continue;
    const wanted = new Set(claims);
    keys.forEach((key, index) => {
      if (wanted.has(key) && !hunkOwner.has(index)) hunkOwner.set(index, listId);
    });
  }
  return lineKeys(hunks).map((perHunk, hunkIndex) => {
    const owners = perHunk.map(() => hunkOwner.get(hunkIndex) ?? homeListId);
    const taken = new Set<number>();
    for (const [listId, claims] of lineClaimsByList) {
      if (listId === homeListId) continue;
      const wanted = new Set(claims);
      perHunk.forEach((key, lineIndex) => {
        if (wanted.has(key) && !taken.has(lineIndex)) {
          owners[lineIndex] = listId;
          taken.add(lineIndex);
        }
      });
    }
    return owners;
  });
}
