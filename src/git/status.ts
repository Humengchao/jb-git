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

/** Parses `git status --porcelain=v2 -z --branch` output. */
export function parsePorcelainV2(output: Buffer | string): GitStatusSnapshot {
  const tokens = (Buffer.isBuffer(output) ? output : Buffer.from(output)).toString("utf8").split("\0");
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

    const recordType = token[0];
    const fields = token.split(" ");
    if (recordType === "1" && fields.length >= 9) {
      const indexStatus = parseStatusCode(fields[1][0]);
      const workTreeStatus = parseStatusCode(fields[1][1]);
      changes.push(makeChange(indexStatus, workTreeStatus, fields.slice(8).join(" ")));
      continue;
    }
    if (recordType === "2" && fields.length >= 10) {
      const indexStatus = parseStatusCode(fields[1][0]);
      const workTreeStatus = parseStatusCode(fields[1][1]);
      const originalPath = tokens[index + 1] ?? "";
      index += 1;
      changes.push(makeChange(indexStatus, workTreeStatus, fields.slice(9).join(" "), originalPath));
      continue;
    }
    if (recordType === "u" && fields.length >= 11) {
      const indexStatus = parseStatusCode(fields[1][0]);
      const workTreeStatus = parseStatusCode(fields[1][1]);
      // Every `u` record is unmerged; valid AA/DD pairs contain no literal U.
      changes.push(makeChange(indexStatus, workTreeStatus, fields.slice(10).join(" "), undefined, true));
    }
  }

  return { branch, changes, generatedAt: Date.now() };
}
