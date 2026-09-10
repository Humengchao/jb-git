import {
  GitBranchStatus,
  GitChange,
  GitChangeKind,
  GitStatusCode,
  GitStatusSnapshot,
} from "./types";

function statusKind(indexStatus: GitStatusCode, workTreeStatus: GitStatusCode): GitChangeKind {
  if (indexStatus === "U" || workTreeStatus === "U") return "conflicted";
  if (indexStatus === "?" || workTreeStatus === "?") return "untracked";
  if (indexStatus === "!" || workTreeStatus === "!") return "ignored";
  if (indexStatus === "R" || workTreeStatus === "R") return "renamed";
  if (indexStatus === "C" || workTreeStatus === "C") return "copied";
  if (indexStatus === "A" || workTreeStatus === "A") return "added";
  if (indexStatus === "D" || workTreeStatus === "D") return "deleted";
  if (indexStatus === "T" || workTreeStatus === "T") return "typeChanged";
  return "modified";
}

function parseBranchAheadBehind(value: string): { ahead: number; behind: number } {
  const match = /^\+(\d+)\s+-(\d+)$/.exec(value.trim());
  return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : { ahead: 0, behind: 0 };
}

function parseStatusCode(value: string): GitStatusCode {
  const code = value as GitStatusCode;
  return " MADRCTU?!".includes(code) ? code : " ";
}

/**
 * The index just past the `nth` space in `value`, or -1 when there are fewer.
 *
 * The porcelain record's path is everything after a fixed number of fields, so
 * the tail is taken as one slice. Splitting the record into fields would give
 * the same answer but allocate an array plus a second copy of every path.
 */
function afterSpace(value: string, nth: number): number {
  let spaces = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 32) {
      spaces += 1;
      if (spaces === nth) return index + 1;
    }
  }
  return -1;
}

function makeChange(
  indexStatus: GitStatusCode,
  workTreeStatus: GitStatusCode,
  path: string,
  originalPath?: string,
  forceConflicted = false,
): GitChange {
  const conflicted = forceConflicted || indexStatus === "U" || workTreeStatus === "U";
  return {
    path,
    originalPath,
    indexStatus,
    workTreeStatus,
    kind: conflicted ? "conflicted" : statusKind(indexStatus, workTreeStatus),
    staged: indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!",
    unstaged: workTreeStatus !== " " && workTreeStatus !== "?" && workTreeStatus !== "!",
    conflicted,
  };
}

/**
 * Parses `%(upstream:track)` from for-each-ref: `[ahead 2, behind 1]`,
 * `[ahead 2]`, `[behind 1]`, `[gone]`, or empty when the branch is in sync.
 *
 * `gone` means the upstream ref no longer exists — the remote branch was
 * deleted — which IDEA surfaces rather than showing a meaningless zero.
 */
export function parseUpstreamTrack(value: string | undefined): { ahead: number; behind: number; gone: boolean } {
  if (!value) return { ahead: 0, behind: 0, gone: false };
  if (/\[gone\]/.test(value)) return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/.exec(value);
  const behind = /behind (\d+)/.exec(value);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: false };
}

/** Parses `git status --porcelain=v2 -z --branch` output. */
export function parsePorcelainV2(output: Buffer | string): GitStatusSnapshot {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : output;
  const tokens = text.split("\0");
  const branch: GitBranchStatus = {
    head: null,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const changes: GitChange[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith("# branch.oid ")) {
      const value = token.slice("# branch.oid ".length);
      branch.oid = value === "(initial)" ? null : value;
      continue;
    }
    if (token.startsWith("# branch.head ")) {
      const value = token.slice("# branch.head ".length);
      branch.head = value === "(detached)" ? null : value;
      continue;
    }
    if (token.startsWith("# branch.upstream ")) {
      branch.upstream = token.slice("# branch.upstream ".length);
      continue;
    }
    if (token.startsWith("# branch.ab ")) {
      Object.assign(branch, parseBranchAheadBehind(token.slice("# branch.ab ".length)));
      continue;
    }
    if (token.startsWith("? ")) {
      changes.push(makeChange("?", "?", token.slice(2)));
      continue;
    }
    if (token.startsWith("! ")) {
      changes.push(makeChange("!", "!", token.slice(2)));
      continue;
    }

    // A record's `<XY>` field always follows the one-character record type, and
    // its path is the last field. Both are read by offset: splitting the record
    // allocated an array per changed file and rejoining the tail made a second
    // copy of every path, which `status` pays on every refresh.
    const recordType = token[0];
    const indexStatus = parseStatusCode(token[2]);
    const workTreeStatus = parseStatusCode(token[3]);
    if (recordType === "1") {
      const pathStart = afterSpace(token, 8);
      if (pathStart < 0) continue;
      changes.push(makeChange(indexStatus, workTreeStatus, token.slice(pathStart)));
      continue;
    }
    if (recordType === "2") {
      const pathStart = afterSpace(token, 9);
      if (pathStart < 0) continue;
      const originalPath = tokens[index + 1] ?? "";
      index += 1;
      changes.push(makeChange(indexStatus, workTreeStatus, token.slice(pathStart), originalPath));
      continue;
    }
    if (recordType === "u") {
      const pathStart = afterSpace(token, 10);
      if (pathStart < 0) continue;
      // Every `u` record is unmerged; valid AA/DD pairs contain no literal U.
      changes.push(makeChange(indexStatus, workTreeStatus, token.slice(pathStart), undefined, true));
    }
  }

  return { branch, changes, generatedAt: Date.now() };
}
