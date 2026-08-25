import { GitBranch, GitLogOptions } from "../git/types";

export type ToolTab = "log" | "console" | "changes" | "shelf";

export type LogMessage =
  | { type: "ready"; logOptions?: Partial<GitLogOptions>; activeTab?: ToolTab }
  | { type: "setActiveTab"; tab: ToolTab }
  | { type: "selectRepository"; root: string }
  | { type: "selectRef"; ref?: string }
  | { type: "setPathFilter"; path?: string }
  | { type: "setLogOptions"; options: GitLogOptions }
  | { type: "selectCommit" | "newBranch" | "cherryPick" | "revert" | "reset" | "showPatch"; hash: string }
  | { type: "checkout"; name: string; kind: GitBranch["kind"] }
  | { type: "openCommitFile"; hash: string; path: string }
  | { type: "refresh" | "clearConsole" | "loadMore" | "createChangelist" | "createShelf" }
  | { type: "togglePath"; path: string; checked: boolean }
  | { type: "toggleAll"; checked: boolean; listId?: string }
  | { type: "openDiff"; path: string; mode?: "staged" | "unstaged" }
  | { type: "requestHunks"; path: string }
  | { type: "applyHunk"; path: string; source: "staged" | "unstaged"; index: number }
  | { type: "moveHunk"; path: string; key: string }
  | { type: "commit"; message: string; mode: "staged" | "files"; amend?: boolean; signoff?: boolean; noVerify?: boolean; push?: boolean }
  | { type: "editChangelist" | "deleteChangelist" | "setActiveChangelist" | "applyShelf" | "deleteShelf"; id: string }
  | { type: "moveToChangelist" | "stage" | "unstage" | "discard"; path: string }
  | { type: "runCommand"; command: string }
  | { type: "contextAction"; action: "copyRevision" | "createPatch" | "checkoutRevision" | "compareWithLocal" | "createTag"; hash: string }
  | { type: "contextAction"; action: "copyBranch" | "newBranchFromRef" | "showRefDiff" | "createWorktreeFromRef" | "renameBranch" | "deleteBranch" | "mergeRef" | "rebaseOntoRef" | "pushRef" | "pullRefMerge" | "pullRefRebase" | "fetchRef" | "tagFromRef" | "deleteTag"; ref: string; kind: GitBranch["kind"] }
  | { type: "contextAction"; action: "compareBranches" | "showBranchesDiff" | "deleteBranches"; branches: Array<{ name: string; kind: GitBranch["kind"] }> }
  | { type: "contextAction"; action: "copyPath" | "showFileDiff" | "compareFileWithLocal" | "openRepositoryFile" | "createFilePatch" | "restoreFile" | "fileHistory"; hash: string; path: string };

const SIMPLE_TYPES = new Set(["refresh", "clearConsole", "loadMore", "createChangelist", "createShelf"]);
const HASH_TYPES = new Set(["selectCommit", "newBranch", "cherryPick", "revert", "reset", "showPatch"]);
const PATH_TYPES = new Set(["requestHunks", "moveToChangelist", "stage", "unstage", "discard"]);
const ID_TYPES = new Set(["editChangelist", "deleteChangelist", "setActiveChangelist", "applyShelf", "deleteShelf"]);
const BRANCH_KINDS = new Set(["local", "remote", "tag"]);
const HASH_CONTEXT_ACTIONS = new Set(["copyRevision", "createPatch", "checkoutRevision", "compareWithLocal", "createTag"]);
const REF_CONTEXT_ACTIONS = new Set(["copyBranch", "newBranchFromRef", "showRefDiff", "createWorktreeFromRef", "renameBranch", "deleteBranch", "mergeRef", "rebaseOntoRef", "pushRef", "pullRefMerge", "pullRefRebase", "fetchRef", "tagFromRef", "deleteTag"]);
const BRANCH_CONTEXT_ACTIONS = new Set(["compareBranches", "showBranchesDiff", "deleteBranches"]);
const FILE_CONTEXT_ACTIONS = new Set(["copyPath", "showFileDiff", "compareFileWithLocal", "openRepositoryFile", "createFilePatch", "restoreFile", "fileHistory"]);

export function isToolTab(value: unknown): value is ToolTab {
  return value === "log" || value === "console" || value === "changes" || value === "shelf";
}

/** Runtime boundary for messages arriving from the untyped Webview sandbox. */
export function isLogMessage(value: unknown): value is LogMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (SIMPLE_TYPES.has(value.type)) return true;
  if (HASH_TYPES.has(value.type)) return typeof value.hash === "string";
  if (PATH_TYPES.has(value.type)) return typeof value.path === "string";
  // A hunk is named by content, so the key is the only thing that identifies
  // which change is being moved; an index would move whatever is there now.
  if (value.type === "moveHunk") return typeof value.path === "string" && typeof value.key === "string";
  if (ID_TYPES.has(value.type)) return typeof value.id === "string";
  switch (value.type) {
    case "ready": return (value.activeTab === undefined || isToolTab(value.activeTab)) && (value.logOptions === undefined || isRecord(value.logOptions));
    case "setActiveTab": return isToolTab(value.tab);
    case "selectRepository": return typeof value.root === "string";
    case "selectRef": return value.ref === undefined || typeof value.ref === "string";
    case "setPathFilter": return value.path === undefined || typeof value.path === "string";
    case "setLogOptions": return isRecord(value.options);
    case "checkout": return typeof value.name === "string" && BRANCH_KINDS.has(String(value.kind));
    case "openCommitFile": return typeof value.hash === "string" && typeof value.path === "string";
    case "togglePath": return typeof value.path === "string" && typeof value.checked === "boolean";
    case "toggleAll": return typeof value.checked === "boolean" && (value.listId === undefined || typeof value.listId === "string");
    case "openDiff": return typeof value.path === "string" && (value.mode === undefined || value.mode === "staged" || value.mode === "unstaged");
    case "applyHunk": return typeof value.path === "string" && (value.source === "staged" || value.source === "unstaged") && Number.isInteger(value.index);
    case "commit": return typeof value.message === "string"
      && value.message.length <= 1_000_000
      && (value.mode === "staged" || value.mode === "files")
      && optionalBoolean(value.amend)
      && optionalBoolean(value.signoff)
      && optionalBoolean(value.noVerify)
      && optionalBoolean(value.push);
    case "runCommand": return typeof value.command === "string";
    case "contextAction": return validContextAction(value);
    default: return false;
  }
}

function validContextAction(value: Record<string, unknown>): boolean {
  if (typeof value.action !== "string") return false;
  if (Array.isArray(value.branches)) {
    return BRANCH_CONTEXT_ACTIONS.has(value.action)
      && value.branches.length <= 1_000
      && value.branches.every((branch) => isRecord(branch) && typeof branch.name === "string" && BRANCH_KINDS.has(String(branch.kind)));
  }
  if (typeof value.ref === "string") return REF_CONTEXT_ACTIONS.has(value.action) && BRANCH_KINDS.has(String(value.kind));
  if (typeof value.hash === "string") {
    return HASH_CONTEXT_ACTIONS.has(value.action)
      || (FILE_CONTEXT_ACTIONS.has(value.action) && typeof value.path === "string");
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}
