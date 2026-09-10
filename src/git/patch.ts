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
  const lines = output.split("\n");
  for (const hunk of hunks) {
    if (!lines.includes(hunk.header)) throw new Error("The selected Git hunk is no longer present; refresh the changes view.");
  }
  return patchForTransformedHunks(output, hunks);
}

/**
 * Emits a patch for hunks whose headers were rebuilt, e.g. by selectHunkLines.
 *
 * Identical to patchForHunks except for the header-presence check: a rebuilt
 * header intentionally is not a line of the original diff, so it cannot be
 * validated against it — the caller vouches for the selection instead.
 */
export function patchForTransformedHunks(output: string, hunks: readonly GitDiffHunk[]): string {
  if (hunks.length === 0) throw new Error("A patch needs at least one hunk.");
  const lines = output.split("\n");
  // The file header ends at the FIRST hunk of the diff; a selected hunk may be
  // a later one, and slicing up to it would smuggle in every earlier hunk.
  const firstHunkIndex = lines.findIndex((line) => HUNK_HEADER.test(line));
  const fileHeader = lines.slice(0, firstHunkIndex).join("\n");
  const ordered = [...hunks].sort((left, right) => left.oldStart - right.oldStart);
  const body = ordered.map((hunk) => `${hunk.header}\n${hunk.lines.join("\n")}`).join("\n");
  return `${fileHeader}\n${body}\n`;
}

/**
 * Rebuilds each hunk holding only the selected changed lines.
 *
 * `selected[hunkIndex]` names the changed lines to keep, as indices into the
 * hunk's `+`/`-` lines in order. An unselected `-` line becomes context (it
 * must stay in the committed file), an unselected `+` line is dropped (it
 * must not be added), and a "\ No newline" marker travels with the line it
 * describes. A hunk left with no selected line is omitted.
 *
 * The old side never loses a line, so `oldStart`/`oldLines` are invariant.
 * The new side is renumbered against the file this patch alone produces:
 * `newStart` is the position of the first kept new-side line after applying
 * every selected change before it, and each emitted hunk shifts the next one
 * by its own old/new imbalance. A hunk reduced to deletions names the line
 * after which they happen, Git's `+start,0` convention.
 */
export function selectHunkLines(
  hunks: readonly GitDiffHunk[],
  selected: ReadonlyArray<ReadonlySet<number>>,
): GitDiffHunk[] {
  const transformed: GitDiffHunk[] = [];
  // Net line shift this patch has made so far; new-side hunk positions are
  // named after the hunks before them, so each builds on the previous delta.
  let delta = 0;
  hunks.forEach((hunk, hunkIndex) => {
    const wanted = selected[hunkIndex];
    const lines: string[] = [];
    // A zero-count old side names the line the insertion follows rather than
    // a first line, so survivors before the hunk start one line further on.
    const survivorsAtStart = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    let survivors = 0;
    let pluses = 0;
    let oldLines = 0;
    let newLines = 0;
    let changedIndex = 0;
    let kept = 0;
    let newStart: number | undefined;
    let deletionAnchor: number | undefined;
    const take = (line: string, marker: string | undefined, oldSide: boolean, newSide: boolean) => {
      if (newSide && newStart === undefined) newStart = survivorsAtStart + survivors + delta + pluses + 1;
      lines.push(line);
      if (marker !== undefined) lines.push(marker);
      if (oldSide) oldLines += 1;
      if (newSide) newLines += 1;
    };
    for (let index = 0; index < hunk.lines.length; index += 1) {
      const line = hunk.lines[index];
      if (line.startsWith("\\")) continue; // consumed with the line it describes
      const marker = hunk.lines[index + 1]?.startsWith("\\") ? hunk.lines[index + 1] : undefined;
      if (line.startsWith("-")) {
        if (wanted?.has(changedIndex)) {
          if (deletionAnchor === undefined) deletionAnchor = survivorsAtStart + survivors + delta + pluses;
          take(line, marker, true, false);
          kept += 1;
        } else {
          take(` ${line.slice(1)}`, marker, true, true);
          survivors += 1;
        }
        changedIndex += 1;
        continue;
      }
      if (line.startsWith("+")) {
        if (wanted?.has(changedIndex)) {
          take(line, marker, false, true);
          pluses += 1;
          kept += 1;
        }
        changedIndex += 1;
        continue;
      }
      take(line, marker, true, true);
      survivors += 1;
    }
    // A hunk whose every changed line was unselected holds only context and
    // applies nothing; leaving it out keeps the patch minimal.
    if (kept === 0) return;
    if (newStart === undefined) newStart = deletionAnchor ?? 0;
    const closing = hunk.header.indexOf("@@", 2);
    const section = closing >= 0 ? hunk.header.slice(closing + 2) : "";
    transformed.push({
      header: `@@ -${hunk.oldStart},${oldLines} +${newStart},${newLines} @@${section}`,
      oldStart: hunk.oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    });
    delta += newLines - oldLines;
  });
  return transformed;
}
