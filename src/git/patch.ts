import { GitDiffHunk } from "./types";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

/** Parses the hunk records from a unified text diff. */
export function parseUnifiedDiff(output: string): GitDiffHunk[] {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
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
  const normalized = output.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headerIndex = lines.indexOf(hunk.header);
  if (headerIndex < 0) throw new Error("The selected Git hunk is no longer present; refresh the changes view.");
  const fileHeader = lines.slice(0, headerIndex).join("\n");
  return `${fileHeader}\n${hunk.header}\n${hunk.lines.join("\n")}\n`;
}
