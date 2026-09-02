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
 * IDEA's Edit Commit Message on a commit that is not HEAD, as a rebase plan:
 * the chosen commit becomes a `reword` row carrying the new message and
 * everything else replays unchanged. HEAD itself never needs this — an amend
 * of the message alone is cheaper and touches no other commit — so the caller
 * routes that case elsewhere.
 */
export function rewordPlan(candidates: readonly HistoryEditCommit[], hash: string, message: string): RebaseStep[] {
  if (!candidates.some((commit) => commit.hash === hash)) throw new Error("The commit to reword is not in the rewrite range.");
  if (!message.trim()) throw new Error("A commit message cannot be empty.");
  return candidates.map((commit) => (commit.hash === hash
    ? { oid: commit.hash, subject: commit.subject, action: "reword", message }
    : { oid: commit.hash, subject: commit.subject, action: "pick" }));
}

/**
 * IDEA's Fixup…, as a rebase plan: the freshly made `fixup!` commit — the last
 * candidate, since it was just committed on top of HEAD — moves to directly
 * after the commit it fixes and folds into it, keeping that commit's message.
 * Everything in between replays after the fixed commit, unchanged.
 */
export function fixupPlan(candidates: readonly HistoryEditCommit[], target: string, fixup: string): RebaseStep[] {
  const last = candidates[candidates.length - 1];
  if (!last || last.hash !== fixup) throw new Error("The fixup commit must be the newest commit in the rewrite range.");
  if (target === fixup || !candidates.some((commit) => commit.hash === target)) throw new Error("The commit to fix up is not in the rewrite range.");
  const steps: RebaseStep[] = [];
  for (const commit of candidates) {
    if (commit.hash === fixup) continue;
    steps.push({ oid: commit.hash, subject: commit.subject, action: "pick" });
    if (commit.hash === target) steps.push({ oid: last.hash, subject: last.subject, action: "fixup" });
  }
  return steps;
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
