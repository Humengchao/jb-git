import { GitDiffHunk } from "./git/types";

/**
 * IDEA's Show History for Selection maps the lines the user selected in the
 * editor onto the committed file, because `git log -L` names lines as they are
 * in HEAD while the editor shows the working tree. The hunks of
 * `git diff HEAD -- file` are the whole difference between the two.
 */

export interface LineRange {
  /** 1-based, inclusive. */
  readonly start: number;
  readonly end: number;
}

/**
 * Maps a working-tree line range onto HEAD's version of the file.
 *
 * A line outside every hunk shifts by the lines added and removed above it. A
 * context line inside a hunk keeps its counterpart. A line the working tree
 * added in place of removed lines (a `-` run directly followed by a `+` run)
 * inherits those removed lines, since that is the text it replaced. A line
 * inserted where nothing was removed has no history of its own and adds
 * nothing to the range. The result is undefined when the whole selection is
 * such new text.
 */
export function mapLineRangeToHead(hunks: readonly GitDiffHunk[], range: LineRange): LineRange | undefined {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start) {
    throw new Error(`Invalid line range ${range.start}-${range.end}.`);
  }
  const counterparts = new Map<number, LineRange>();
  const sorted = [...hunks].sort((left, right) => left.newStart - right.newStart);
  let delta = 0;
  let nextUnmapped = range.start;
  for (const hunk of sorted) {
    // An empty side (`+4,0`) is positioned *after* the line it names, so the
    // hunk's first line on that side is one further down.
    const firstNew = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    const firstOld = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    // Lines above this hunk shift by the net change of the hunks before it.
    for (; nextUnmapped <= range.end && nextUnmapped < firstNew; nextUnmapped += 1) {
      counterparts.set(nextUnmapped, { start: nextUnmapped + delta, end: nextUnmapped + delta });
    }
    if (nextUnmapped > range.end) break;
    let oldCursor = firstOld;
    let newCursor = firstNew;
    let removedRun: { start: number; end: number } | undefined;
    for (const line of hunk.lines) {
      const marker = line[0];
      if (marker === "\\") continue;
      if (marker === "-") {
        removedRun = removedRun ? { start: removedRun.start, end: oldCursor } : { start: oldCursor, end: oldCursor };
        oldCursor += 1;
        continue;
      }
      if (marker === "+") {
        if (newCursor >= range.start && newCursor <= range.end && removedRun) counterparts.set(newCursor, removedRun);
        newCursor += 1;
        continue;
      }
      // Context: a line both versions share.
      if (newCursor >= range.start && newCursor <= range.end) counterparts.set(newCursor, { start: oldCursor, end: oldCursor });
      removedRun = undefined;
      oldCursor += 1;
      newCursor += 1;
    }
    nextUnmapped = Math.max(nextUnmapped, firstNew + hunk.newLines);
    delta += hunk.oldLines - hunk.newLines;
  }
  for (; nextUnmapped <= range.end; nextUnmapped += 1) {
    counterparts.set(nextUnmapped, { start: nextUnmapped + delta, end: nextUnmapped + delta });
  }
  if (counterparts.size === 0) return undefined;
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const counterpart of counterparts.values()) {
    start = Math.min(start, counterpart.start);
    end = Math.max(end, counterpart.end);
  }
  return start <= end && start >= 1 ? { start, end } : undefined;
}

/**
 * The lines an editor selection covers, 1-based and inclusive. A selection
 * that ends at the very start of a line does not include that line — dragging
 * down to the beginning of the next line selects the line above, not both.
 */
export function selectedLineRange(startLine: number, endLine: number, endCharacter: number): LineRange {
  const start = startLine + 1;
  let end = endLine + 1;
  if (endCharacter === 0 && end > start) end -= 1;
  return { start, end };
}
