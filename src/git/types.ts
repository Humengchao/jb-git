export type GitStatusCode = " " | "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?" | "!";

export type GitChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "conflicted"
  | "untracked"
  | "ignored";

export interface GitBranchStatus {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitChange {
  path: string;
  originalPath?: string;
  indexStatus: GitStatusCode;
  workTreeStatus: GitStatusCode;
  kind: GitChangeKind;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
}

export interface GitStatusSnapshot {
  branch: GitBranchStatus;
  changes: GitChange[];
  generatedAt: number;
}

export interface GitRepositoryInfo {
  rootPath: string;
  gitDir: string;
  commonGitDir: string;
  isBare: boolean;
}

export interface GitBranch {
  name: string;
  kind: "local" | "remote" | "tag";
  oid: string;
  upstream?: string;
  tracking?: string;
}

export interface GitCommitOptions {
  amend?: boolean;
  signoff?: boolean;
  noVerify?: boolean;
}

export interface GitStashEntry {
  ref: string;
  message: string;
}

export type GitPullStrategy = "merge" | "rebase" | "ff-only";

export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  authoredAt: string;
  committedAt: string;
  refs: string[];
  subject: string;
  body: string;
}

export interface GitLogOptions {
  order: "date" | "topological";
  firstParent: boolean;
  noMerges: boolean;
}

export interface GitCommitFile {
  status: string;
  path: string;
  originalPath?: string;
}

export type GitOperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | "sequencer" | "none";

export interface GitOperationState {
  kind: GitOperationKind;
  canContinue: boolean;
  canAbort: boolean;
  detail?: string;
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export interface GitSubmodule {
  path: string;
  oid: string;
  status: string;
  url?: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface GitBlameEntry {
  hash: string;
  originalLine: number;
  finalLine: number;
  author: string;
  authorTime: string;
  summary: string;
  content: string;
}
