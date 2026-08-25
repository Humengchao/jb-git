import { GitDiffHunk } from "./types";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

/** Parses the hunk records from a unified text diff. */
export function parseUnifiedDiff(output: string): GitDiffHunk[] {
  // Split on LF only: a trailing CR is file content (CRLF repositories) and
  // must survive into the rebuilt patch, or `git apply` rejects the hunk.
  const lines = output.split("\n");
  const hunks: GitDiffHunk[] = [];
  let current: GitDiffHunk | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = HUNK_HEADER.exec(line);
    if (match) {
      if (current) hunks.push(current);
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      continue;
    }
    // A final split item is an artifact of a trailing newline, not a diff line.
    if (current && !(index === lines.length - 1 && line === "")) current.lines.push(line);
  }
  if (current) hunks.push(current);
  return hunks;
}

/** Rebuilds a standalone patch containing exactly one hunk from a one-file diff. */
export function patchForHunk(output: string, hunk: GitDiffHunk): string {
  return patchForHunks(output, [hunk]);
}

/**
 * Rebuilds a standalone patch containing exactly the given hunks of a one-file diff.
 *
 * The hunks keep the line numbers they had in the original diff, so the result
 * applies to the same side that diff was taken against and to nothing else.
 * They are emitted in the order they appear in the file, because `git apply`
 * walks a patch forwards.
 */
export function patchForHunks(output: string, hunks: readonly GitDiffHunk[]): string {
  if (hunks.length === 0) throw new Error("A patch needs at least one hunk.");
  const lines = output.split("\n");
  for (const hunk of hunks) {
    if (!lines.includes(hunk.header)) throw new Error("The selected Git hunk is no longer present; refresh the changes view.");
  }
  // The file header ends at the FIRST hunk of the diff; a selected hunk may be
  // a later one, and slicing up to it would smuggle in every earlier hunk.
  const firstHunkIndex = lines.findIndex((line) => HUNK_HEADER.test(line));
  const fileHeader = lines.slice(0, firstHunkIndex).join("\n");
  const ordered = [...hunks].sort((left, right) => left.oldStart - right.oldStart);
  const body = ordered.map((hunk) => `${hunk.header}\n${hunk.lines.join("\n")}`).join("\n");
  return `${fileHeader}\n${body}\n`;
}
