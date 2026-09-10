import { isRebaseAction, type RebaseAction } from "../interactiveRebase";

/** A commit row of the plan as the sandbox reports it. The subject is deliberately absent: it is re-read from the repository. */
export interface RebaseEditorCommitStep {
  readonly kind: "commit";
  readonly oid: string;
  readonly action: RebaseAction;
  readonly message?: string;
}

/** A row that runs a shell command at its position, Git's `exec` todo line. */
export interface RebaseEditorExecRow {
  readonly kind: "exec";
  readonly command: string;
}

/** A row that pauses the rebase at its position, Git's `break` todo line. */
export interface RebaseEditorBreakRow {
  readonly kind: "break";
}

export type RebaseEditorRow = RebaseEditorCommitStep | RebaseEditorExecRow | RebaseEditorBreakRow;

export type RebaseEditorMessage =
  | { type: "ready" }
  | { type: "cancel" }
  | { type: "start"; rows: RebaseEditorRow[] };

/** Runtime boundary for messages sent by the rebase-editor Webview sandbox. */
export function isRebaseEditorMessage(value: unknown): value is RebaseEditorMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready" || value.type === "cancel") return true;
  if (value.type !== "start") return false;
  return Array.isArray(value.rows) && value.rows.length <= 10_000 && value.rows.every(isEditorRow);
}

function isEditorRow(value: unknown): value is RebaseEditorRow {
  if (!isRecord(value)) return false;
  if (value.kind === "break") return true;
  if (value.kind === "exec") {
    // One todo line: a newline would inject another instruction, and the
    // command lands verbatim in the file Git runs.
    return typeof value.command === "string" && value.command.length <= 4096 && !/[\r\n\0]/.test(value.command);
  }
  if (value.kind !== "commit") return false;
  if (typeof value.oid !== "string" || !isRebaseAction(value.action)) return false;
  return value.message === undefined || typeof value.message === "string";
}

/**
 * Confirms the plan still describes exactly the commits that were offered.
 *
 * The sandbox may reorder and re-label commit rows and weave exec/break rows
 * between them, but the commit rows themselves must be exactly the offered
 * set: accepting an added or missing OID would run a todo against a different
 * commit set than the user reviewed, and Git would rewrite history
 * accordingly.
 */
export function planCoversSameCommits(rows: readonly RebaseEditorRow[], offered: readonly string[]): boolean {
  const expected = new Set(offered);
  let commits = 0;
  for (const row of rows) {
    if (row.kind !== "commit") continue;
    commits += 1;
    if (!expected.delete(row.oid)) return false;
  }
  return commits === offered.length && expected.size === 0;
}

/**
 * The message to prefill when a row becomes `reword` or `squash`.
 *
 * Git's `%B` already contains the subject line, so concatenating subject and
 * body would repeat the subject in the rewritten message.
 */
export function originalMessage(commit: { readonly subject: string; readonly body: string }): string {
  return commit.body.trim() || commit.subject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
