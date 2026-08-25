export type MergeEditorMessage =
  | { type: "ready" }
  | { type: "apply"; result: string; deleted?: boolean }
  | { type: "dirty"; result: string; deleted?: boolean }
  | { type: "cancel" }
  | { type: "compare"; result: string }
  | { type: "confirm"; action: "acceptLeft" | "acceptRight" | "cancel" };

const CONFIRM_ACTIONS = new Set(["acceptLeft", "acceptRight", "cancel"]);

/** Runtime boundary for messages sent by the merge-editor Webview sandbox. */
export function isMergeEditorMessage(value: unknown): value is MergeEditorMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready" || value.type === "cancel") return true;
  if (value.type === "confirm") return typeof value.action === "string" && CONFIRM_ACTIONS.has(value.action);
  // A comparison carries the result as it stands right now, which only the
  // sandbox knows; the other three versions come from the repository.
  if (value.type === "compare") return typeof value.result === "string";
  if (value.type === "apply" || value.type === "dirty") {
    return typeof value.result === "string" && (value.deleted === undefined || typeof value.deleted === "boolean");
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
