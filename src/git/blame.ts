import { GitBlameEntry } from "./types";

/** Git reports lines that are in no commit yet under an all-zero object name. */
function isUncommitted(hash: string): boolean {
  return /^0+$/.test(hash);
}

/** `<object-name> <line-in-original> <line-in-final> [<lines-in-group>]` */
const GROUP_HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/;

interface CommitHeader {
  author: string;
  authorMail: string;
  authorTimestamp: number;
  authorTimezone: string;
  summary: string;
  filename: string;
  previousHash?: string;
  previousPath?: string;
  boundary: boolean;
}

function emptyHeader(): CommitHeader {
  return { author: "", authorMail: "", authorTimestamp: 0, authorTimezone: "", summary: "", filename: "", boundary: false };
}

function readHeaderField(header: CommitHeader, line: string): void {
  if (line.startsWith("author ")) header.author = line.slice("author ".length);
  else if (line.startsWith("author-mail ")) header.authorMail = line.slice("author-mail ".length).replace(/^<|>$/g, "");
  else if (line.startsWith("author-time ")) header.authorTimestamp = Number(line.slice("author-time ".length)) || 0;
  else if (line.startsWith("author-tz ")) header.authorTimezone = line.slice("author-tz ".length);
  else if (line.startsWith("summary ")) header.summary = line.slice("summary ".length);
  else if (line.startsWith("filename ")) header.filename = line.slice("filename ".length);
  else if (line === "boundary") header.boundary = true;
  else if (line.startsWith("previous ")) {
    const rest = line.slice("previous ".length);
    const space = rest.indexOf(" ");
    if (space > 0) {
      header.previousHash = rest.slice(0, space);
      header.previousPath = rest.slice(space + 1);
    }
  }
}

/**
 * Parses `git blame --porcelain` output.
 *
 * `--porcelain` prints a commit's header block only the first time that commit
 * is reached; every later group from the same commit is just its object name.
 * `--line-porcelain` repeats the whole block for every single line and costs
 * about four times the bytes on a large file, so the repeated groups are
 * filled in from a cache here instead of asking Git to resend them.
 *
 * Boundary: a commit is cached under the first header block Git sends for it,
 * so with copy detection (`-C`) across paths the cached `filename`/`previous`
 * describe that first group rather than each later one.
 */
export function parsePorcelainBlame(output: string): GitBlameEntry[] {
  const entries: GitBlameEntry[] = [];
  const commits = new Map<string, CommitHeader>();
  let group: { hash: string; originalLine: number; finalLine: number } | undefined;
  let header = emptyHeader();

  // Git's own protocol lines are LF-terminated, but a content line carries the
  // file's bytes, so a global CRLF rewrite would strip a CR out of the file.
  for (const raw of output.split("\n")) {
    if (group && raw.startsWith("\t")) {
      const commit = header;
      commits.set(group.hash, commit);
      const uncommitted = isUncommitted(group.hash);
      entries.push({
        hash: group.hash,
        originalLine: group.originalLine,
        finalLine: group.finalLine,
        author: commit.author,
        authorMail: commit.authorMail,
        authorTime: commit.authorTimestamp ? new Date(commit.authorTimestamp * 1000).toISOString() : "",
        authorTimestamp: commit.authorTimestamp,
        authorTimezone: commit.authorTimezone,
        summary: commit.summary,
        filename: commit.filename,
        previousHash: commit.previousHash,
        previousPath: commit.previousPath,
        boundary: commit.boundary,
        uncommitted,
        content: raw.slice(1).replace(/\r$/, ""),
      });
      group = undefined;
      header = emptyHeader();
      continue;
    }
    const line = raw.replace(/\r$/, "");
    if (group) {
      readHeaderField(header, line);
      continue;
    }
    const match = GROUP_HEADER.exec(line);
    if (!match) continue;
    group = { hash: match[1], originalLine: Number(match[2]), finalLine: Number(match[3]) };
    // A repeated group carries no header block, and one that repeats only
    // `filename` must not blank out the author the first block established, so
    // the cached commit is the starting point and the block overlays it.
    header = { ...(commits.get(group.hash) ?? emptyHeader()) };
  }

  return entries;
}
