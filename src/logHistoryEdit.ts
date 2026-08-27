import { RebaseStep } from "./interactiveRebase";

/** What the plan builders need to know about a commit in the rewrite range. */
export interface HistoryEditCommit {
  /** Full object ID. */
  readonly hash: string;
  readonly subject: string;
  /** The commit's complete existing message. */
  readonly message: string;
}

/**
 * IDEA's Drop Commit, as a rebase plan: the selected commits become `drop`
 * rows and everything else replays unchanged.
 *
 * `candidates` is the rewrite range oldest first — the order a rebase todo
 * runs in — and must contain every selected hash; the caller verified that,
 * because refusing is a user-facing decision, not a planning one.
 */
export function dropPlan(candidates: readonly HistoryEditCommit[], selected: ReadonlySet<string>): RebaseStep[] {
  return candidates.map((commit) => ({
    oid: commit.hash,
    subject: commit.subject,
    action: selected.has(commit.hash) ? "drop" : "pick",
  }));
}

/**
 * IDEA's Squash Commits, as a rebase plan: the selected commits gather at the
 * oldest one's position and squash into it, keeping every message.
 *
 * A non-adjacent selection is thereby reordered — the commits between the
 * selected ones replay after the squashed result, exactly like IDEA. The
 * combined message rides on the *last* squash row because that is the step
 * whose amend the todo generator emits; it concatenates every selected
 * message oldest first, which is what Git's own squash editor would offer.
 */
export function squashPlan(candidates: readonly HistoryEditCommit[], selected: ReadonlySet<string>): RebaseStep[] {
  const chosen = candidates.filter((commit) => selected.has(commit.hash));
  if (chosen.length < 2) throw new Error("Squashing needs at least two selected commits.");
  const combined = chosen
    .map((commit) => commit.message.trim())
    .filter(Boolean)
    .join("\n\n");
  const steps: RebaseStep[] = [];
  for (const commit of candidates) {
    if (!selected.has(commit.hash)) {
      steps.push({ oid: commit.hash, subject: commit.subject, action: "pick" });
      continue;
    }
    if (commit.hash !== chosen[0].hash) continue;
    steps.push({ oid: chosen[0].hash, subject: chosen[0].subject, action: "pick" });
    for (const [index, member] of chosen.slice(1).entries()) {
      steps.push({
        oid: member.hash,
        subject: member.subject,
        action: "squash",
        ...(index === chosen.length - 2 ? { message: combined } : {}),
      });
    }
  }
  return steps;
}
