/**
 * Todo-list construction for interactive rebase.
 *
 * Git normally collects `reword` and `squash` messages by opening `core.editor`,
 * which this extension can never do: no terminal is attached and the per-repository
 * mutex is held for the whole command, so an editor would deadlock the panel.
 *
 * Every message-changing action is therefore lowered onto a form Git can run
 * unattended. `reword` becomes `pick` plus an `exec` that amends the message from
 * a file, and `squash` becomes `fixup` (which keeps the run's first message and
 * never opens an editor) plus the same trailing `exec`. The resulting todo is a
 * pure function of the plan, which is what makes it testable without a rebase.
 */

/** A single instruction the sequence editor can carry out for one commit. */
export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

/** Actions that replace the message of the commit run they belong to. */
const MESSAGE_ACTIONS = new Set<RebaseAction>(["reword", "squash"]);

/** Actions that fold a commit into the preceding one instead of keeping it. */
const FOLD_ACTIONS = new Set<RebaseAction>(["squash", "fixup"]);

export const REBASE_ACTIONS: readonly RebaseAction[] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

export function isRebaseAction(value: unknown): value is RebaseAction {
  return typeof value === "string" && (REBASE_ACTIONS as readonly string[]).includes(value);
}

/** One commit in the plan, in the order it will be replayed (oldest first, like Git's todo). */
export interface RebaseStep {
  /** Full object ID. Abbreviations are avoided so a rewritten history cannot make a prefix ambiguous. */
  readonly oid: string;
  readonly subject: string;
  readonly action: RebaseAction;
  /** Replacement message for `reword`, or the combined message for a `squash`. */
  readonly message?: string;
}

/** A message file an `exec` line reads, named relative to the scratch directory. */
export interface RebaseMessageFile {
  readonly name: string;
  readonly content: string;
}

/** Everything needed to run the rebase: the todo text plus the files its `exec` lines read. */
export interface RebaseTodoPlan {
  readonly todo: string;
  readonly messages: readonly RebaseMessageFile[];
}

/**
 * Rejects plans Git would either refuse or silently carry out differently from
 * what the user asked, so the failure is reported before history is touched.
 */
export function validateRebasePlan(steps: readonly RebaseStep[]): string | undefined {
  if (steps.length === 0) return "Select at least one commit to rebase.";

  const applied = steps.filter((step) => step.action !== "drop");
  if (applied.length === 0) {
    // An empty todo makes Git abort with "Nothing to do" and leave the branch
    // alone, so the request would look like it silently failed.
    return "Dropping every commit would leave nothing to replay. Use Reset to move the branch instead.";
  }
  if (FOLD_ACTIONS.has(applied[0].action)) {
    return `The first replayed commit cannot be "${applied[0].action}": there is no earlier commit to fold it into.`;
  }

  // A squash amends its run's final message through an exec guarded by the
  // leader's subject. A leader that stops for editing invites exactly the
  // amend that changes that subject, so the guard would fire on the user's own
  // legitimate edit. Refuse the combination; a fixup carries no message and
  // stays fine.
  let leaderAction: RebaseAction | undefined;
  for (const step of steps) {
    if (step.action === "drop") continue;
    if (!FOLD_ACTIONS.has(step.action)) leaderAction = step.action;
    else if (step.action === "squash" && leaderAction === "edit") {
      return `Cannot squash into ${step.oid.slice(0, 8)}'s run: its kept commit stops for editing, and the amended message could not be applied safely. Amend during the stop instead.`;
    }
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(step.oid)) return `"${step.oid}" is not a full commit ID.`;
    if (seen.has(step.oid)) return `Commit ${step.oid.slice(0, 8)} appears more than once in the plan.`;
    seen.add(step.oid);
    if (MESSAGE_ACTIONS.has(step.action) && !step.message?.trim()) {
      return `"${step.action}" on ${step.oid.slice(0, 8)} needs a commit message.`;
    }
  }
  return undefined;
}

/**
 * Groups the replayed steps into runs. A run is a kept commit plus every
 * `squash`/`fixup` folded into it, which is the unit a single amended message
 * applies to.
 */
function messageRuns(steps: readonly RebaseStep[]): { leader: RebaseStep; members: RebaseStep[] }[] {
  const runs: { leader: RebaseStep; members: RebaseStep[] }[] = [];
  for (const step of steps) {
    if (step.action === "drop") continue;
    if (FOLD_ACTIONS.has(step.action) && runs.length > 0) runs[runs.length - 1].members.push(step);
    else runs.push({ leader: step, members: [] });
  }
  return runs;
}

/**
 * The message a run ends up with. `squash` is resolved after the leader because
 * folding a commit in is the later, more specific intent; the UI only ever offers
 * one message field per run, so this order is not user-visible ambiguity.
 */
function runMessage(run: { leader: RebaseStep; members: RebaseStep[] }): string | undefined {
  for (const step of [...run.members].reverse()) {
    if (step.action === "squash" && step.message?.trim()) return step.message;
  }
  if (run.leader.action === "reword" && run.leader.message?.trim()) return run.leader.message;
  return undefined;
}

/** Quotes a path for the POSIX shell Git uses to run `exec` lines, including Git for Windows' bundled `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the todo text and message files for a plan.
 *
 * `scratchDirectory` must be an absolute path that survives until the rebase
 * finishes, because a conflict can pause the sequence for as long as the user
 * needs. `gitExecutable` is the same binary the extension runs everywhere else:
 * a bare `git` in an `exec` line would resolve through PATH and silently pick a
 * different Git than the configured one.
 */
export function buildRebaseTodo(
  steps: readonly RebaseStep[],
  scratchDirectory: string,
  gitExecutable = "git",
): RebaseTodoPlan {
  const problem = validateRebasePlan(steps);
  if (problem) throw new Error(problem);

  const runs = messageRuns(steps);
  const amendMessage = new Map<string, { file: string; expectedSubject?: string }>();
  const messages: RebaseMessageFile[] = [];
  for (const run of runs) {
    const message = runMessage(run);
    if (message === undefined) continue;
    const name = `message-${run.leader.oid}.txt`;
    // Stored and committed text stay identical: `--cleanup=whitespace` only trims
    // trailing blank lines, so a message line that legitimately starts with `#`
    // survives instead of being treated as a comment.
    messages.push({ name, content: message.endsWith("\n") ? message : `${message}\n` });
    // A `fixup` keeps the run leader's message, so at exec time HEAD still
    // carries that subject. Recording it lets the exec refuse to amend a
    // commit the plan never pointed at.
    const expectedSubject = run.leader.subject.includes("\n") ? undefined : run.leader.subject;
    amendMessage.set(lastOf(run).oid, { file: name, expectedSubject });
  }

  const lines = ["# Generated by JB Git. Editing this file has no effect; the plan came from the sequence editor."];
  for (const step of steps) {
    const command = step.action === "reword" ? "pick" : step.action === "squash" ? "fixup" : step.action;
    lines.push(`${command} ${step.oid} ${firstLine(step.subject)}`);
    const amend = amendMessage.get(step.oid);
    if (amend === undefined) continue;
    // --no-verify: this only rewrites the message of a commit whose content was
    // already accepted, and rebase deliberately does not re-run pre-commit hooks
    // for the picks around it.
    const git = shellQuote(posixPath(gitExecutable));
    const file = shellQuote(joinPosix(scratchDirectory, amend.file));
    const rewrite = `${git} commit --amend --no-verify --cleanup=whitespace --file=${file}`;
    // A pick that replays as an empty commit makes Git stop; if the user then
    // skips it, this exec would otherwise silently rewrite the message of the
    // previous commit. Checking the subject first turns that into a clean stop.
    lines.push(amend.expectedSubject === undefined
      ? `exec ${rewrite}`
      : `exec test "$(${git} log -1 --format=%s)" = ${shellQuote(amend.expectedSubject)} && ${rewrite}`);
  }
  return { todo: `${lines.join("\n")}\n`, messages };
}

/** The step an amended message must follow: the last commit actually applied in the run. */
function lastOf(run: { leader: RebaseStep; members: RebaseStep[] }): RebaseStep {
  return run.members.length > 0 ? run.members[run.members.length - 1] : run.leader;
}

function firstLine(subject: string): string {
  // A todo line is newline-terminated, so an embedded newline would inject an
  // extra instruction that Git would try to parse.
  const line = subject.split(/\r?\n/, 1)[0] ?? "";
  return line.trim() || "(no subject)";
}

/**
 * Rewrites a path for the shell Git runs `exec` and the sequence editor under.
 *
 * On Windows that shell is Git's bundled MSYS `sh`, where a backslash inside
 * single quotes stays a literal character rather than a separator, so a native
 * `C:\\repo\\.git` path would reach `cp` unusable. Windows itself accepts forward
 * slashes, which makes them correct on every platform.
 */
export function posixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Joins a scratch path for the shell command, tolerating a trailing separator. */
function joinPosix(directory: string, name: string): string {
  return `${posixPath(directory).replace(/\/+$/, "")}/${name}`;
}

/**
 * True when the plan would leave history exactly as it is, so the rebase can be
 * skipped. Reordering counts as a change even when every action stayed `pick`,
 * so the original order has to be compared rather than the actions alone.
 */
export function isNoOpPlan(steps: readonly RebaseStep[], originalOrder: readonly string[]): boolean {
  if (!steps.every((step) => step.action === "pick")) return false;
  if (steps.length !== originalOrder.length) return false;
  return steps.every((step, index) => step.oid === originalOrder[index]);
}
