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

export interface GitConflictVersions {
  path: string;
  base: string;
  baseExists: boolean;
  ours: string;
  oursExists: boolean;
  theirs: string;
  theirsExists: boolean;
  result: string;
  resultExists: boolean;
  binary: boolean;
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
  /** Full ref path, e.g. `refs/tags/v1`. Short names are ambiguous: git resolves `v1` to a tag before a branch of the same name. */
  fullName: string;
  kind: "local" | "remote" | "tag";
  oid: string;
  upstream?: string;
  tracking?: string;
  /** Commits this branch has that its upstream does not (outgoing). */
  ahead?: number;
  /** Commits the upstream has that this branch does not (incoming). */
  behind?: number;
  /** The configured upstream ref no longer exists. */
  upstreamGone?: boolean;
}

export interface GitCommitOptions {
  amend?: boolean;
  signoff?: boolean;
  noVerify?: boolean;
  /**
   * IDEA's Author field: `Name <email>`, or a pattern Git matches against an
   * existing author. Absent means the configured identity.
   */
  author?: string;
  /**
   * `--cleanup=strip`: comment lines are dropped, which is what Git itself does
   * to a message that started from `commit.template`. The default keeps them,
   * because `#123` at the start of a line is a legitimate subject otherwise.
   */
  stripComments?: boolean;
}

/** The options of IDEA's Rebase dialog. */
export interface GitRebaseOptions {
  /** `--onto <newbase>`: replay the commits after the upstream onto this ref instead of onto the upstream itself. */
  onto?: string;
  /** `--rebase-merges`: keep merge commits instead of flattening the history. */
  rebaseMerges?: boolean;
}

export interface GitStashEntry {
  ref: string;
  message: string;
  /** The stash commit. `stash@{N}` indices shift on every push/pop/drop, so actions resolve the entry by this instead. */
  oid: string;
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
  author?: string;
  since?: string;
  /** Literal, case-insensitive commit-message search, applied by Git over the whole walk. */
  grep?: string;
  /** When false, omit the full `%B` body from list records; details can load it on demand. */
  includeBody?: boolean;
  /**
   * Treat the path filter as one exact file rather than IDEA's suffix search,
   * so a root-level `README.md` is not also every `README.md` below it.
   */
  exactPath?: boolean;
  /**
   * Continue a single file's history through renames (`--follow`). Git only
   * accepts this for one literal pathspec, so a suffix (glob) filter ignores it.
   */
  follow?: boolean;
  /**
   * IDEA's History for Selection: the commits that changed lines `start`–`end`
   * (1-based, inclusive) of `path` as it is at the starting revision. Git
   * walks this from a single revision and refuses a pathspec alongside it.
   */
  lineRange?: GitLineRange;
}

export interface GitLineRange {
  path: string;
  start: number;
  end: number;
}

/** The options of IDEA's Merge dialog that change what the merge produces. */
export interface GitMergeOptions {
  /** `--no-ff`: always record a merge commit, even when fast-forwarding is possible. */
  noFastForward?: boolean;
  /** `--ff-only`: refuse to merge unless the current branch can be fast-forwarded. */
  fastForwardOnly?: boolean;
  /** `--squash`: stage the other branch's changes as one uncommitted change instead of merging its history. */
  squash?: boolean;
  /** `--no-commit`: stop before the merge commit so the result can be reviewed or amended. */
  noCommit?: boolean;
  /** `--allow-unrelated-histories`: merge a branch that shares no ancestor with the current one. */
  allowUnrelatedHistories?: boolean;
}

/** IDEA's Reset Head modes. `keep` moves the branch while refusing to discard uncommitted work. */
export type GitResetMode = "soft" | "mixed" | "hard" | "keep";

/** Where an ignore rule is written: the shared top-level `.gitignore`, or this clone's private `info/exclude`. */
export type GitIgnoreTarget = "gitignore" | "exclude";

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

/** IDEA's annotation Options: what Git should look through before crediting a line. */
export interface GitBlameOptions {
  /** `-w`: a reindent stops being the last change to a line. */
  ignoreWhitespace?: boolean;
  /** `-M`: credit a block moved inside the file to where it came from. */
  detectMovementsWithinFile?: boolean;
  /** `-C`: also follow a block copied in from another file the same commit touched. */
  detectMovementsAcrossFiles?: boolean;
  /** IDEA's Hide Revision: `--ignore-rev` for each, so their lines are credited to the change before them. */
  ignoreRevisions?: readonly string[];
}

export interface GitBlameEntry {
  hash: string;
  originalLine: number;
  finalLine: number;
  author: string;
  authorMail: string;
  /** ISO 8601 in UTC. `authorTimestamp`/`authorTimezone` keep the commit's own offset. */
  authorTime: string;
  authorTimestamp: number;
  authorTimezone: string;
  summary: string;
  content: string;
  filename: string;
  /** The commit and path this line came from, which is where annotating the previous revision goes. */
  previousHash?: string;
  previousPath?: string;
  /** Git stopped walking here, so there is no earlier revision to annotate. */
  boundary: boolean;
  /** A line that is in no commit yet: unsaved, unstaged or uncommitted work. */
  uncommitted: boolean;
}
