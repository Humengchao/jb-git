import { isRebaseAction, type RebaseAction } from "../interactiveRebase";

/** One row of the plan as the sandbox reports it. The subject is deliberately absent: it is re-read from the repository. */
export interface RebaseEditorStep {
  readonly oid: string;
  readonly action: RebaseAction;
  readonly message?: string;
}

export type RebaseEditorMessage =
  | { type: "ready" }
  | { type: "cancel" }
  | { type: "start"; steps: RebaseEditorStep[] };

/** Runtime boundary for messages sent by the rebase-editor Webview sandbox. */
export function isRebaseEditorMessage(value: unknown): value is RebaseEditorMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready" || value.type === "cancel") return true;
  if (value.type !== "start") return false;
  return Array.isArray(value.steps) && value.steps.every(isEditorStep);
}

function isEditorStep(value: unknown): value is RebaseEditorStep {
  if (!isRecord(value)) return false;
  if (typeof value.oid !== "string" || !isRebaseAction(value.action)) return false;
  return value.message === undefined || typeof value.message === "string";
}

/**
 * Confirms the plan still describes exactly the commits that were offered.
 *
 * The sandbox may only reorder and re-label rows. Accepting an added or missing
 * OID would run a todo against a different commit set than the user reviewed,
 * and Git would rewrite history accordingly.
 */
export function planCoversSameCommits(steps: readonly RebaseEditorStep[], offered: readonly string[]): boolean {
  if (steps.length !== offered.length) return false;
  const expected = new Set(offered);
  for (const step of steps) {
    if (!expected.delete(step.oid)) return false;
  }
  return expected.size === 0;
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
