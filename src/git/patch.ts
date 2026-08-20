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
  const lines = output.split("\n");
  const headerIndex = lines.indexOf(hunk.header);
  if (headerIndex < 0) throw new Error("The selected Git hunk is no longer present; refresh the changes view.");
  // The file header ends at the FIRST hunk of the diff; the selected hunk may
  // be a later one, and slicing up to it would smuggle in every earlier hunk.
  const firstHunkIndex = lines.findIndex((line) => HUNK_HEADER.test(line));
  const fileHeader = lines.slice(0, firstHunkIndex).join("\n");
  return `${fileHeader}\n${hunk.header}\n${hunk.lines.join("\n")}\n`;
}
