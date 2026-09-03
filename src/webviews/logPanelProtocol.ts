import { GitBranch, GitLogOptions } from "../git/types";

export type ToolTab = "log" | "console" | "changes" | "shelf";

type LogMessagePayload =
  | { type: "ready"; logOptions?: Partial<GitLogOptions>; activeTab?: ToolTab }
  | { type: "setActiveTab"; tab: ToolTab }
  | { type: "selectRepository"; root: string }
  | { type: "selectRef"; ref?: string }
  | { type: "setPathFilter"; path?: string }
  | { type: "setLogOptions"; options: GitLogOptions }
  | { type: "selectCommit" | "newBranch" | "cherryPick" | "revert" | "reset" | "showPatch" | "undoCommit" | "fixupCommit"; hash: string }
  | { type: "rewordCommit"; hash: string; message: string }
  | { type: "checkout"; name: string; kind: GitBranch["kind"] }
  | { type: "openCommitFile"; hash: string; path: string }
  | { type: "refresh" | "clearConsole" | "loadMore" | "createChangelist" | "createShelf" | "clearLineRange" }
  | { type: "requestHeadMessage" | "messageHistory" }
  | { type: "deepSearch"; text: string }
  | { type: "togglePath"; path: string; checked: boolean }
  | { type: "toggleAll"; checked: boolean; listId?: string }
  | { type: "openDiff"; path: string; mode?: "staged" | "unstaged" }
  | { type: "requestHunks"; path: string }
  | { type: "applyHunk"; path: string; source: "staged" | "unstaged"; index: number }
  // IDEA's Rollback on one change inside a file: only a working-tree hunk can
  // be rolled back, because a staged one is the Index's content, not the text
  // on screen.
  | { type: "rollbackHunk"; path: string; index: number }
  | { type: "createLocalPatch" }
  | { type: "toggleFavoriteBranch"; name: string; kind: GitBranch["kind"] }
  | { type: "moveHunk"; path: string; key: string }
  | { type: "commit"; message: string; mode: "staged" | "files"; amend?: boolean; signoff?: boolean; noVerify?: boolean; push?: boolean; author?: string }
  | { type: "editChangelist" | "deleteChangelist" | "setActiveChangelist" | "applyShelf" | "deleteShelf" | "renameShelf" | "showShelfDiff"; id: string }
  // IDEA's Unshelve keeps the changes and drops the entry; Unshelve and Keep
  // is the other half of that choice, and a target Changelist is optional.
  | { type: "unshelve"; id: string; keep?: boolean; listId?: string }
  | { type: "moveToChangelist" | "stage" | "unstage" | "discard" | "ignorePath"; path: string }
  | { type: "resolveWith"; path: string; side: "ours" | "theirs" }
  | { type: "runCommand"; command: string }
  | { type: "contextAction"; action: "copyRevision" | "createPatch" | "checkoutRevision" | "compareWithLocal" | "createTag"; hash: string }
  | { type: "contextAction"; action: "copyBranch" | "newBranchFromRef" | "showRefDiff" | "createWorktreeFromRef" | "renameBranch" | "deleteBranch" | "mergeRef" | "rebaseOntoRef" | "checkoutAndRebase" | "pushRef" | "pullRefMerge" | "pullRefRebase" | "fetchRef" | "tagFromRef" | "deleteTag" | "updateRef"; ref: string; kind: GitBranch["kind"] }
  | { type: "contextAction"; action: "compareBranches" | "showBranchesDiff" | "deleteBranches"; branches: Array<{ name: string; kind: GitBranch["kind"] }> }
  | { type: "contextAction"; action: "copyPath" | "showFileDiff" | "compareFileWithLocal" | "openRepositoryFile" | "createFilePatch" | "restoreFile" | "fileHistory"; hash: string; path: string }
  | { type: "commitsAction"; action: "cherryPickCommits" | "compareCommits" | "dropCommits" | "squashCommits"; hashes: string[] };

/** Every Webview request may identify the repository and asynchronous request it belongs to. */
export type LogMessage = LogMessagePayload & {
  readonly root?: string;
  readonly requestId?: number;
};

const SIMPLE_TYPES = new Set(["refresh", "clearConsole", "loadMore", "createChangelist", "createShelf", "requestHeadMessage", "messageHistory", "clearLineRange", "createLocalPatch"]);
const HASH_TYPES = new Set(["selectCommit", "newBranch", "cherryPick", "revert", "reset", "showPatch", "undoCommit", "fixupCommit"]);
const PATH_TYPES = new Set(["requestHunks", "moveToChangelist", "stage", "unstage", "discard", "ignorePath"]);
const ID_TYPES = new Set(["editChangelist", "deleteChangelist", "setActiveChangelist", "applyShelf", "deleteShelf", "renameShelf", "showShelfDiff"]);
const BRANCH_KINDS = new Set(["local", "remote", "tag"]);
const HASH_CONTEXT_ACTIONS = new Set(["copyRevision", "createPatch", "checkoutRevision", "compareWithLocal", "createTag"]);
const REF_CONTEXT_ACTIONS = new Set(["copyBranch", "newBranchFromRef", "showRefDiff", "createWorktreeFromRef", "renameBranch", "deleteBranch", "mergeRef", "rebaseOntoRef", "checkoutAndRebase", "pushRef", "pullRefMerge", "pullRefRebase", "fetchRef", "tagFromRef", "deleteTag", "updateRef"]);
const BRANCH_CONTEXT_ACTIONS = new Set(["compareBranches", "showBranchesDiff", "deleteBranches"]);
const FILE_CONTEXT_ACTIONS = new Set(["copyPath", "showFileDiff", "compareFileWithLocal", "openRepositoryFile", "createFilePatch", "restoreFile", "fileHistory"]);
const COMMITS_ACTIONS = new Set(["cherryPickCommits", "compareCommits", "dropCommits", "squashCommits"]);

export function isToolTab(value: unknown): value is ToolTab {
  return value === "log" || value === "console" || value === "changes" || value === "shelf";
}

/** Runtime boundary for messages arriving from the untyped Webview sandbox. */
export function isLogMessage(value: unknown): value is LogMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.root !== undefined && (typeof value.root !== "string" || value.root.length > 4_096)) return false;
  if (value.requestId !== undefined && (!Number.isSafeInteger(value.requestId) || Number(value.requestId) < 1)) return false;
  if (SIMPLE_TYPES.has(value.type)) return true;
  if (HASH_TYPES.has(value.type)) return typeof value.hash === "string";
  if (PATH_TYPES.has(value.type)) return typeof value.path === "string";
  // A hunk is named by content, so the key is the only thing that identifies
  // which change is being moved; an index would move whatever is there now.
  if (value.type === "moveHunk") return typeof value.path === "string" && typeof value.key === "string";
  // A whole-history search: bounded and single-line, because it lands in a
  // command argument.
  if (value.type === "deepSearch") {
    return typeof value.text === "string" && value.text.length <= 512 && !/[\r\n\0]/.test(value.text);
  }
  if (ID_TYPES.has(value.type)) return typeof value.id === "string";
  switch (value.type) {
    // The same bound as a commit: the text lands in Git's message file.
    case "rewordCommit": return typeof value.hash === "string" && typeof value.message === "string" && value.message.length <= 1_000_000;
    case "resolveWith": return typeof value.path === "string" && (value.side === "ours" || value.side === "theirs");
    case "unshelve": return typeof value.id === "string"
      && optionalBoolean(value.keep)
      && (value.listId === undefined || typeof value.listId === "string");
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
    case "rollbackHunk": return typeof value.path === "string" && Number.isInteger(value.index) && Number(value.index) >= 0;
    case "toggleFavoriteBranch": return typeof value.name === "string" && BRANCH_KINDS.has(String(value.kind));
    case "commit": return typeof value.message === "string"
      && value.message.length <= 1_000_000
      && (value.mode === "staged" || value.mode === "files")
      && optionalBoolean(value.amend)
      && optionalBoolean(value.signoff)
      && optionalBoolean(value.noVerify)
      && optionalBoolean(value.push)
      // IDEA's Author field: one line, bounded, because it becomes `--author=`.
      && (value.author === undefined || (typeof value.author === "string" && value.author.length <= 512 && !/[\r\n\0]/.test(value.author)));
    case "runCommand": return typeof value.command === "string";
    case "contextAction": return validContextAction(value);
    // A multi-selection action. The bound matches the branch actions; each
    // entry is at most a SHA-256 object id long.
    case "commitsAction": return COMMITS_ACTIONS.has(String(value.action))
      && Array.isArray(value.hashes)
      && value.hashes.length >= 1 && value.hashes.length <= 1_000
      && value.hashes.every((hash) => typeof hash === "string" && hash.length <= 64);
    default: return false;
  }
}

/**
 * Orders a selection the way an operation has to apply it: the commit that is
 * furthest down the log (oldest) first.
 *
 * The Webview's selection is a set gathered by clicks in any order, and the
 * host must not trust an order chosen on the other side of the protocol
 * anyway, so the log's own display order (newest first) is the authority.
 * A hash the log does not contain is dropped rather than guessed about.
 */
export function oldestFirst(hashes: readonly string[], displayOrder: readonly string[]): string[] {
  const positions = new Map(displayOrder.map((hash, index) => [hash, index]));
  return [...new Set(hashes)]
    .filter((hash) => positions.has(hash))
    .sort((a, b) => (positions.get(b) ?? 0) - (positions.get(a) ?? 0));
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
