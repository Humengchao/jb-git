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

